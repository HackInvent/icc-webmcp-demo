import { describe, expect, it, vi } from "vitest";
import { NATIVE_INTERSTATIONS, NATIVE_INTERSTATION_BY_ID, NATIVE_LINE_COMPONENTS, NATIVE_LINES } from "./nativeNetwork";
import { nativeStationPassengerId } from "./passengerDemand";
import { getReferenceCapacity } from "./rollingStock";
import {
  advanceNativeSimulation,
  assertNativeSimulationInvariants,
  createNativeNetworkController,
  createNativeSimulationSnapshot,
  nativeAlightingPassengerCount,
  nativeShuttleDestinationOptions,
  nativeTrainOperationalLocation,
  nativeOperatorTrainInsertionOptions,
  nativeTrainInsertionOptions,
  nativeTrainInsertionStationIds,
  NativeSimulationError,
  NATIVE_DEFAULT_TIMESTAMP,
  NATIVE_SHUTTLE_CAPACITY_PASSENGERS,
  NATIVE_SHUTTLE_SPEED_KMH,
  NATIVE_SIMULATION_STEP_MS,
  NATIVE_STATION_DWELL_MS,
  type NativeSimulationSnapshot,
  type NativeTrainState,
} from "./nativeSimulation";

function orientRouteTrain(
  train: NativeTrainState,
  routeIndex: number,
  direction: 1 | -1,
): NativeTrainState {
  const edge = NATIVE_INTERSTATION_BY_ID.get(train.routeInterstationIds[routeIndex]);
  if (!edge) throw new Error("Missing test edge");
  const previousEdge = routeIndex > 0
    ? NATIVE_INTERSTATION_BY_ID.get(train.routeInterstationIds[routeIndex - 1])
    : undefined;
  const nextEdge = routeIndex + 1 < train.routeInterstationIds.length
    ? NATIVE_INTERSTATION_BY_ID.get(train.routeInterstationIds[routeIndex + 1])
    : undefined;
  let fromStationCode: string;
  let toStationCode: string;
  if (direction === 1 && nextEdge) {
    toStationCode = [edge.fromStationCode, edge.toStationCode].find(
      (code) => code === nextEdge.fromStationCode || code === nextEdge.toStationCode,
    )!;
    fromStationCode = edge.fromStationCode === toStationCode ? edge.toStationCode : edge.fromStationCode;
  } else if (direction === -1 && previousEdge) {
    toStationCode = [edge.fromStationCode, edge.toStationCode].find(
      (code) => code === previousEdge.fromStationCode || code === previousEdge.toStationCode,
    )!;
    fromStationCode = edge.fromStationCode === toStationCode ? edge.toStationCode : edge.fromStationCode;
  } else {
    fromStationCode = direction === 1 ? edge.fromStationCode : edge.toStationCode;
    toStationCode = direction === 1 ? edge.toStationCode : edge.fromStationCode;
  }
  return {
    ...train,
    routeIndex,
    direction,
    currentInterstationId: edge.id,
    fromStationCode,
    toStationCode,
    nextStationCode: toStationCode,
  };
}

describe("native all-network simulation", () => {
  it("starts at 01:00 PM Paris time", () => {
    expect(NATIVE_DEFAULT_TIMESTAMP).toBe(Date.UTC(2026, 7, 28, 11, 0, 0));
    expect(createNativeSimulationSnapshot({ scenarioId: "nominal" }).timestamp)
      .toBe(NATIVE_DEFAULT_TIMESTAMP);
  });

  it("generates no new station passengers from 01:00 AM to 05:00 AM", () => {
    const withControlledDemand = (startTimestamp: number): NativeSimulationSnapshot => {
      const initial = createNativeSimulationSnapshot({ scenarioId: "nominal", startTimestamp });
      return {
        ...initial,
        stationPassengers: initial.stationPassengers.map((state, index) => ({
          ...state,
          arrivalsPerSecond: index === 0 ? 1 : 0,
        })),
      };
    };

    const paused = advanceNativeSimulation(
      withControlledDemand(Date.UTC(2026, 7, 27, 23, 0, 0)),
    );
    expect(paused.stationPassengers.reduce(
      (sum, state) => sum + state.totalGeneratedPassengers,
      0,
    )).toBe(0);

    const resumed = advanceNativeSimulation(
      withControlledDemand(Date.UTC(2026, 7, 28, 3, 0, 0)),
    );
    expect(resumed.stationPassengers.reduce(
      (sum, state) => sum + state.totalGeneratedPassengers,
      0,
    )).toBe(1);
  });

  it("seeds two deterministic trains on every native line and the three showcase incidents", () => {
    const snapshot = createNativeSimulationSnapshot();
    expect(snapshot.trains).toHaveLength(42);
    expect(new Set(snapshot.trains.map((train) => train.lineCode))).toEqual(
      new Set(NATIVE_LINES.map((line) => line.code)),
    );
    for (const line of NATIVE_LINES) {
      expect(snapshot.trains.filter((train) => train.lineCode === line.code)).toHaveLength(2);
    }
    expect(snapshot.incidents.map((incident) => incident.id).sort()).toEqual([
      "INC-M13-WORKS",
      "INC-M14-POWER",
      "INC-RERA-SIGNAL",
    ]);
    expect(snapshot.incidents.map((incident) => incident.incidentCode).sort()).toEqual([
      "ICC-INC-INF-INT-BLK-001",
      "ICC-INC-INF-INT-BLK-001",
      "ICC-INC-WRK-INT-BLK-001",
    ]);
    expect(snapshot.restrictions.map((restriction) => restriction.interstationId).sort()).toEqual([
      "interstation-M13-71435--71474",
      "interstation-M14-71264--73626",
      "interstation-RER_A-474151--478926",
    ]);
    expect(() => assertNativeSimulationInvariants(snapshot)).not.toThrow();
  });

  it("exposes discrete station and interstation locations across arrival and departure", () => {
    let snapshot = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    expect(snapshot.trains.every((train) => train.location.type === "interstation")).toBe(true);
    const train = snapshot.trains[0];
    const approaching: NativeTrainState = {
      ...train,
      progress: 0.999,
      speedKmh: 54,
      status: "running",
      dwellTicks: 0,
      location: nativeTrainOperationalLocation({ ...train, progress: 0.999 }),
    };
    snapshot = {
      ...snapshot,
      trains: snapshot.trains.map((candidate) => candidate.id === train.id ? approaching : candidate),
    };

    const arrived = advanceNativeSimulation(snapshot);
    const atStation = arrived.trains.find((candidate) => candidate.id === train.id)!;
    expect(atStation.progress).toBe(0);
    expect(atStation.location).toEqual({ type: "station", id: atStation.fromStationCode });
    expect(atStation.dwellTicks).toBe(NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS);

    let dwelling = arrived;
    const dwellSteps = NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS;
    for (let tick = 1; tick < dwellSteps; tick += 1) {
      dwelling = advanceNativeSimulation(dwelling);
      const stoppedTrain = dwelling.trains.find((candidate) => candidate.id === train.id)!;
      expect(stoppedTrain.location).toEqual({ type: "station", id: atStation.fromStationCode });
      expect(stoppedTrain.status).toBe("dwelling");
      expect(stoppedTrain.dwellTicks).toBe(dwellSteps - tick);
      expect(dwelling.timestamp - arrived.timestamp).toBe(tick * NATIVE_SIMULATION_STEP_MS);
    }
    const departed = advanceNativeSimulation(dwelling);
    const onInterstation = departed.trains.find((candidate) => candidate.id === train.id)!;
    expect(departed.timestamp - arrived.timestamp).toBe(NATIVE_STATION_DWELL_MS);
    expect(onInterstation.progress).toBeGreaterThan(0);
    expect(onInterstation.location).toEqual({
      type: "interstation",
      id: onInterstation.currentInterstationId,
    });
    expect(() => assertNativeSimulationInvariants(departed)).not.toThrow();
  });

  it("exchanges passengers once on an intermediate arrival, caps the train and retains the queue backlog", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const train = initial.trains.find((candidate) =>
      candidate.lineCode === "M1" && candidate.routeInterstationIds.length >= 3
    )!;
    const capacity = getReferenceCapacity(train.lineCode);
    const positioned = {
      ...orientRouteTrain(train, 1, 1),
      progress: 0.999,
      speedKmh: 54,
      status: "running" as const,
      dwellTicks: 0,
      passengers: 101,
    };
    const arrivedRoute = orientRouteTrain(positioned, 2, 1);
    const stationId = arrivedRoute.fromStationCode;
    const passengerStateId = nativeStationPassengerId(train.lineCode, stationId);
    const waitingPassengers = capacity * 2;
    const snapshot: NativeSimulationSnapshot = {
      ...initial,
      trains: initial.trains.map((candidate) => candidate.id === train.id
        ? positioned
        : candidate),
      stationPassengers: initial.stationPassengers.map((state) => state.id === passengerStateId
        ? {
          ...state,
          waitingPassengers,
          arrivalsPerSecond: 0,
          arrivalRemainder: 0,
        }
        : state),
    };

    const after = advanceNativeSimulation(snapshot);
    const arrived = after.trains.find((candidate) => candidate.id === train.id)!;
    const stationState = after.stationPassengers.find((state) => state.id === passengerStateId)!;
    const alightedPassengers = nativeAlightingPassengerCount(101, false);
    const boardedPassengers = capacity - (101 - alightedPassengers);

    expect(alightedPassengers).toBe(10);
    expect(arrived).toEqual(expect.objectContaining({
      passengers: capacity,
      location: { type: "station", id: stationId },
      dwellTicks: NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS,
    }));
    expect(stationState).toEqual(expect.objectContaining({
      waitingPassengers: waitingPassengers - boardedPassengers,
      totalBoardedPassengers: boardedPassengers,
      totalAlightedPassengers: alightedPassengers,
      lastBoardedPassengers: boardedPassengers,
      lastAlightedPassengers: alightedPassengers,
      lastExchangeAt: after.timestamp,
    }));
    expect(stationState.waitingPassengers).toBeGreaterThan(0);
    expect(() => assertNativeSimulationInvariants(after)).not.toThrow();

    const afterOneDwellTick = advanceNativeSimulation(after);
    expect(afterOneDwellTick.trains.find((candidate) => candidate.id === train.id)?.passengers)
      .toBe(capacity);
    expect(afterOneDwellTick.stationPassengers.find((state) => state.id === passengerStateId))
      .toEqual(stationState);
  });

  it("alights every passenger at a terminus before boarding only to capacity", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const train = initial.trains.find((candidate) => candidate.lineCode === "M1")!;
    const capacity = getReferenceCapacity(train.lineCode);
    const lastRouteIndex = train.routeInterstationIds.length - 1;
    const positioned = {
      ...orientRouteTrain(train, lastRouteIndex, 1),
      progress: 0.999,
      speedKmh: 54,
      status: "running" as const,
      dwellTicks: 0,
      passengers: capacity,
    };
    const reversed = orientRouteTrain(positioned, lastRouteIndex, -1);
    const stationId = reversed.fromStationCode;
    const passengerStateId = nativeStationPassengerId(train.lineCode, stationId);
    const waitingPassengers = capacity + 37;
    const snapshot: NativeSimulationSnapshot = {
      ...initial,
      trains: initial.trains.map((candidate) => candidate.id === train.id
        ? positioned
        : candidate),
      stationPassengers: initial.stationPassengers.map((state) => state.id === passengerStateId
        ? {
          ...state,
          waitingPassengers,
          arrivalsPerSecond: 0,
          arrivalRemainder: 0,
        }
        : state),
    };

    const after = advanceNativeSimulation(snapshot);
    const arrived = after.trains.find((candidate) => candidate.id === train.id)!;
    const stationState = after.stationPassengers.find((state) => state.id === passengerStateId)!;

    expect(nativeAlightingPassengerCount(capacity, true)).toBe(capacity);
    expect(arrived).toEqual(expect.objectContaining({
      passengers: capacity,
      direction: -1,
      location: { type: "station", id: stationId },
    }));
    expect(stationState).toEqual(expect.objectContaining({
      waitingPassengers: 37,
      totalBoardedPassengers: capacity,
      totalAlightedPassengers: capacity,
      lastBoardedPassengers: capacity,
      lastAlightedPassengers: capacity,
      lastExchangeAt: after.timestamp,
    }));
    expect(() => assertNativeSimulationInvariants(after)).not.toThrow();
  });

  it("remains finite, deterministic and locally routed through dwell and reversal cycles", () => {
    let left = createNativeSimulationSnapshot({ scenarioId: "nominal", speed: 4 });
    let right = createNativeSimulationSnapshot({ scenarioId: "nominal", speed: 4 });
    const initialDirections = new Map(left.trains.map((train) => [train.id, train.direction]));
    let sawReversal = false;
    let sawDwell = false;
    for (let index = 0; index < 220; index += 1) {
      left = advanceNativeSimulation(left);
      right = advanceNativeSimulation(right);
      expect(left).toEqual(right);
      expect(() => assertNativeSimulationInvariants(left)).not.toThrow();
      sawReversal ||= left.trains.some((train) => train.direction !== initialDirections.get(train.id));
      sawDwell ||= left.trains.some((train) => train.status === "dwelling");
    }
    expect(sawReversal).toBe(true);
    expect(sawDwell).toBe(true);
    expect(left.telemetryRevision).toBe(220 * 4);
    expect(left.decisionRevision).toBe(0);
  }, 15_000);

  it("normalizes a persisted legacy snapshot that predates passenger queues", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const legacy = structuredClone(initial) as Partial<NativeSimulationSnapshot>;
    delete legacy.stationPassengers;

    const restored = createNativeNetworkController({
      restoredSnapshot: legacy as NativeSimulationSnapshot,
      baselineSnapshot: legacy as NativeSimulationSnapshot,
    });
    const snapshot = restored.getSnapshot();
    const expectedCount = NATIVE_LINES.reduce(
      (total, line) => total + line.stationCodes.length,
      0,
    );

    expect(snapshot.stationPassengers).toHaveLength(expectedCount);
    expect(snapshot.stationPassengers.every((state) =>
      state.waitingPassengers === 0 &&
      state.totalGeneratedPassengers === 0 &&
      state.totalBoardedPassengers === 0 &&
      state.totalAlightedPassengers === 0 &&
      state.lastExchangeAt === null
    )).toBe(true);
    expect(restored.reset().stationPassengers).toEqual(snapshot.stationPassengers);
    expect(() => assertNativeSimulationInvariants(snapshot)).not.toThrow();
  });

  it("clamps persisted train loads when rolling-stock capacity references decrease", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const trainId = "M1-T02";
    const capacity = getReferenceCapacity("M1");
    const persisted: NativeSimulationSnapshot = {
      ...structuredClone(initial),
      trains: initial.trains.map((train) => train.id === trainId
        ? { ...structuredClone(train), passengers: capacity + 137 }
        : structuredClone(train)),
    };

    const restored = createNativeNetworkController({
      restoredSnapshot: persisted,
      baselineSnapshot: persisted,
    });
    const restoredTrain = restored.getSnapshot().trains.find((train) => train.id === trainId);
    const resetTrain = restored.reset().trains.find((train) => train.id === trainId);

    expect(persisted.trains.find((train) => train.id === trainId)?.passengers)
      .toBe(capacity + 137);
    expect(restoredTrain?.passengers).toBe(capacity);
    expect(resetTrain?.passengers).toBe(capacity);
    expect(() => assertNativeSimulationInvariants(restored.getSnapshot())).not.toThrow();
  });

  it("holds an approaching train upstream of a blocked interstation", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "m13-works" });
    const targetId = "interstation-M13-71435--71474";
    const train = initial.trains.find(
      (candidate) => candidate.lineCode === "M13" && candidate.routeInterstationIds.includes(targetId),
    );
    if (!train) throw new Error("Expected an M13 route through the protected edge");
    const targetIndex = train.routeInterstationIds.indexOf(targetId);
    const direction: 1 | -1 = targetIndex > 0 ? 1 : -1;
    const upstreamIndex = targetIndex > 0 ? targetIndex - 1 : targetIndex + 1;
    const positioned = {
      ...orientRouteTrain(train, upstreamIndex, direction),
      progress: 0.984,
      status: "running" as const,
      dwellTicks: 0,
    };
    let snapshot: NativeSimulationSnapshot = {
      ...initial,
      trains: initial.trains.map((candidate) => candidate.id === train.id ? positioned : candidate),
    };
    snapshot = advanceNativeSimulation(snapshot);
    const held = snapshot.trains.find((candidate) => candidate.id === train.id)!;
    expect(held.currentInterstationId).toBe(targetId);
    expect(held.progress).toBe(0);
    expect(held.location).toEqual({ type: "station", id: held.fromStationCode });
    expect(held.status).toBe("held");
    const next = advanceNativeSimulation(snapshot).trains.find((candidate) => candidate.id === train.id)!;
    expect(next.currentInterstationId).toBe(targetId);
    expect(next.progress).toBe(0);
    expect(next.location.type).toBe("station");
    expect(next.status).toBe("held");
    expect(next.delaySeconds).toBeGreaterThan(held.delaySeconds);
  });

  it("inserts one capacity-bearing train at a grounded terminal and direction", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const initial = controller.getSnapshot();
    const stationId = nativeTrainInsertionStationIds("RER_A")[0]!;
    const receipt = controller.insertTrain({ lineCode: "RER_A", stationId });
    expect(receipt).toMatchObject({
      stationId,
      capacityDeltaPassengers: 1_600,
      decisionRevision: initial.decisionRevision + 1,
      train: {
        lineCode: "RER_A",
        originStationCode: stationId,
        location: { type: "station", id: stationId },
        status: "dwelling",
      },
    });
    expect(controller.getSnapshot().trains).toHaveLength(initial.trains.length + 1);
    expect(controller.getSnapshot().metrics.fleetSize).toBe(initial.metrics.fleetSize + 1);
    expect(() => assertNativeSimulationInvariants(controller.getSnapshot())).not.toThrow();
    expect(controller.reset().trains).toHaveLength(initial.trains.length);
  });

  it("lets the operator insert at an interior station in either route direction without widening agent proposals", () => {
    const manualOptions = nativeOperatorTrainInsertionOptions("RER_A");
    const agentOptions = nativeTrainInsertionOptions("RER_A");
    const byStation = new Map<string, typeof manualOptions[number][]>();
    manualOptions.forEach((option) => {
      byStation.set(option.stationId, [...(byStation.get(option.stationId) ?? []), option]);
    });
    const interiorEntry = [...byStation.entries()].find(([, options]) =>
      options.some((option) => option.direction === 1) &&
      options.some((option) => option.direction === -1)
    );

    expect(agentOptions).toHaveLength(2);
    expect(manualOptions.length).toBeGreaterThan(agentOptions.length);
    expect(interiorEntry).toBeDefined();
    const [stationId, directions] = interiorEntry!;
    expect(agentOptions.some((option) => option.stationId === stationId)).toBe(false);

    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const initial = controller.getSnapshot();
    const outward = directions.find((option) => option.direction === 1)!;
    const receipt = controller.insertTrain({
      lineCode: "RER_A",
      stationId,
      direction: outward.direction,
    });

    expect(receipt).toMatchObject({
      stationId,
      direction: 1,
      capacityDeltaPassengers: 1_600,
      train: {
        originStationCode: stationId,
        destinationStationCode: outward.destinationStationId,
        location: { type: "station", id: stationId },
        status: "dwelling",
      },
    });
    expect(controller.getSnapshot().trains).toHaveLength(initial.trains.length + 1);
    expect(() => assertNativeSimulationInvariants(controller.getSnapshot())).not.toThrow();
  });

  it("lets loaded trains clear a communication-restricted interstation, then holds them at station", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const initial = controller.getSnapshot();
    const target = initial.trains.find((train) => train.lineCode === "M1" && train.passengers > 0)!;
    const incident = controller.createIncident({
      lineCode: "M1",
      target: { type: "line", id: "M1" },
      effect: "communication-loss",
      title: "SCADA communication loss",
      summary: "Loaded trains already engaged may reach the next station before protection holds them.",
      type: "communications",
      severity: "critical",
    });
    const evaluation = controller.evaluateResponse({ incidentId: incident.id });
    const protect = evaluation.options.find((option) => option.action === "protect-and-hold")!;
    expect(controller.applyReviewedOption({
      evaluationId: evaluation.id,
      optionId: protect.id,
      expectedDecisionRevision: evaluation.decisionRevision,
    }).ok).toBe(true);

    const first = controller.tick().trains.find((train) => train.id === target.id)!;
    expect(first.progress === 0 || first.progress > target.progress).toBe(true);
    let current = first;
    for (let index = 0; index < 100 && current.location.type !== "station"; index += 1) {
      current = controller.tick().trains.find((train) => train.id === target.id)!;
    }
    expect(current.location.type).toBe("station");
    const stationId = current.location.id;
    const held = controller.tick().trains.find((train) => train.id === target.id)!;
    expect(held).toMatchObject({
      location: { type: "station", id: stationId },
      progress: 0,
      status: "held",
    });
  });

  it("reverses an engaged train toward the adjacent station without a physical interstation jump", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const before = controller.getSnapshot();
    const target = before.trains.find((train) =>
      train.lineCode === "M1" && train.routeIndex > 0 && train.routeIndex < train.routeInterstationIds.length - 1 && train.progress > 0
    )!;
    const blockedStationId = target.toStationCode;
    controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "station", id: blockedStationId },
      effect: "abandoned-baggage",
      title: "Abandoned baggage exclusion",
      summary: "No train may enter, traverse, or stop at the protected station.",
      type: "security",
      severity: "high",
    });

    const reversed = controller.tick().trains.find((train) => train.id === target.id)!;
    expect(reversed).toMatchObject({
      currentInterstationId: target.currentInterstationId,
      routeIndex: target.routeIndex,
      direction: target.direction === 1 ? -1 : 1,
      fromStationCode: blockedStationId,
      toStationCode: target.fromStationCode,
      status: "running",
      location: { type: "interstation", id: target.currentInterstationId },
    });
    expect(reversed.progress).toBeCloseTo(1 - target.progress, 10);
    expect(1 - reversed.progress).toBeCloseTo(target.progress, 10);
    expect(() => assertNativeSimulationInvariants(controller.getSnapshot())).not.toThrow();

    let returning = reversed;
    for (let index = 0; index < 120 && returning.location.type !== "station"; index += 1) {
      returning = controller.tick().trains.find((train) => train.id === target.id)!;
      expect(returning.location).not.toEqual({ type: "station", id: blockedStationId });
    }
    expect(returning.location).toEqual({ type: "station", id: target.fromStationCode });
  });

  it("evacuates a train already at an excluded station immediately without dwell or exchange", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const target = initial.trains.find((train) => train.lineCode === "M1")!;
    const atStation: NativeTrainState = {
      ...target,
      progress: 0,
      speedKmh: 0,
      status: "dwelling",
      dwellTicks: NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS,
      location: { type: "station", id: target.fromStationCode },
    };
    const configured: NativeSimulationSnapshot = {
      ...initial,
      trains: initial.trains.map((train) => train.id === target.id ? atStation : train),
    };
    const controller = createNativeNetworkController({
      restoredSnapshot: configured,
      baselineSnapshot: configured,
    });
    const stationPassengersBefore = controller.getSnapshot().stationPassengers.find((state) =>
      state.lineCode === target.lineCode && state.stationId === target.fromStationCode
    )!;
    controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "station", id: target.fromStationCode },
      effect: "abandoned-baggage",
      title: "Immediate platform evacuation",
      summary: "A train already present must clear the protected platform without another service call.",
      type: "security",
      severity: "critical",
    });

    const after = controller.tick();
    const evacuated = after.trains.find((train) => train.id === target.id)!;
    expect(evacuated).toMatchObject({
      currentInterstationId: target.currentInterstationId,
      direction: target.direction,
      dwellTicks: 0,
      status: "running",
      location: { type: "interstation", id: target.currentInterstationId },
    });
    expect(evacuated.progress).toBeGreaterThan(0);
    const stationPassengersAfter = after.stationPassengers.find((state) =>
      state.lineCode === target.lineCode && state.stationId === target.fromStationCode
    )!;
    expect(stationPassengersAfter.totalBoardedPassengers).toBe(stationPassengersBefore.totalBoardedPassengers);
    expect(stationPassengersAfter.totalAlightedPassengers).toBe(stationPassengersBefore.totalAlightedPassengers);
  });

  it("turns a train waiting before a works closure onto the safe adjacent service flank", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const target = initial.trains.find((train) =>
      train.lineCode === "M1" && train.routeIndex > 0 && train.routeIndex < train.routeInterstationIds.length - 1
    )!;
    const approaching: NativeTrainState = {
      ...target,
      progress: 0,
      speedKmh: 0,
      status: "held",
      dwellTicks: 0,
      location: { type: "station", id: target.fromStationCode },
    };
    const configured: NativeSimulationSnapshot = {
      ...initial,
      trains: initial.trains.map((train) => train.id === target.id ? approaching : train),
    };
    const controller = createNativeNetworkController({
      restoredSnapshot: configured,
      baselineSnapshot: configured,
    });
    const closure = controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "station", id: target.toStationCode },
      effect: "station-closure",
      title: "Station closed for engineering works",
      summary: "Turn services at the stations flanking the unavailable works scope.",
      type: "works",
      severity: "high",
    });

    expect(closure.affectedInterstationIds).toHaveLength(2);
    expect(controller.getSnapshot().restrictions.map((restriction) => restriction.interstationId).sort())
      .toEqual([...closure.affectedInterstationIds].sort());

    const turned = controller.tick().trains.find((train) => train.id === target.id)!;
    expect(turned).toMatchObject({
      routeIndex: target.routeIndex - target.direction,
      direction: target.direction === 1 ? -1 : 1,
      progress: 0,
      fromStationCode: target.fromStationCode,
      status: "dwelling",
      location: { type: "station", id: target.fromStationCode },
      dwellTicks: NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS,
    });
    expect(turned.toStationCode).not.toBe(target.toStationCode);
    expect(() => assertNativeSimulationInvariants(controller.getSnapshot())).not.toThrow();
  });

  it("keeps telemetry ticks independent from reviewed decision revisions", () => {
    const controller = createNativeNetworkController({ scenarioId: "m13-works" });
    const evaluation = controller.evaluateResponse({ incidentId: "INC-M13-WORKS" });
    const reviewedRevision = evaluation.decisionRevision;
    for (let index = 0; index < 30; index += 1) controller.tick();
    expect(controller.getSnapshot().telemetryRevision).toBe(30);
    expect(controller.getSnapshot().decisionRevision).toBe(reviewedRevision);
    const result = controller.applyReviewedOption({
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
      expectedDecisionRevision: reviewedRevision,
    });
    expect(result).toEqual(expect.objectContaining({ ok: true, status: "applied" }));
    expect(controller.getSnapshot().decisionRevision).toBe(reviewedRevision + 1);
    expect(controller.getSnapshot().restrictions[0]?.mode).toBe("reduced-speed");
  });

  it("reconstructs a reviewed evaluation from a restored decision snapshot", () => {
    const original = createNativeNetworkController({ scenarioId: "m13-works" });
    const evaluation = original.evaluateResponse({ incidentId: "INC-M13-WORKS" });
    const persistedSnapshot = structuredClone(original.getSnapshot());
    const restored = createNativeNetworkController({
      restoredSnapshot: persistedSnapshot,
      baselineSnapshot: persistedSnapshot,
    });

    for (let index = 0; index < 3; index += 1) restored.tick();
    const applied = restored.applyReviewedOption({
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
      expectedDecisionRevision: evaluation.decisionRevision,
    });

    expect(applied).toEqual(expect.objectContaining({
      ok: true,
      status: "applied",
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
    }));
    expect(restored.getSnapshot()).toEqual(expect.objectContaining({
      decisionRevision: evaluation.decisionRevision + 1,
    }));
  });

  it("blocks stale and unreviewed options without mutating controller state", () => {
    const controller = createNativeNetworkController({ scenarioId: "rer-a-signal" });
    const evaluation = controller.evaluateResponse({ incidentId: "INC-RERA-SIGNAL" });
    const beforeUnknown = controller.getSnapshot();
    const unknown = controller.applyReviewedOption({
      evaluationId: evaluation.id,
      optionId: "not-reviewed",
      expectedDecisionRevision: evaluation.decisionRevision,
    });
    expect(unknown).toEqual(expect.objectContaining({ ok: false, reason: "unknown_option" }));
    expect(controller.getSnapshot()).toBe(beforeUnknown);

    controller.setSpeed(2);
    const beforeStale = controller.getSnapshot();
    const stale = controller.applyReviewedOption({
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
      expectedDecisionRevision: evaluation.decisionRevision,
    });
    expect(stale).toEqual(expect.objectContaining({ ok: false, reason: "stale_decision" }));
    expect(controller.getSnapshot()).toBe(beforeStale);
  });

  it("creates bounded topology-backed incidents and preserves strict no-op failures", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const incident = controller.createIncident({
      lineCode: "M14",
      interstationId: "interstation-M14-71264--73626",
      title: "Platform smoke detection",
      summary: "Smoke detection requires protected inspection in the simulation.",
      type: "infrastructure",
      severity: "high",
      restrictionMode: "blocked",
    });
    expect(incident.location).toContain("Châtelet");
    expect(controller.getSnapshot().decisionRevision).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    const beforeFailure = controller.getSnapshot();
    expect(() => controller.createIncident({
      lineCode: "M13",
      interstationId: "interstation-M14-71264--73626",
      title: "Wrong line",
      summary: "This must be rejected before publication.",
      type: "works",
      severity: "medium",
    })).toThrowError(NativeSimulationError);
    expect(controller.getSnapshot()).toBe(beforeFailure);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });


  it("stops only the targeted train when an immediate rolling-stock incident is activated", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const before = controller.getSnapshot();
    const expectedWithoutIncident = advanceNativeSimulation(before);
    const target = before.trains.find((train) => train.lineCode === "M1")!;
    const comparison = before.trains.find(
      (train) => train.lineCode === target.lineCode && train.id !== target.id,
    )!;

    const incident = controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "train", id: target.id },
      effect: "stop-train",
      title: "On-board brake fault",
      summary: "The selected train must remain immobilised while the rest of the line keeps moving.",
      type: "rolling-stock",
      severity: "high",
    });
    const after = controller.tick();
    const stopped = after.trains.find((train) => train.id === target.id)!;
    const unaffected = after.trains.find((train) => train.id === comparison.id)!;

    expect(incident).toEqual(expect.objectContaining({
      status: "active",
      incidentCode: "ICC-INC-RST-TRN-IMM-001",
      target: { type: "train", id: target.id },
      effect: "stop-train",
      restrictionMode: "none",
    }));
    expect(stopped).toEqual(expect.objectContaining({
      progress: target.progress,
      speedKmh: 0,
      status: "stopped",
      delaySeconds: target.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
    }));
    expect(unaffected).toEqual(
      expectedWithoutIncident.trains.find((train) => train.id === comparison.id),
    );
    expect(after.restrictions).toHaveLength(0);
    expect(after.incidents[0].impactedTrainIds).toEqual([target.id]);
  });

  it("extends dwell only for trains present at the targeted station", () => {
    const seed = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const target = seed.trains.find((train) => train.lineCode === "M1")!;
    const stationCode = target.fromStationCode;
    const positionedTarget: NativeTrainState = {
      ...target,
      progress: 0,
      speedKmh: 0,
      status: "running",
      dwellTicks: 0,
      location: { type: "station", id: stationCode },
    };
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    controller.loadConfiguration({
      timestamp: seed.timestamp,
      speed: seed.speed,
      scenarioId: seed.scenarioId,
      scenarioName: seed.scenarioName,
      trains: seed.trains.map((train) => train.id === target.id ? positionedTarget : train),
      incidents: [],
    });
    const before = controller.getSnapshot();
    const otherTrain = before.trains.find(
      (train) => train.lineCode === target.lineCode && train.id !== target.id,
    )!;
    const expectedOther = advanceNativeSimulation(before).trains.find(
      (train) => train.id === otherTrain.id,
    );

    controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "station", id: stationCode },
      effect: "station-dwell",
      title: "Passenger assistance on platform",
      summary: "Hold trains currently berthed at this station without closing adjacent interstations.",
      type: "passenger",
      severity: "medium",
    });
    const after = controller.tick();
    const held = after.trains.find((train) => train.id === target.id)!;

    expect(held.location).toEqual({ type: "station", id: stationCode });
    expect(held.progress).toBe(0);
    expect(held.status).toBe("held");
    expect(held.delaySeconds).toBe(
      positionedTarget.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
    );
    expect(after.trains.find((train) => train.id === otherTrain.id)).toEqual(expectedOther);
    expect(after.restrictions).toHaveLength(0);
  });

  it("applies an interstation reduced-speed limit to movement", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const before = controller.getSnapshot();
    const nominalNext = advanceNativeSimulation(before);
    const target = before.trains.find((train) => {
      const next = nominalNext.trains.find((candidate) => candidate.id === train.id)!;
      return next.currentInterstationId === train.currentInterstationId && next.progress > train.progress;
    })!;
    const nominalTarget = nominalNext.trains.find((train) => train.id === target.id)!;

    controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "interstation", id: target.currentInterstationId },
      effect: "reduce-speed",
      speedLimitKmh: 12,
      title: "Temporary speed restriction",
      summary: "Run through the selected interstation at twelve kilometres per hour.",
      type: "infrastructure",
      severity: "medium",
    });
    const after = controller.tick();
    const restricted = after.trains.find((train) => train.id === target.id)!;

    expect(restricted.currentInterstationId).toBe(target.currentInterstationId);
    expect(restricted.speedKmh).toBe(12);
    expect(restricted.progress).toBeGreaterThan(target.progress);
    expect(restricted.progress).toBeLessThan(nominalTarget.progress);
    expect(after.restrictions).toEqual([
      expect.objectContaining({
        interstationId: target.currentInterstationId,
        mode: "reduced-speed",
        speedLimitKmh: 12,
      }),
    ]);
  });

  it("supports line communications, abandoned baggage, and towing with dedicated codes", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const initial = controller.getSnapshot();
    const targetTrain = initial.trains.find((train) => train.lineCode === "RER_A")!;
    const stationId = targetTrain.fromStationCode;
    const communication = controller.createIncident({
      lineCode: "M1",
      target: { type: "line", id: "M1" },
      effect: "communication-loss",
      title: "SCADA communication loss",
      summary: "No fresh supervisory heartbeat is available for the line.",
      type: "communications",
      severity: "critical",
    });
    const baggage = controller.createIncident({
      lineCode: "RER_A",
      target: { type: "station", id: stationId },
      effect: "abandoned-baggage",
      title: "Abandoned baggage",
      summary: "The protected station scope requires an explicit police clearance.",
      type: "security",
      severity: "high",
    });
    const towing = controller.createIncident({
      lineCode: "RER_A",
      target: { type: "train", id: targetTrain.id },
      effect: "tow-train",
      title: "Towing required",
      summary: "The immobilised train requires a grounded rescue path and receiving terminal.",
      type: "rolling-stock",
      severity: "critical",
    });

    expect(communication).toMatchObject({
      incidentCode: "ICC-INC-COM-LIN-LOS-001",
      target: { type: "line", id: "M1" },
      restrictionMode: "none",
    });
    expect(baggage).toMatchObject({
      incidentCode: "ICC-INC-SEC-STA-BAG-001",
      effect: "abandoned-baggage",
      restrictionMode: "blocked",
    });
    expect(towing).toMatchObject({
      incidentCode: "ICC-INC-RST-TRN-TOW-001",
      effect: "tow-train",
    });
    const after = controller.tick();
    expect(after.trains.find((train) => train.id === targetTrain.id)?.status).toBe("stopped");
    expect(after.incidents.find((item) => item.id === communication.id)?.impactedTrainIds)
      .toEqual(initial.trains.filter((train) => train.lineCode === "M1").map((train) => train.id).sort());
    expect(() => assertNativeSimulationInvariants(after)).not.toThrow();
  });

  it("keeps a future incident inert until its due tick and increments the decision revision once", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const baseline = createNativeNetworkController({ scenarioId: "nominal" });
    const start = controller.getSnapshot();
    const target = start.trains.find((train) => train.lineCode === "M2")!;
    const occurrenceTime = start.timestamp + NATIVE_SIMULATION_STEP_MS * 2 + 1;
    const incident = controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "train", id: target.id },
      effect: "stop-train",
      occurrenceTime,
      title: "Scheduled rolling-stock exercise",
      summary: "Activate just after the second telemetry step to test deterministic scheduling.",
      type: "rolling-stock",
      severity: "high",
    });
    const createdRevision = controller.getSnapshot().decisionRevision;

    expect(incident.status).toBe("planned");
    expect(incident.activatedAt).toBeNull();
    expect(controller.getSnapshot().restrictions).toHaveLength(0);
    for (let tick = 0; tick < 2; tick += 1) {
      const actual = controller.tick();
      const expected = baseline.tick();
      expect(actual.incidents[0]).toEqual(expect.objectContaining({
        status: "planned",
        startedAt: occurrenceTime,
        activatedAt: null,
      }));
      expect(actual.trains.find((train) => train.id === target.id)).toEqual(
        expected.trains.find((train) => train.id === target.id),
      );
      expect(actual.decisionRevision).toBe(createdRevision);
    }

    const beforeActivation = controller.getSnapshot().trains.find((train) => train.id === target.id)!;
    const activated = controller.tick();
    const activeIncident = activated.incidents.find((candidate) => candidate.id === incident.id)!;
    const stopped = activated.trains.find((train) => train.id === target.id)!;
    expect(activeIncident.status).toBe("active");
    expect(activeIncident.activatedAt).toBe(start.timestamp + NATIVE_SIMULATION_STEP_MS * 3);
    expect(stopped.progress).toBe(beforeActivation.progress);
    expect(stopped.status).toBe("stopped");
    expect(activated.decisionRevision).toBe(createdRevision + 1);

    const oneTickLater = controller.tick();
    expect(oneTickLater.decisionRevision).toBe(createdRevision + 1);
    expect(oneTickLater.incidents.find((candidate) => candidate.id === incident.id)?.status).toBe("active");
  });

  it("does not activate due incidents while the simulation is paused", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const before = controller.getSnapshot();
    const target = before.trains[0];
    const incident = controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "train", id: target.id },
      effect: "stop-train",
      occurrenceTime: before.timestamp + NATIVE_SIMULATION_STEP_MS,
      title: "Paused exercise",
      summary: "The simulation clock must not trigger this incident while paused.",
      type: "rolling-stock",
      severity: "medium",
    });
    const paused = controller.setSpeed(0);
    const afterTick = controller.tick();

    expect(afterTick).toBe(paused);
    expect(afterTick.timestamp).toBe(before.timestamp);
    expect(afterTick.incidents.find((candidate) => candidate.id === incident.id)).toEqual(
      expect.objectContaining({ status: "planned", activatedAt: null }),
    );
    expect(afterTick.trains.find((train) => train.id === target.id)?.status).not.toBe("stopped");
  });

  it("runs a manually ordered shuttle as a discrete 15 km/h, 100-passenger round trip", () => {
    const edge = NATIVE_INTERSTATIONS.find((interstation) => interstation.lineCode === "M1")!;
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const passengerStateId = nativeStationPassengerId("M1", edge.fromStationCode);
    const configured: NativeSimulationSnapshot = {
      ...initial,
      stationPassengers: initial.stationPassengers.map((state) => state.id === passengerStateId
        ? { ...state, waitingPassengers: 150, totalGeneratedPassengers: 150 }
        : state),
    };
    const controller = createNativeNetworkController({
      restoredSnapshot: configured,
      baselineSnapshot: configured,
    });

    const receipt = controller.insertShuttle({
      lineCode: "M1",
      departureStationId: edge.fromStationCode,
      arrivalStationId: edge.toStationCode,
    });
    expect(receipt.capacityDeltaPassengers).toBe(NATIVE_SHUTTLE_CAPACITY_PASSENGERS);
    expect(receipt.shuttle).toMatchObject({
      nominalSpeedKmh: NATIVE_SHUTTLE_SPEED_KMH,
      capacityPassengers: NATIVE_SHUTTLE_CAPACITY_PASSENGERS,
      passengers: 100,
      status: "dwelling",
      dwellTicks: NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS,
      location: { type: "station", id: edge.fromStationCode },
    });
    expect(controller.getSnapshot().stationPassengers.find((state) => state.id === passengerStateId)?.waitingPassengers).toBe(50);

    const dwellTicks = NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS;
    for (let tick = 1; tick < dwellTicks; tick += 1) {
      const snapshot = controller.tick();
      const shuttle = snapshot.shuttles[0];
      expect(shuttle.location).toEqual({ type: "station", id: edge.fromStationCode });
      expect(shuttle.dwellTicks).toBe(dwellTicks - tick);
    }
    const departed = controller.tick().shuttles[0];
    expect(departed).toMatchObject({
      status: "running",
      speedKmh: NATIVE_SHUTTLE_SPEED_KMH,
      location: { type: "interstation", id: edge.id },
    });
    expect(departed.travelTicksRemaining).toBe(departed.routeTravelTicks[0]);

    const travelTicks = departed.travelTicksRemaining;
    let arrived = departed;
    for (let tick = 0; tick < travelTicks; tick += 1) {
      const before = controller.getSnapshot();
      const after = controller.tick();
      expect(after.timestamp - before.timestamp).toBe(NATIVE_SIMULATION_STEP_MS);
      arrived = after.shuttles[0];
    }
    expect(arrived).toMatchObject({
      direction: -1,
      status: "dwelling",
      speedKmh: 0,
      location: { type: "station", id: edge.toStationCode },
    });
    expect(arrived.passengers).toBeLessThanOrEqual(NATIVE_SHUTTLE_CAPACITY_PASSENGERS);

    for (let tick = 0; tick < dwellTicks; tick += 1) controller.tick();
    const returning = controller.getSnapshot().shuttles[0];
    expect(returning).toMatchObject({
      direction: -1,
      status: "running",
      speedKmh: NATIVE_SHUTTLE_SPEED_KMH,
      location: { type: "interstation", id: edge.id },
    });
    expect(() => assertNativeSimulationInvariants(controller.getSnapshot())).not.toThrow();
  });

  it("rejects shuttle endpoints that are identical or not on the selected line", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const m1 = NATIVE_INTERSTATIONS.find((edge) => edge.lineCode === "M1")!;
    const m2Station = NATIVE_LINES.find((line) => line.code === "M2")!.stationCodes.find((stationId) =>
      !NATIVE_LINES.find((line) => line.code === "M1")!.stationCodes.includes(stationId)
    )!;
    expect(() => controller.insertShuttle({
      lineCode: "M1",
      departureStationId: m1.fromStationCode,
      arrivalStationId: m1.fromStationCode,
    })).toThrowError(NativeSimulationError);
    expect(() => controller.insertShuttle({
      lineCode: "M1",
      departureStationId: m1.fromStationCode,
      arrivalStationId: m2Station,
    })).toThrow(/not served by M1/);
  });

  it("offers and routes contracted RER branch endpoints through a virtual road leg", () => {
    const line = NATIVE_LINES.find((candidate) => candidate.code === "RER_A")!;
    const components = NATIVE_LINE_COMPONENTS.get("RER_A")!;
    const mainComponent = components.find((component) => component.interstationIds.length > 0)!;
    const contractedBranch = components.find((component) => component.interstationIds.length === 0)!;
    const departureStationId = mainComponent.stationCodes[0];
    const arrivalStationId = contractedBranch.stationCodes[0];

    expect(nativeShuttleDestinationOptions("RER_A", departureStationId)).toHaveLength(
      line.stationCodes.length - 1,
    );
    expect(nativeShuttleDestinationOptions("RER_A", departureStationId)).toContainEqual(
      expect.objectContaining({ stationId: arrivalStationId }),
    );

    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const receipt = controller.insertShuttle({
      lineCode: "RER_A",
      departureStationId,
      arrivalStationId,
    });
    expect(receipt.shuttle.routeInterstationIds.some((id) => id.startsWith("shuttle-road-RER_A-"))).toBe(true);
    expect(receipt.shuttle.routeStationIds.at(-1)).toBe(arrivalStationId);
    expect(() => assertNativeSimulationInvariants(controller.getSnapshot())).not.toThrow();
  });

  it("advances at x2 and x4 exactly like sequential x1 ticks, including due incidents", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const initial = controller.getSnapshot();
    const target = initial.trains.find((train) => train.lineCode === "M3")!;
    controller.createIncident({
      lineCode: target.lineCode,
      target: { type: "train", id: target.id },
      effect: "stop-train",
      occurrenceTime: initial.timestamp + NATIVE_SIMULATION_STEP_MS * 2,
      title: "Accelerated clock exercise",
      summary: "The incident must activate identically at normal and accelerated simulation speeds.",
      type: "rolling-stock",
      severity: "high",
    });
    const scheduled = controller.getSnapshot();
    for (const speed of [2, 4] as const) {
      const fast = advanceNativeSimulation({ ...scheduled, speed });
      let sequential: NativeSimulationSnapshot = { ...scheduled, speed: 1 };
      for (let index = 0; index < speed; index += 1) {
        sequential = advanceNativeSimulation(sequential);
      }

      expect({ ...fast, speed: 1 }).toEqual(sequential);
      expect(fast.timestamp).toBe(initial.timestamp + NATIVE_SIMULATION_STEP_MS * speed);
      expect(fast.telemetryRevision).toBe(speed);
      expect(fast.decisionRevision).toBe(scheduled.decisionRevision + 1);
    }
  });

  it("pauses exactly, resets deterministically and invalidates prior reviews", () => {
    const controller = createNativeNetworkController({ scenarioId: "m14-power" });
    const evaluation = controller.evaluateResponse({ incidentId: "INC-M14-POWER" });
    const paused = controller.setSpeed(0);
    expect(controller.tick()).toBe(paused);
    expect(controller.getSnapshot().telemetryRevision).toBe(0);
    const reset = controller.reset();
    expect(reset.speed).toBe(1);
    expect(reset.scenarioId).toBe("m14-power");
    expect(reset.decisionRevision).toBe(2);
    expect(reset.timestamp).toBe(paused.timestamp);
    expect(controller.applyReviewedOption({
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
      expectedDecisionRevision: evaluation.decisionRevision,
    })).toEqual(expect.objectContaining({ ok: false, reason: "unknown_evaluation" }));
    expect(reset.timestamp - createNativeSimulationSnapshot({ scenarioId: "m14-power" }).timestamp).toBe(0);
    expect(NATIVE_SIMULATION_STEP_MS).toBe(1_000);
  });
});
