import { describe, expect, it } from "vitest";
import {
  MAX_CIRCUIT_CLOSURE_NOTE_LENGTH,
  MAX_CIRCUIT_CLOSURE_REFERENCE_LENGTH,
  advanceSnapshot,
  advanceSimulation,
  addDemoIncident,
  STEP_MS,
  STATION_DWELL_MS,
  applyRegulation,
  assertSnapshotInvariants,
  closeCircuit,
  createSimulationState,
  reopenCircuit,
  resetSimulation,
  schedulePowerIncident,
  setPowerStatus,
  setSimulationSpeed,
  updateIncidentStatus,

} from "./simulation";
type TestSimulationState = ReturnType<typeof createSimulationState>;

function powerIncidentDraft(
  occurrenceTime: number,
  overrides: Partial<import("./simulatorIncident").SimulatorIncidentDraft> = {},
): import("./simulatorIncident").SimulatorIncidentDraft {
  return {
    targetType: "power",
    targetId: "PWR-M14-NORD",
    lineCode: "M14",
    type: "power",
    severity: "high",
    effect: "isolate-power",
    occurrenceTime,
    title: "Traction power alarm",
    summary: "Power control requested a deterministic simulation impact.",
    ...overrides,
  };
}

function positionMi79101AtRerBNorthTurnback(state: TestSimulationState): TestSimulationState {
  const train = state.snapshot.trains.find((candidate) => candidate.id === "MI79-101");
  if (!train) throw new Error("Expected MI79-101");
  const positionedTrain = {
    ...train,
    routeIndex: 4,
    circuitId: "RB-05-A",
    progress: 0.95,
    status: "running" as const,
    nextStop: "Gare du Nord",
  };

  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      trains: state.snapshot.trains.map((candidate) =>
        candidate.id === train.id ? positionedTrain : candidate,
      ),
      circuits: state.snapshot.circuits.map((circuit) => {
        if (circuit.id === train.circuitId) {
          return {
            ...circuit,
            state: "free" as const,
            occupiedBy: null,
            circulationId: null,
            reservedBy: null,
          };
        }
        if (circuit.id === positionedTrain.circuitId) {
          return {
            ...circuit,
            state: "occupied" as const,
            occupiedBy: positionedTrain.id,
            circulationId: positionedTrain.circulationId,
            reservedBy: null,
          };
        }
        return circuit;
      }),
    },
  };
}

describe("rail simulation", () => {
  it("assigns deterministic procedure codifications to all detailed scenario seeds", () => {
    const incidents = createSimulationState().snapshot.incidents;
    expect(Object.fromEntries(incidents.map((incident) => [incident.id, incident.incidentCode])))
      .toEqual({
        "INC-2407": "ICC-INC-PAX-STA-CLS-001",
        "INC-2410": "ICC-INC-PWR-PWR-DEG-001",
        "INC-J1-32": "ICC-INC-WRK-INT-BLK-001",
      });
  });

  it("keeps decision revisions stable across telemetry ticks and monotonic across decisions", () => {
    const initial = createSimulationState();
    const ticked = advanceSimulation(initial);

    expect(ticked.snapshot.revision).toBe(initial.snapshot.revision + 1);
    expect(ticked.snapshot.decisionRevision).toBe(initial.snapshot.decisionRevision);

    const speedChanged = setSimulationSpeed(ticked, 2);
    expect(speedChanged.snapshot.revision).toBe(ticked.snapshot.revision);
    expect(speedChanged.snapshot.decisionRevision).toBe(
      ticked.snapshot.decisionRevision + 1,
    );

    const regulated = applyRegulation(speedChanged, "MI79-205", "hold");
    expect(regulated.snapshot.decisionRevision).toBe(
      speedChanged.snapshot.decisionRevision + 1,
    );

    const reset = resetSimulation(regulated);
    expect(reset.snapshot.revision).toBe(1);
    expect(reset.snapshot.decisionRevision).toBe(
      regulated.snapshot.decisionRevision + 1,
    );
  });

  it("keeps track-circuit occupation unique while trains move", () => {
    let snapshot = createSimulationState().snapshot;
    for (let tick = 0; tick < 120; tick += 1) {
      snapshot = advanceSnapshot(snapshot);
      expect(() => assertSnapshotInvariants(snapshot)).not.toThrow();
    }
  });
  it("keeps every initial and simulated speed within the current CDV limit", () => {
    let snapshot = createSimulationState().snapshot;
    for (let tick = 0; tick < 180; tick += 1) {
      for (const train of snapshot.trains) {
        const circuit = snapshot.circuits.find((candidate) => candidate.id === train.circuitId);
        expect(circuit).toBeDefined();
        expect(train.speedKmh).toBeLessThanOrEqual(circuit?.speedLimitKmh ?? 0);
        if (train.status === "dwelling") expect(train.speedKmh).toBe(0);
      }
      snapshot = advanceSnapshot(snapshot);
    }
  });

  it("derives progress from physical distance and carries overshoot into the next CDV", () => {
    const initial = createSimulationState().snapshot;
    const currentCircuit = initial.circuits.find((circuit) => circuit.id === "RB-01-A");
    const nextCircuit = initial.circuits.find((circuit) => circuit.id === "RB-02-A");
    if (!currentCircuit || !nextCircuit) throw new Error("Expected RER B test circuits");

    const targetSpeedKmh = Math.min(74, currentCircuit.speedLimitKmh);
    const stepDistanceMeters = (targetSpeedKmh / 3.6) * (STEP_MS / 1_000);
    const positioned = {
      ...initial,
      trains: initial.trains.map((train) =>
        train.id === "MI79-101" ? { ...train, progress: 0.1 } : train,
      ),
    };
    const advanced = advanceSnapshot(positioned);
    const advancedTrain = advanced.trains.find((train) => train.id === "MI79-101");
    expect(advancedTrain?.circuitId).toBe("RB-01-A");
    expect(advancedTrain?.progress).toBeCloseTo(
      0.1 + stepDistanceMeters / currentCircuit.lengthMeters,
      8,
    );

    const nearBoundaryProgress = 1 - stepDistanceMeters / (2 * currentCircuit.lengthMeters);
    const nearBoundary = {
      ...initial,
      trains: initial.trains.map((train) =>
        train.id === "MI79-101" ? { ...train, progress: nearBoundaryProgress } : train,
      ),
    };
    const crossed = advanceSnapshot(nearBoundary);
    const crossedTrain = crossed.trains.find((train) => train.id === "MI79-101");
    const remainingMeters = (1 - nearBoundaryProgress) * currentCircuit.lengthMeters;
    const expectedOvershoot = (stepDistanceMeters - remainingMeters) / nextCircuit.lengthMeters;
    expect(crossedTrain).toEqual(
      expect.objectContaining({
        circuitId: "RB-02-A",
        progress: expect.closeTo(expectedOvershoot, 8),
        speedKmh: 0,
        status: "dwelling",
        holdTicks: STATION_DWELL_MS / STEP_MS,
      }),
    );

    let dwelling = crossed;
    const dwellTicks = STATION_DWELL_MS / STEP_MS;
    for (let tick = 1; tick < dwellTicks; tick += 1) {
      dwelling = advanceSnapshot(dwelling);
      expect(dwelling.trains.find((train) => train.id === "MI79-101")).toEqual(
        expect.objectContaining({
          circuitId: "RB-02-A",
          status: "dwelling",
          holdTicks: dwellTicks - tick,
        }),
      );
    }
    const departed = advanceSnapshot(dwelling);
    expect(departed.timestamp - crossed.timestamp).toBe(STATION_DWELL_MS);
    expect(departed.trains.find((train) => train.id === "MI79-101")).toEqual(
      expect.objectContaining({
        circuitId: "RB-02-A",
        status: "running",
        holdTicks: 0,
      }),
    );
  });

  it("keeps progress monotone per CDV and every rendered transition locally contiguous", () => {
    let snapshot = createSimulationState().snapshot;

    for (let tick = 0; tick < 360; tick += 1) {
      const next = advanceSnapshot(snapshot);

      for (const movedTrain of next.trains) {
        const previousTrain = snapshot.trains.find((train) => train.id === movedTrain.id);
        const previousCircuit = snapshot.circuits.find(
          (circuit) => circuit.id === previousTrain?.circuitId,
        );
        const movedCircuit = next.circuits.find(
          (circuit) => circuit.id === movedTrain.circuitId,
        );
        if (!previousTrain || !previousCircuit || !movedCircuit) {
          throw new Error(`Missing movement state for ${movedTrain.id}`);
        }

        if (previousTrain.circuitId === movedTrain.circuitId) {
          expect(movedTrain.progress).toBeGreaterThanOrEqual(previousTrain.progress);
          continue;
        }

        expect(movedCircuit.fromStation).toBe(previousCircuit.toStation);
        const distanceToBoundary =
          (1 - previousTrain.progress) * previousCircuit.lengthMeters;
        const distanceIntoNext = movedTrain.progress * movedCircuit.lengthMeters;
        const lineBaseSpeedKmh = previousTrain.lineId.startsWith("RER") ? 74 : 52;
        const powerSection = snapshot.powerSections.find(
          (section) => section.id === previousCircuit.electricalSectionId,
        );
        const powerAdjustedSpeedKmh =
          powerSection?.status === "degraded"
            ? lineBaseSpeedKmh * 0.72
            : lineBaseSpeedKmh;
        const expectedStepDistance =
          (Math.min(previousCircuit.speedLimitKmh, powerAdjustedSpeedKmh) / 3.6) *
          (STEP_MS / 1_000);
        expect(distanceToBoundary + distanceIntoNext).toBeCloseTo(
          expectedStepDistance,
          7,
        );

        const previousX =
          previousCircuit.x1 +
          (previousCircuit.x2 - previousCircuit.x1) * previousTrain.progress;
        const movedX =
          movedCircuit.x1 + (movedCircuit.x2 - movedCircuit.x1) * movedTrain.progress;
        expect(Math.abs(movedX - previousX)).toBeLessThan(70);
        expect(Math.abs(movedCircuit.y - previousCircuit.y)).toBeLessThanOrEqual(18);
      }

      expect(() => assertSnapshotInvariants(next)).not.toThrow();
      snapshot = next;
    }
  });

  it("keeps all 12 mission identities and real branch termini stable across visual turnarounds", () => {
    let snapshot = createSimulationState().snapshot;
    const operationalMetadata = new Map(
      snapshot.trains.map((train) => [
        train.id,
        {
          circulationId: train.circulationId,
          mission: train.mission,
          origin: train.origin,
          destination: train.destination,
        },
      ]),
    );
    let sawModelledTurnaround = false;

    for (let tick = 0; tick < 300; tick += 1) {
      const routeStateBefore = new Map(
        snapshot.trains.map((train) => [
          train.id,
          { routeIndex: train.routeIndex, direction: train.direction },
        ]),
      );
      const next = advanceSnapshot(snapshot);
      sawModelledTurnaround ||= next.trains.some((train) => {
        const before = routeStateBefore.get(train.id);
        return (
          before?.routeIndex === 4 &&
          train.routeIndex === 0 &&
          train.direction !== before.direction
        );
      });
      snapshot = next;
    }

    expect(sawModelledTurnaround).toBe(true);
    for (const train of snapshot.trains) {
      expect({
        circulationId: train.circulationId,
        mission: train.mission,
        origin: train.origin,
        destination: train.destination,
      }).toEqual(operationalMetadata.get(train.id));
    }
  });

  it("advances one second at x1, makes x2/x4 exact sequential batches, and preserves pause/resume", () => {
    const initial = createSimulationState();
    expect(STEP_MS).toBe(1_000);
    expect(advanceSimulation(initial).snapshot.timestamp - initial.snapshot.timestamp).toBe(1_000);

    for (const speed of [2, 4] as const) {
      const accelerated = setSimulationSpeed(initial, speed);
      const batched = advanceSimulation(accelerated);
      let sequentialSnapshot = accelerated.snapshot;
      for (let step = 0; step < speed; step += 1) {
        sequentialSnapshot = advanceSnapshot(sequentialSnapshot);
      }
      expect(batched.snapshot).toEqual(sequentialSnapshot);
      expect(batched.snapshot.timestamp - accelerated.snapshot.timestamp).toBe(speed * STEP_MS);
    }

    const paused = setSimulationSpeed(initial, 0);
    expect(advanceSimulation(paused)).toBe(paused);
    const resumed = setSimulationSpeed(paused, 1);
    const resumedTick = advanceSimulation(resumed);
    expect(resumedTick.snapshot).toEqual(advanceSnapshot(resumed.snapshot));
  });

  it("bounds displacement between visible snapshots at every acceleration setting", () => {
    for (const speed of [1, 2, 4] as const) {
      let state = setSimulationSpeed(createSimulationState(), speed);

      for (let renderedTick = 0; renderedTick < 120; renderedTick += 1) {
        const next = advanceSimulation(state);
        for (const movedTrain of next.snapshot.trains) {
          const previousTrain = state.snapshot.trains.find(
            (train) => train.id === movedTrain.id,
          );
          const previousCircuit = state.snapshot.circuits.find(
            (circuit) => circuit.id === previousTrain?.circuitId,
          );
          const movedCircuit = next.snapshot.circuits.find(
            (circuit) => circuit.id === movedTrain.circuitId,
          );
          if (!previousTrain || !previousCircuit || !movedCircuit) {
            throw new Error(`Missing rendered position for ${movedTrain.id}`);
          }

          const previousX =
            previousCircuit.x1 +
            (previousCircuit.x2 - previousCircuit.x1) * previousTrain.progress;
          const movedX =
            movedCircuit.x1 + (movedCircuit.x2 - movedCircuit.x1) * movedTrain.progress;
          expect(Math.abs(movedX - previousX)).toBeLessThan(230);
          expect(Math.abs(movedCircuit.y - previousCircuit.y)).toBeLessThanOrEqual(18);
        }
        state = next;
      }
    }
  });

  it("keeps acknowledged incident restrictions until the incident is resolved", () => {
    const initial = createSimulationState();
    expect(initial.snapshot.circuits.find((circuit) => circuit.id === "M13-05-A")?.state).toBe("blocked");

    const acknowledged = updateIncidentStatus(initial, "INC-2407", "acknowledged");
    expect(acknowledged.snapshot.circuits.find((circuit) => circuit.id === "M13-05-A")?.state).toBe("blocked");

    const resolved = updateIncidentStatus(acknowledged, "INC-2407", "resolved");
    expect(resolved.snapshot.circuits.find((circuit) => circuit.id === "M13-05-A")?.state).toBe("free");
  });

  it("creates distinct incidents from the submitted bounded form values", () => {
    const first = addDemoIncident(createSimulationState(), {
      type: "passenger",
      severity: "high",
      lineId: "M14",
      location: "  Gare de Lyon — platform 1  ",
      summary: "Passenger assistance requested.",
    });
    const second = addDemoIncident(first, {
      type: "power",
      severity: "critical",
      lineId: "RER_B",
      location: "Châtelet — northbound",
      summary: "Voltage alarm under assessment.",
    });

    expect(second.snapshot.incidents.slice(0, 2)).toEqual([
      expect.objectContaining({
        id: "INC-OPS-02",
        incidentCode: "ICC-INC-PWR-PWR-DEG-001",
        type: "power",
        severity: "critical",
        lineIds: ["RER_B"],
      }),
      expect.objectContaining({
        id: "INC-OPS-01",
        incidentCode: "ICC-INC-PAX-STA-CLS-001",
        type: "passenger",
        severity: "high",
        lineIds: ["M14"],
        location: "Gare de Lyon — platform 1",
      }),
    ]);
  });

  it("isolates electrical circuits and records simulation commands", () => {
    const initial = createSimulationState();
    const isolated = setPowerStatus(initial, "PWR-M14-NORD", "isolated");
    expect(isolated.snapshot.powerSections.find((section) => section.id === "PWR-M14-NORD")?.voltage).toBe(0);
    expect(isolated.snapshot.events[0]?.title).toContain("Simulated isolation");
  });

  it("applies an immediate degraded-power incident to train speed", () => {
    const initial = createSimulationState();
    const scheduled = schedulePowerIncident(
      initial,
      powerIncidentDraft(initial.snapshot.timestamp, {
        effect: "degrade-power",
        severity: "medium",
        title: "Low traction voltage",
      }),
    );

    expect(scheduled.snapshot.incidents[0]).toEqual(
      expect.objectContaining({
        id: "INC-SIM-PWR-001",
        incidentCode: "ICC-INC-PWR-PWR-DEG-001",
        status: "active",
        target: { type: "power", id: "PWR-M14-NORD" },
        effect: "degrade-power",
        activatedAt: initial.snapshot.timestamp,
        blockedCircuitIds: [],
        impactedTrainIds: expect.arrayContaining(["MP14-041"]),
      }),
    );
    expect(
      scheduled.snapshot.powerSections.find(
        (section) => section.id === "PWR-M14-NORD",
      ),
    ).toEqual(
      expect.objectContaining({
        status: "degraded",
        voltage: Math.round(750 * 0.89),
      }),
    );

    const advanced = advanceSnapshot(scheduled.snapshot);
    expect(advanced.trains.find((train) => train.id === "MP14-041")).toEqual(
      expect.objectContaining({
        status: "running",
        speedKmh: Math.round(52 * 0.72),
      }),
    );
    expect(advanced.decisionRevision).toBe(scheduled.snapshot.decisionRevision);
  });

  it("keeps a future isolation inert, then activates it before movement at occurrence time", () => {
    const initial = createSimulationState();
    const occurrenceTime = initial.snapshot.timestamp + STEP_MS * 2;
    const scheduled = schedulePowerIncident(
      initial,
      powerIncidentDraft(occurrenceTime),
    );
    const scheduledDecisionRevision = scheduled.snapshot.decisionRevision;

    expect(scheduled.snapshot.incidents[0]).toEqual(
      expect.objectContaining({
        incidentCode: "ICC-INC-PWR-PWR-ISO-001",
        status: "planned",
        startedAt: occurrenceTime,
        target: { type: "power", id: "PWR-M14-NORD" },
      }),
    );
    expect(
      scheduled.snapshot.powerSections.find(
        (section) => section.id === "PWR-M14-NORD",
      )?.status,
    ).toBe("energized");

    const beforeOccurrence = advanceSnapshot(scheduled.snapshot);
    expect(beforeOccurrence.incidents[0]?.status).toBe("planned");
    expect(beforeOccurrence.decisionRevision).toBe(scheduledDecisionRevision);
    expect(
      beforeOccurrence.powerSections.find(
        (section) => section.id === "PWR-M14-NORD",
      )?.status,
    ).toBe("energized");

    const activated = advanceSnapshot(beforeOccurrence);
    expect(activated.timestamp).toBe(occurrenceTime);
    expect(activated.incidents[0]).toEqual(
      expect.objectContaining({
        status: "active",
        activatedAt: occurrenceTime,
        impactedTrainIds: expect.arrayContaining(["MP14-041"]),
      }),
    );
    expect(activated.decisionRevision).toBe(scheduledDecisionRevision + 1);
    expect(
      activated.powerSections.find(
        (section) => section.id === "PWR-M14-NORD",
      ),
    ).toEqual(expect.objectContaining({ status: "isolated", voltage: 0, currentAmps: 0 }));
    expect(activated.trains.find((train) => train.id === "MP14-041")).toEqual(
      expect.objectContaining({
        status: "stopped",
        speedKmh: 0,
      }),
    );
    expect(activated.events[0]).toEqual(
      expect.objectContaining({
        title: "INC-SIM-PWR-001 activated",
        timestamp: occurrenceTime,
      }),
    );
  });

  it("does not advance or activate a scheduled power incident while paused", () => {
    const initial = createSimulationState();
    const occurrenceTime = initial.snapshot.timestamp + STEP_MS;
    const scheduled = schedulePowerIncident(
      initial,
      powerIncidentDraft(occurrenceTime),
    );
    const paused = setSimulationSpeed(scheduled, 0);
    const stillPaused = advanceSimulation(paused);

    expect(stillPaused).toBe(paused);
    expect(stillPaused.snapshot.timestamp).toBe(initial.snapshot.timestamp);
    expect(stillPaused.snapshot.incidents[0]?.status).toBe("planned");
    expect(
      stillPaused.snapshot.powerSections.find(
        (section) => section.id === "PWR-M14-NORD",
      )?.status,
    ).toBe("energized");

    const resumed = setSimulationSpeed(stillPaused, 1);
    const activated = advanceSimulation(resumed);
    expect(activated.snapshot.timestamp).toBe(occurrenceTime);
    expect(activated.snapshot.incidents[0]?.status).toBe("active");
    expect(
      activated.snapshot.powerSections.find(
        (section) => section.id === "PWR-M14-NORD",
      )?.status,
    ).toBe("isolated");
  });

  it("activates a same-timestamp power incident batch with one decision revision", () => {
    const initial = createSimulationState();
    const occurrenceTime = initial.snapshot.timestamp + STEP_MS;
    const first = schedulePowerIncident(
      initial,
      powerIncidentDraft(occurrenceTime, {
        targetId: "PWR-RA-OUEST",
        lineCode: "RER_A",
        effect: "degrade-power",
        title: "RER A low voltage",
      }),
    );
    const second = schedulePowerIncident(
      first,
      powerIncidentDraft(occurrenceTime, {
        targetId: "PWR-M14-NORD",
        lineCode: "M14",
        effect: "isolate-power",
        title: "M14 power isolation",
      }),
    );
    const beforeActivationRevision = second.snapshot.decisionRevision;
    const activated = advanceSnapshot(second.snapshot);
    const created = activated.incidents.filter((incident) =>
      incident.id.startsWith("INC-SIM-PWR-"),
    );

    expect(created).toHaveLength(2);
    expect(created.every((incident) => incident.status === "active")).toBe(true);
    expect(activated.decisionRevision).toBe(beforeActivationRevision + 1);
    expect(
      activated.powerSections.find((section) => section.id === "PWR-RA-OUEST")
        ?.status,
    ).toBe("degraded");
    expect(
      activated.powerSections.find((section) => section.id === "PWR-M14-NORD")
        ?.status,
    ).toBe("isolated");
    const activationEvents = activated.events.filter((candidate) =>
      candidate.title.endsWith(" activated"),
    );
    expect(new Set(activationEvents.map((candidate) => candidate.id)).size).toBe(2);
  });

  it("rejects invalid power-incident targets, effects, and timestamps", () => {
    const initial = createSimulationState();

    expect(() =>
      schedulePowerIncident(
        initial,
        powerIncidentDraft(initial.snapshot.timestamp, {
          targetType: "train",
          targetId: "MP14-041",
          effect: "stop-train",
        }),
      ),
    ).toThrow("only accepts power-section incidents");
    expect(() =>
      schedulePowerIncident(
        initial,
        powerIncidentDraft(initial.snapshot.timestamp, {
          targetId: "PWR-UNKNOWN",
        }),
      ),
    ).toThrow("Unknown power section");
    expect(() =>
      schedulePowerIncident(
        initial,
        powerIncidentDraft(Number.NaN),
      ),
    ).toThrow("finite simulation timestamp");
  });

  it("applies priority and hold regulation without changing the train position", () => {
    const initial = createSimulationState();
    const before = initial.snapshot.trains.find((train) => train.id === "MI79-205");
    if (!before) throw new Error("Expected MI79-205");

    const prioritized = applyRegulation(initial, "MI79-205", "priority");
    const afterPriority = prioritized.snapshot.trains.find(
      (train) => train.id === "MI79-205",
    );
    expect(afterPriority?.delaySeconds).toBeLessThan(before.delaySeconds);
    expect(afterPriority).toEqual(
      expect.objectContaining({
        circuitId: before.circuitId,
        routeIndex: before.routeIndex,
        direction: before.direction,
        progress: before.progress,
      }),
    );

    const held = applyRegulation(initial, "MI79-205", "hold");
    expect(held.snapshot.trains.find((train) => train.id === "MI79-205")).toEqual(
      expect.objectContaining({
        circuitId: before.circuitId,
        routeIndex: before.routeIndex,
        direction: before.direction,
        progress: before.progress,
        speedKmh: 0,
        status: "held",
        holdTicks: 36_000 / STEP_MS,
      }),
    );
    expect(prioritized.snapshot.events[0]?.detail).toContain("simulation only");
  });

  it("rejects priority when no modelled recovery can be applied", () => {
    const initial = createSimulationState();
    const onTimeBefore = initial.snapshot.trains.find((train) => train.id === "MP14-014");
    const onTimeResult = applyRegulation(initial, "MP14-014", "priority");

    expect(onTimeResult.snapshot.trains.find((train) => train.id === "MP14-014")).toEqual(onTimeBefore);
    expect(onTimeResult.snapshot.events[0]).toEqual(expect.objectContaining({
      title: "Action priority rejected",
      detail: expect.stringContaining("no modelled delay remains to recover"),
    }));

    const stopped = {
      ...initial,
      snapshot: {
        ...initial.snapshot,
        trains: initial.snapshot.trains.map((train) =>
          train.id === "MI79-205" ? { ...train, status: "stopped" as const, speedKmh: 0 } : train,
        ),
      },
    };
    const stoppedBefore = stopped.snapshot.trains.find((train) => train.id === "MI79-205");
    const stoppedResult = applyRegulation(stopped, "MI79-205", "priority");
    expect(stoppedResult.snapshot.trains.find((train) => train.id === "MI79-205")).toEqual(stoppedBefore);
    expect(stoppedResult.snapshot.events[0]?.detail).toContain("resolve the blocking constraint first");
  });

  it("closes and reopens a free CDV with explicit metadata and events", () => {
    const initial = createSimulationState();
    const closed = closeCircuit(
      initial,
      "RB-02-A",
      "works",
      "  Rail renewal overnight  ",
      "  WO-4821  ",
    );

    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error(closed.message);
    expect(closed.nextState.snapshot.revision).toBe(initial.snapshot.revision + 1);
    expect(closed.nextState.snapshot.circuits.find((circuit) => circuit.id === "RB-02-A")).toEqual(
      expect.objectContaining({
        state: "blocked",
        closure: {
          reason: "works",
          note: "Rail renewal overnight",
          reference: "WO-4821",
          closedAt: initial.snapshot.timestamp,
        },
      }),
    );
    expect(closed.nextState.snapshot.events[0]).toEqual(
      expect.objectContaining({
        kind: "circuit",
        title: "CDV RB-02-A manually closed",
        severity: "medium",
      }),
    );
    expect(closed.nextState.snapshot.events[0]?.detail).toContain("simulation only");

    const redundantClose = closeCircuit(closed.nextState, "RB-02-A", "incident");
    expect(redundantClose).toEqual(
      expect.objectContaining({ ok: false, action: "close", reason: "already_closed" }),
    );
    expect(redundantClose.nextState).toBe(closed.nextState);

    const reopened = reopenCircuit(closed.nextState, "RB-02-A");
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.message);
    expect(reopened.nextState.snapshot.circuits.find((circuit) => circuit.id === "RB-02-A")).toEqual(
      expect.objectContaining({ state: "free", closure: null }),
    );
    expect(reopened.nextState.snapshot.events[0]?.title).toBe("CDV RB-02-A manually reopened");

    const redundantReopen = reopenCircuit(reopened.nextState, "RB-02-A");
    expect(redundantReopen).toEqual(
      expect.objectContaining({ ok: false, action: "reopen", reason: "already_open" }),
    );
  });

  it("rejects occupied, unavailable, unknown, oversized, and live CDV commands", () => {
    const initial = createSimulationState();
    const occupiedCircuit = initial.snapshot.trains[0].circuitId;

    expect(closeCircuit(initial, occupiedCircuit, "incident")).toEqual(
      expect.objectContaining({ ok: false, reason: "occupied", nextState: initial }),
    );
    expect(closeCircuit(initial, "M13-05-A", "works")).toEqual(
      expect.objectContaining({ ok: false, reason: "blocked", nextState: initial }),
    );
    expect(closeCircuit(initial, "UNKNOWN-CDV", "works")).toEqual(
      expect.objectContaining({ ok: false, reason: "not_found", nextState: initial }),
    );
    expect(
      closeCircuit(initial, "RB-02-A", "works", "n".repeat(MAX_CIRCUIT_CLOSURE_NOTE_LENGTH + 1)),
    ).toEqual(expect.objectContaining({ ok: false, reason: "invalid_note" }));
    expect(
      closeCircuit(
        initial,
        "RB-02-A",
        "works",
        undefined,
        "r".repeat(MAX_CIRCUIT_CLOSURE_REFERENCE_LENGTH + 1),
      ),
    ).toEqual(expect.objectContaining({ ok: false, reason: "invalid_reference" }));

    const liveState = {
      ...initial,
      snapshot: { ...initial.snapshot, source: "live" as const },
    };
    expect(closeCircuit(liveState, "RB-02-A", "works")).toEqual(
      expect.objectContaining({ ok: false, reason: "live_forbidden", nextState: liveState }),
    );
  });

  it("persists a closure across ticks, holds upstream trains, then restores movement", () => {
    const initial = createSimulationState();
    const closed = closeCircuit(initial, "RB-02-A", "works", "Points inspection", "WO-12");
    if (!closed.ok) throw new Error(closed.message);

    let snapshot = {
      ...closed.nextState.snapshot,
      trains: closed.nextState.snapshot.trains.map((train) =>
        train.id === "MI79-101" ? { ...train, progress: 0.99 } : train,
      ),
    };
    for (let tick = 0; tick < 6; tick += 1) {
      snapshot = advanceSnapshot(snapshot);
      expect(snapshot.circuits.find((circuit) => circuit.id === "RB-02-A")?.closure).toEqual(
        expect.objectContaining({ reason: "works", reference: "WO-12" }),
      );
      expect(snapshot.trains.find((train) => train.id === "MI79-101")?.circuitId).toBe("RB-01-A");
      expect(() => assertSnapshotInvariants(snapshot)).not.toThrow();
    }

    const reopened = reopenCircuit({ ...closed.nextState, snapshot }, "RB-02-A");
    if (!reopened.ok) throw new Error(reopened.message);
    const moved = advanceSnapshot(reopened.nextState.snapshot);
    expect(moved.trains.find((train) => train.id === "MI79-101")?.circuitId).toBe("RB-02-A");
    expect(() => assertSnapshotInvariants(moved)).not.toThrow();
  });

  it("removes only the manual closure when another scenario constraint remains", () => {
    const initial = createSimulationState();
    const closed = closeCircuit(initial, "RB-02-A", "incident", "Inspection requested");
    if (!closed.ok) throw new Error(closed.message);

    const isolated = setPowerStatus(closed.nextState, "PWR-RB-SUD", "isolated");
    const reopened = reopenCircuit(isolated, "RB-02-A");
    if (!reopened.ok) throw new Error(reopened.message);

    expect(reopened.nextState.snapshot.circuits.find((circuit) => circuit.id === "RB-02-A")).toEqual(
      expect.objectContaining({ closure: null, state: "blocked" }),
    );
    expect(reopened.message).toContain("scenario constraint still blocks");
  });

  it("creates an explicit bounded TURNBACK mission for a successful simulated turnback", () => {
    const initial = positionMi79101AtRerBNorthTurnback(createSimulationState());
    const regulated = applyRegulation(initial, "MI79-101", "turnback");
    expect(() => assertSnapshotInvariants(initial.snapshot)).not.toThrow();
    const train = regulated.snapshot.trains.find((candidate) => candidate.id === "MI79-101");

    expect(train).toEqual(
      expect.objectContaining({
        circulationId: "TB-ERIO42",
        mission: "TURNBACK",
        origin: "Gare du Nord",
        destination: "Denfert-Rochereau",
        direction: -1,
        circuitId: "RB-05-R",
        nextStop: "Châtelet – Les Halles",
        speedKmh: 0,
        progress: expect.closeTo(0.05, 8),
        holdTicks: STATION_DWELL_MS / STEP_MS,
        status: "dwelling",
      }),
    );
    const sourceTrain = initial.snapshot.trains.find((candidate) => candidate.id === "MI79-101");
    const sourceCircuit = initial.snapshot.circuits.find(
      (circuit) => circuit.id === sourceTrain?.circuitId,
    );
    const targetCircuit = regulated.snapshot.circuits.find(
      (circuit) => circuit.id === train?.circuitId,
    );
    if (!sourceTrain || !sourceCircuit || !train || !targetCircuit) {
      throw new Error("Expected TURNBACK geometry");
    }
    const sourceX =
      sourceCircuit.x1 + (sourceCircuit.x2 - sourceCircuit.x1) * sourceTrain.progress;
    const targetX =
      targetCircuit.x1 + (targetCircuit.x2 - targetCircuit.x1) * train.progress;
    expect(targetX).toBeCloseTo(sourceX, 8);
    expect(Math.abs(targetCircuit.y - sourceCircuit.y)).toBe(18);

    expect(train?.circulationId.length).toBeLessThanOrEqual(32);
    expect(regulated.snapshot.events[0]).toEqual(
      expect.objectContaining({
        title: "Simulated turnback applied",
        detail: expect.stringContaining("ERIO42 → TB-ERIO42"),
      }),
    );
    expect(regulated.snapshot.events[0]?.detail).toContain("simulation only");
    expect(() => assertSnapshotInvariants(regulated.snapshot)).not.toThrow();
  });
  it("rejects a turnback requested away from a modelled turnback point", () => {
    const initial = createSimulationState();
    const before = initial.snapshot.trains.find((train) => train.id === "MI79-101");
    const regulated = applyRegulation(initial, "MI79-101", "turnback");
    const after = regulated.snapshot.trains.find((train) => train.id === "MI79-101");

    expect(after).toEqual(before);
    expect(regulated.snapshot.revision).toBe(initial.snapshot.revision + 1);
    expect(regulated.snapshot.events[0]).toEqual(
      expect.objectContaining({
        title: "Action turnback rejected",
        detail: expect.stringContaining(
          "not at a modelled turnback point · simulation only",
        ),
      }),
    );
  });

  it("rejects a turnback whose destination CDV is manually closed", () => {
    const initial = positionMi79101AtRerBNorthTurnback(createSimulationState());
    const closed = closeCircuit(initial, "RB-05-R", "incident", "Obstacle reported");
    if (!closed.ok) throw new Error(closed.message);

    const before = closed.nextState.snapshot.trains.find((train) => train.id === "MI79-101");
    const regulated = applyRegulation(closed.nextState, "MI79-101", "turnback");
    const after = regulated.snapshot.trains.find((train) => train.id === "MI79-101");

    expect(after).toEqual(before);
    expect(regulated.snapshot.events[0]?.title).toBe("Action turnback rejected");
    expect(regulated.snapshot.events[0]?.detail).toContain("target CDV RB-05-R unavailable");
  });

  it("clears manual closures on reset while restoring scenario incident blocks", () => {
    const initial = createSimulationState();
    const closed = closeCircuit(initial, "RB-02-A", "works");
    if (!closed.ok) throw new Error(closed.message);
    expect(closed.nextState.snapshot.circuits.some((circuit) => circuit.closure !== null)).toBe(true);

    const reset = resetSimulation(closed.nextState);
    expect(reset.snapshot.circuits.every((circuit) => circuit.closure === null)).toBe(true);
    expect(reset.snapshot.decisionRevision).toBe(
      closed.nextState.snapshot.decisionRevision + 1,
    );
    expect(reset.snapshot.circuits.find((circuit) => circuit.id === "M13-05-A")).toEqual(
      expect.objectContaining({ state: "blocked", closure: null }),
    );
  });
});
