import { describe, expect, it } from "vitest";
import {
  RAIL_GRAPH_INTERSTATIONS,
  RAIL_GRAPH_LINES,
  RAIL_GRAPH_STATIONS,
} from "../rail/interdependenceGraph";
import {
  advanceOperationalResponse,
  applyOperationalResponseCapability,
  assertOperationalResponseInvariants,
  createOperationalResponseState,
  migrateOperationalResponseState,
  OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS,
  type OperationalIncidentEvidence,
} from "./operationalResponse";

const openedAt = Date.UTC(2026, 7, 30, 8, 0, 0);
const line = RAIL_GRAPH_LINES.find((item) => item.id === "RER_A")!;
const terminalId = line.terminalStationIds[0]!;

function incident(overrides: Partial<OperationalIncidentEvidence> = {}): OperationalIncidentEvidence {
  return {
    id: "INC-RER-A-001",
    incidentCode: "ICC-INC-INF-STA-CLS-001",
    status: "active",
    startedAt: openedAt,
    activatedAt: openedAt,
    lineCode: "RER_A",
    type: "infrastructure",
    effect: "station-closure",
    target: { type: "station", id: terminalId },
    affectedStationCodes: [terminalId],
    affectedInterstationIds: [],
    impactedTrainIds: ["RERA-101"],
    ...overrides,
  };
}

describe("operational response aggregate", () => {
  it("starts nominal with one SCADA channel for every line", () => {
    const state = createOperationalResponseState(openedAt);
    expect(state.lineScada).toHaveLength(21);
    expect(state.lineScada.every((item) => item.status === "nominal")).toBe(true);
    assertOperationalResponseInvariants(state);
  });

  it("uses strict >15, >25 and >60 minute decision thresholds without auto-applying", () => {
    let state = createOperationalResponseState(openedAt);
    const at15 = advanceOperationalResponse(state, [incident()], [], openedAt + 15 * 60_000);
    state = at15.state;
    expect(state.incidentCases[0]?.milestones.every((item) => item.status === "pending")).toBe(true);

    const after15 = advanceOperationalResponse(state, [incident()], [], openedAt + 15 * 60_000 + 1_000);
    state = after15.state;
    expect(state.incidentCases[0]?.milestones.filter((item) => item.status === "due").map((item) => item.code))
      .toEqual(["passenger-information", "connections"]);
    expect(state.continuityMeasures.every((item) => item.status === "proposed")).toBe(true);

    const at25 = advanceOperationalResponse(state, [incident()], [], openedAt + 25 * 60_000);
    state = at25.state;
    expect(state.incidentCases[0]?.milestones.find((item) => item.code === "provisional-service")?.status)
      .toBe("pending");
    const after25 = advanceOperationalResponse(state, [incident()], [], openedAt + 25 * 60_000 + 1_000);
    state = after25.state;
    expect(state.incidentCases[0]?.milestones.find((item) => item.code === "provisional-service")?.status)
      .toBe("due");
    expect(state.incidentCases[0]?.milestones.find((item) => item.code === "turnbacks")?.status)
      .toBe("due");

    const at60 = advanceOperationalResponse(state, [incident()], [], openedAt + 60 * 60_000);
    state = at60.state;
    expect(state.incidentCases[0]?.milestones.find((item) => item.code === "shuttle-bus")?.status)
      .toBe("pending");
    const after60 = advanceOperationalResponse(state, [incident()], [], openedAt + 60 * 60_000 + 1_000);
    expect(after60.state.incidentCases[0]?.milestones.find((item) => item.code === "shuttle-bus")?.status)
      .toBe("due");
    expect(after60.state.continuityMeasures.find((item) => item.kind === "shuttle-bus")?.directions)
      .toEqual(["outbound", "inbound"]);
    expect(OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS).toEqual({
      passengerInformation: 900,
      connections: 900,
      provisionalService: 1_500,
      turnbacks: 1_500,
      shuttleBus: 3_600,
    });
  });

  it("requires explicit operator approval and persists a grounded receipt", () => {
    const due = advanceOperationalResponse(
      createOperationalResponseState(openedAt),
      [incident()],
      [],
      openedAt + 25 * 60_000 + 1_000,
    ).state;
    const applied = applyOperationalResponseCapability(due, {
      incidentId: "INC-RER-A-001",
      capability: "activate-turnbacks",
      operatorId: "session-operator-1",
      timestamp: openedAt + 25 * 60_000 + 2_000,
    });
    expect(applied.receipt.operatorId).toBe("session-operator-1");
    expect(applied.receipt.affectedEntityIds).toEqual(
      due.incidentCases[0]?.continuityBoundaryStationIds,
    );
    expect(applied.state.continuityMeasures.find((item) => item.kind === "turnback")?.status)
      .toBe("active");
    expect(applied.state.receipts).toContainEqual(applied.receipt);
  });

  it("derives SCADA loss from an active coded incident and restores nominal state", () => {
    let state = advanceOperationalResponse(
      createOperationalResponseState(openedAt),
      [incident({
        id: "INC-COM-RERA",
        incidentCode: "ICC-INC-COM-LIN-LOS-001",
        effect: "communication-loss",
        target: { type: "line", id: "RER_A" },
      })],
      [],
      openedAt + 1_000,
    ).state;
    expect(state.lineScada.find((item) => item.lineCode === "RER_A")).toMatchObject({
      status: "unavailable",
      communicationIncidentId: "INC-COM-RERA",
    });
    state = advanceOperationalResponse(
      state,
      [incident({
        id: "INC-COM-RERA",
        incidentCode: "ICC-INC-COM-LIN-LOS-001",
        status: "resolved",
        effect: "communication-loss",
        target: { type: "line", id: "RER_A" },
      })],
      [],
      openedAt + 2_000,
    ).state;
    expect(state.lineScada.find((item) => item.lineCode === "RER_A")?.status).toBe("nominal");
  });

  it("makes strict thresholds predictive from mandatory procedure steps without auto-applying", () => {
    const baggage = incident({
      id: "INC-BAGGAGE-001",
      incidentCode: "ICC-INC-SEC-STA-BAG-001",
      type: "security",
      effect: "abandoned-baggage",
      target: { type: "station", id: terminalId },
      impactedTrainIds: [],
    });
    const projected = advanceOperationalResponse(
      createOperationalResponseState(openedAt),
      [baggage],
      [],
      openedAt,
    ).state;
    const incidentCase = projected.incidentCases[0]!;
    expect(incidentCase.predictedDuration).toMatchObject({
      basis: "mandatory-procedure-steps",
      procedureId: "ICC-PROC-ABANDONED-BAGGAGE-001",
      nominalSeconds: 5_160,
    });
    expect(incidentCase.milestones.every((milestone) =>
      milestone.status === "due" && milestone.dueBasis === "predicted-duration"
    )).toBe(true);
    expect(projected.continuityMeasures.every((measure) => measure.status === "proposed")).toBe(true);

    const bus = projected.continuityMeasures.find((measure) => measure.kind === "shuttle-bus")!;
    expect(bus.plan).toMatchObject({
      kind: "shuttle-bus",
      terminusStationIds: [expect.any(String), expect.any(String)],
      directions: [
        { direction: "outbound", fromStationId: expect.any(String), toStationId: expect.any(String) },
        { direction: "inbound", fromStationId: expect.any(String), toStationId: expect.any(String) },
      ],
      fleetSize: expect.any(Number),
      headwaySeconds: 600,
      vehicleCapacityPassengers: 80,
      capacityPerHour: expect.any(Number),
      cycle: { phase: "awaiting-approval", direction: null },
    });
    expect(projected.continuityMeasures.find((measure) => measure.kind === "provisional-service")?.plan)
      .toMatchObject({ kind: "provisional-service", targetHeadwaySeconds: 360 });
    expect(projected.continuityMeasures.find((measure) => measure.kind === "turnback")?.plan)
      .toMatchObject({ kind: "turnback", turnbackStationIds: expect.any(Array) });
    expect(projected.continuityMeasures.find((measure) => measure.kind === "train-insertion")?.plan)
      .toMatchObject({
        kind: "train-insertion",
        stationId: expect.any(String),
        destinationStationId: expect.any(String),
        capacityDeltaPassengers: 1_600,
      });
    const insertionPlan = projected.continuityMeasures.find((measure) => measure.kind === "train-insertion")?.plan;
    expect([1, -1]).toContain(
      insertionPlan && insertionPlan.kind === "train-insertion" ? insertionPlan.direction : 0,
    );
  });

  it("immediately proposes graph-grounded flank services for a works station closure", () => {
    const terminalIds = new Set(line.terminalStationIds);
    const interiorStation = RAIL_GRAPH_STATIONS.find((station) => {
      if (!station.lineCodes.includes("RER_A") || terminalIds.has(station.id)) return false;
      return RAIL_GRAPH_INTERSTATIONS.filter((interstation) =>
        interstation.lineCode === "RER_A" &&
        (interstation.fromStationId === station.id || interstation.toStationId === station.id)
      ).length === 2;
    })!;
    const adjacentInterstations = RAIL_GRAPH_INTERSTATIONS.filter((interstation) =>
      interstation.lineCode === "RER_A" &&
      (interstation.fromStationId === interiorStation.id || interstation.toStationId === interiorStation.id)
    );
    const boundaries = adjacentInterstations
      .flatMap((interstation) => [interstation.fromStationId, interstation.toStationId])
      .filter((stationId) => stationId !== interiorStation.id)
      .sort();
    const closure = incident({
      id: "INC-WORKS-STATION-CLOSURE",
      incidentCode: "ICC-INC-WRK-STA-CLS-001",
      type: "works",
      effect: "station-closure",
      target: { type: "station", id: interiorStation.id },
      affectedStationCodes: [interiorStation.id],
      affectedInterstationIds: adjacentInterstations.map((interstation) => interstation.id),
      impactedTrainIds: [],
    });

    const state = advanceOperationalResponse(
      createOperationalResponseState(openedAt),
      [closure],
      [],
      openedAt,
    ).state;
    const incidentCase = state.incidentCases[0]!;
    expect(incidentCase.protectedStationIds).toEqual([interiorStation.id]);
    expect(incidentCase.continuityBoundaryStationIds).toEqual(boundaries);

    const provisional = state.continuityMeasures.find((measure) =>
      measure.kind === "provisional-service"
    )!;
    const turnbacks = state.continuityMeasures.find((measure) => measure.kind === "turnback")!;
    expect(provisional).toMatchObject({
      status: "proposed",
      directions: ["outbound", "inbound"],
      plan: {
        kind: "provisional-service",
        protectedStationIds: [interiorStation.id],
        turnbackStationIds: boundaries,
        serviceSegments: [
          { turnbackStationId: boundaries[0], directions: [{ direction: "outbound" }, { direction: "inbound" }] },
          { turnbackStationId: boundaries[1], directions: [{ direction: "outbound" }, { direction: "inbound" }] },
        ],
      },
    });
    expect(turnbacks).toMatchObject({
      status: "proposed",
      stationIds: boundaries,
      plan: {
        kind: "turnback",
        protectedStationIds: [interiorStation.id],
        turnbackStationIds: boundaries,
      },
    });
    const segments = provisional.plan?.kind === "provisional-service"
      ? provisional.plan.serviceSegments ?? []
      : [];
    expect(segments).toHaveLength(2);
    expect(provisional.stationIds).toEqual(
      [...new Set(segments.flatMap((segment) => segment.terminalStationIds))].sort(),
    );
    expect(segments.every((segment) =>
      !segment.terminalStationIds.includes(interiorStation.id) &&
      segment.graphInterstationIds.every((id) => !adjacentInterstations.some((edge) => edge.id === id))
    )).toBe(true);
    expect(provisional.proposedAt).toBe(openedAt);
  });

  it("derives and persists a reproducible discrete outbound/return shuttle cycle", () => {
    const baggage = incident({
      id: "INC-BAGGAGE-CYCLE",
      incidentCode: "ICC-INC-SEC-STA-BAG-001",
      type: "security",
      effect: "abandoned-baggage",
      target: { type: "station", id: terminalId },
      impactedTrainIds: [],
    });
    const proposed = advanceOperationalResponse(
      createOperationalResponseState(openedAt), [baggage], [], openedAt,
    ).state;
    const activated = applyOperationalResponseCapability(proposed, {
      incidentId: baggage.id,
      capability: "activate-shuttle-bus",
      operatorId: "operator-cycle",
      timestamp: openedAt,
    }).state;
    const activePlan = activated.continuityMeasures.find((measure) => measure.kind === "shuttle-bus")?.plan;
    expect(activePlan).toMatchObject({
      kind: "shuttle-bus",
      cycle: { phase: "outbound", direction: "outbound", cycleIndex: 0 },
    });
    if (!activePlan || activePlan.kind !== "shuttle-bus" || activePlan.cycle.nextTransitionAt === null) {
      throw new Error("Missing active shuttle cycle");
    }
    const transitioned = advanceOperationalResponse(
      activated, [baggage], [], activePlan.cycle.nextTransitionAt,
    ).state;
    const transitionedPlan = transitioned.continuityMeasures.find((measure) => measure.kind === "shuttle-bus")?.plan;
    expect(transitionedPlan).toMatchObject({
      kind: "shuttle-bus",
      cycle: { phase: "at-destination", direction: null, cycleIndex: 0 },
    });
    if (!transitionedPlan || transitionedPlan.kind !== "shuttle-bus" || transitionedPlan.cycle.nextTransitionAt === null) {
      throw new Error("Missing destination layover state");
    }
    const returning = advanceOperationalResponse(
      transitioned, [baggage], [], transitionedPlan.cycle.nextTransitionAt,
    ).state;
    const returningPlan = returning.continuityMeasures.find((measure) => measure.kind === "shuttle-bus")?.plan;
    expect(returningPlan).toMatchObject({
      kind: "shuttle-bus",
      cycle: { phase: "inbound", direction: "inbound", cycleIndex: 0 },
    });
    if (!returningPlan || returningPlan.kind !== "shuttle-bus" || returningPlan.cycle.nextTransitionAt === null) {
      throw new Error("Missing return shuttle state");
    }
    const atOrigin = advanceOperationalResponse(
      returning, [baggage], [], returningPlan.cycle.nextTransitionAt,
    ).state;
    const atOriginPlan = atOrigin.continuityMeasures.find((measure) => measure.kind === "shuttle-bus")?.plan;
    expect(atOriginPlan).toMatchObject({
      kind: "shuttle-bus",
      cycle: { phase: "at-origin", direction: null, cycleIndex: 0 },
    });
    const restored = migrateOperationalResponseState(structuredClone(atOrigin), returningPlan.cycle.nextTransitionAt);
    expect(restored.continuityMeasures.find((measure) => measure.kind === "shuttle-bus")?.plan)
      .toEqual(atOriginPlan);
  });

  it("grounds towing and maintenance ETA ranges in their catalogued procedure capabilities", () => {
    const towing = incident({
      id: "INC-TOW-001",
      incidentCode: "ICC-INC-RST-TRN-TOW-001",
      type: "rolling-stock",
      effect: "tow-train",
      target: { type: "train", id: "RERA-101" },
      affectedStationCodes: [terminalId],
    });
    const towingState = advanceOperationalResponse(
      createOperationalResponseState(openedAt), [towing], [], openedAt,
    ).state;
    expect(towingState.continuityMeasures.find((measure) => measure.kind === "towing")?.plan)
      .toMatchObject({
        kind: "towing",
        receivingTerminalStationId: expect.any(String),
        direction: "toward-receiving-terminal",
        estimatedDuration: { minSeconds: 7_200, nominalSeconds: 10_800, maxSeconds: 14_400 },
        basisProcedureId: "ICC-PROC-ROLLING-STOCK-TOWING-001",
      });

    const communications = incident({
      id: "INC-COM-001",
      incidentCode: "ICC-INC-COM-LIN-LOS-001",
      type: "communications",
      effect: "communication-loss",
      target: { type: "line", id: "RER_A" },
      affectedStationCodes: [],
      impactedTrainIds: [],
    });
    const communicationsState = advanceOperationalResponse(
      createOperationalResponseState(openedAt), [communications], [], openedAt,
    ).state;
    expect(communicationsState.dispatches[0]).toMatchObject({
      status: "proposed",
      plan: {
        team: "communications",
        estimatedDuration: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
        basisProcedureId: "ICC-PROC-SCADA-COMMUNICATION-001",
      },
    });
    const dispatched = applyOperationalResponseCapability(communicationsState, {
      incidentId: communications.id,
      capability: "dispatch-maintenance",
      operatorId: "operator-maintenance",
      timestamp: openedAt + 120_000,
    }).state.dispatches[0]!;
    expect(dispatched.plan.eta.expectedAt).toBe(openedAt + 120_000 + 900_000);

    const traction = incident({
      id: "INC-TRACTION-001",
      incidentCode: "ICC-INC-PWR-PWR-DEG-001",
      lineCode: "M14",
      type: "power",
      effect: "degrade-power",
      target: { type: "power", id: "PWR-M14-CENTRAL" },
      affectedStationCodes: [],
      impactedTrainIds: [],
    });
    const tractionState = advanceOperationalResponse(
      createOperationalResponseState(openedAt), [traction], [], openedAt,
    ).state;
    expect(tractionState.dispatches[0]).toMatchObject({
      status: "proposed",
      targetType: "power",
      targetId: "PWR-M14-CENTRAL",
      plan: {
        team: "traction-power",
        estimatedDuration: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
        basisProcedureId: "ICC-PROC-POWER-DEGRADED-001",
      },
    });
    const tractionDispatched = applyOperationalResponseCapability(tractionState, {
      incidentId: traction.id,
      capability: "dispatch-maintenance",
      operatorId: "operator-traction",
      timestamp: openedAt + 60_000,
    });
    expect(tractionDispatched.receipt).toMatchObject({
      incidentId: traction.id,
      capability: "dispatch-maintenance",
      operatorId: "operator-traction",
    });
    expect(tractionDispatched.state.dispatches[0]?.status).toBe("dispatched");
  });

  it("enriches legacy response records that predate concrete plans", () => {
    const towing = incident({
      id: "INC-TOW-LEGACY",
      incidentCode: "ICC-INC-RST-TRN-TOW-001",
      type: "rolling-stock",
      effect: "tow-train",
      target: { type: "train", id: "RERA-101" },
      affectedStationCodes: [terminalId],
    });
    const legacy = structuredClone(advanceOperationalResponse(
      createOperationalResponseState(openedAt), [towing], [], openedAt,
    ).state) as any;
    delete legacy.incidentCases[0].predictedDuration;
    for (const milestone of legacy.incidentCases[0].milestones) delete milestone.dueBasis;
    for (const measure of legacy.continuityMeasures) delete measure.plan;
    for (const dispatch of legacy.dispatches) delete dispatch.plan;
    const migrated = migrateOperationalResponseState(legacy, openedAt);
    expect(migrated.incidentCases[0]?.predictedDuration?.procedureId)
      .toBe("ICC-PROC-ROLLING-STOCK-TOWING-001");
    expect(migrated.continuityMeasures.find((measure) => measure.kind === "towing")?.plan)
      .toMatchObject({ kind: "towing", estimatedDuration: { nominalSeconds: 10_800 } });
    expect(migrated.dispatches[0]?.plan).toMatchObject({
      team: "rolling-stock",
      estimatedDuration: { nominalSeconds: 1_800 },
    });
  });

  it("migrates an absent v1 field to a nominal aggregate", () => {
    const migrated = migrateOperationalResponseState(undefined, openedAt);
    expect(migrated.lineScada).toHaveLength(21);
    expect(migrated.incidentCases).toEqual([]);
  });
});
