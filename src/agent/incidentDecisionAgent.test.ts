import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeIncidentDecision,
  applyIncidentProcedureStep,
  clearIncidentDecisionCache,
} from "./incidentDecisionAgent";

const INCIDENT_ID = "INC-RER-A-01";
const INCIDENT_CODE = "SIG-TD-LOSS";
const REVISION = 7;
const PROCEDURE_ID = "PROC-SIG-TD-LOSS";
const PROCEDURE_REVISION = "3.2";
const PROCEDURE_HASH = "a".repeat(64);
const PROTECT_STEP = "PROC-SIG-TD-LOSS-S01";
const VERIFY_STEP = "PROC-SIG-TD-LOSS-S04";
const PASSENGER_INFO_STEP = "PROC-SIG-TD-LOSS-S41";
const FORBIDDEN_OPERATOR_NARRATIVE =
  /\b(?:simulation|simulated|simulator|simulating|synthetic|demo|demonstration|deterministic|scenario|exercise|sandbox|modelled|modeled)\b|local[- ]simulation/i;

const contextOutput = {
  status: "context_ready",
  incident: {
    id: INCIDENT_ID,
    incidentCode: INCIDENT_CODE,
    title: "Loss of train detection at Auber",
    type: "infrastructure",
    effect: "closure",
    severity: "high",
    status: "active",
    occurrenceTime: "2026-08-29T08:42:00.000Z",
    lineCodes: ["RER_A"],
    target: { type: "interstation", id: "RER_A:AUBER-NATION" },
    affectedSegmentIds: ["RER_A:AUBER-NATION"],
    affectedStationCodes: ["AUBER", "NATION"],
    impactedTrainIds: ["RERA-001", "RERA-002"],
  },
  evidence: {
    timestamp: 1777000000000,
    telemetryRevision: 19,
    decisionRevision: REVISION,
    scenarioId: "multi-event",
    procedureCatalogueSequence: 0,
  },
  impact: {
    impactedTrainCount: 2,
    passengersOnImpactedTrains: 1260,
    worstDelaySeconds: 480,
    activeRestrictionCount: 1,
    affectedLineCodes: ["RER_A"],
    affectedSegmentIds: ["RER_A:AUBER-NATION"],
  },
};

const operationalResponseOutput = {
  revision: 11,
  incidentCase: {
    incidentId: INCIDENT_ID,
    incidentCode: INCIDENT_CODE,
    lineCodes: ["RER_A"],
    openedAt: 1776999000000,
    status: "active",
    protectedStationIds: ["AUBER"],
    continuityBoundaryStationIds: ["CHARLES-DE-GAULLE", "NATION"],
    affectedStationIds: ["AUBER", "NATION"],
    affectedInterstationIds: ["RER_A:AUBER-NATION"],
    connectionIds: ["CONNECTION:AUBER"],
    terminalStationIds: ["CERGY", "BOISSY"],
    insertionStationIds: Array.from({ length: 40 }, (_, index) => "INSERT-" + index),
    predictedDuration: {
      minSeconds: 1_200,
      nominalSeconds: 2_400,
      maxSeconds: 4_800,
      basis: "mandatory-procedure-steps",
      procedureId: PROCEDURE_ID,
      procedureRevision: PROCEDURE_REVISION,
      calculatedAt: 1777000000000,
      eta: {
        earliestAt: 1777001200000,
        expectedAt: 1777002400000,
        latestAt: 1777004800000,
      },
    },
    milestones: [
      {
        code: "passenger-information",
        thresholdSeconds: 900,
        capability: "publish-passenger-information",
        status: "due",
        dueAt: 1777000000000,
        dueBasis: "predicted-duration",
        appliedAt: null,
        receiptId: null,
      },
      {
        code: "connections",
        thresholdSeconds: 900,
        capability: "protect-connections",
        status: "pending",
        dueAt: null,
        dueBasis: null,
        appliedAt: null,
        receiptId: null,
      },
    ],
  },
  lineScada: [{
    lineCode: "RER_A",
    status: "degraded",
    lastHeartbeatAt: 1776999995000,
    communicationIncidentId: INCIDENT_ID,
  }],
  dispatches: [{
    dispatchId: "DISPATCH-001",
    lineCode: "RER_A",
    targetType: "interstation",
    targetId: "RER_A:AUBER-NATION",
    status: "proposed",
    proposedAt: 1777000000000,
    dispatchedAt: null,
    completedAt: null,
    receiptId: null,
    plan: {
      team: "communications",
      targetStationIds: ["AUBER"],
      estimatedDuration: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
      eta: {
        earliestAt: 1777000300000,
        expectedAt: 1777000900000,
        latestAt: 1777003600000,
      },
      basisProcedureId: PROCEDURE_ID,
      basisProcedureRevision: PROCEDURE_REVISION,
    },
    operatorApprovalRequired: true,
  }],
  continuityMeasures: [
    {
      measureId: "MEASURE-PAX",
      kind: "passenger-information",
      lineCodes: ["RER_A"],
      status: "proposed",
      proposedAt: 1777000000000,
      approvedAt: null,
      approvedBy: null,
      completedAt: null,
      stationIds: ["AUBER", "NATION"],
      connectionIds: [],
      receiptId: null,
      directions: [],
      plan: null,
      operatorApprovalRequired: true,
    },
    {
      measureId: "MEASURE-INSERT",
      kind: "train-insertion",
      lineCodes: ["RER_A"],
      status: "proposed",
      proposedAt: 1777000000000,
      approvedAt: null,
      approvedBy: null,
      completedAt: null,
      stationIds: Array.from({ length: 40 }, (_, index) => "INSERT-" + index),
      connectionIds: [],
      receiptId: null,
      directions: [],
      plan: {
        kind: "train-insertion",
        stationId: "CERGY",
        destinationStationId: "BOISSY",
        direction: 1,
        capacityDeltaPassengers: 1_305,
      },
      operatorApprovalRequired: true,
    },
    {
      measureId: "MEASURE-BUS",
      kind: "shuttle-bus",
      lineCodes: ["RER_A"],
      status: "active",
      proposedAt: 1776990000000,
      approvedAt: 1776991000000,
      approvedBy: "operator",
      completedAt: null,
      stationIds: ["AUBER", "NATION"],
      connectionIds: [],
      receiptId: "RECEIPT-BUS",
      directions: ["outbound", "inbound"],
      plan: {
        kind: "shuttle-bus",
        terminusStationIds: ["AUBER", "NATION"],
        directions: [
          { direction: "outbound", fromStationId: "AUBER", toStationId: "NATION" },
          { direction: "inbound", fromStationId: "NATION", toStationId: "AUBER" },
        ],
        fleetSize: 6,
        headwaySeconds: 600,
        vehicleCapacityPassengers: 80,
        capacityPerHour: 2_880,
        routeTravelSeconds: 1_800,
        layoverSeconds: 300,
        graphInterstationIds: ["RER_A:AUBER-NATION"],
        cycle: {
          phase: "outbound",
          direction: "outbound",
          atStationId: null,
          cycleIndex: 2,
          phaseStartedAt: 1776999000000,
          nextTransitionAt: 1777000800000,
        },
      },
      operatorApprovalRequired: false,
    },
    {
      measureId: "MEASURE-TOW",
      kind: "towing",
      lineCodes: ["RER_A"],
      status: "active",
      proposedAt: 1776990000000,
      approvedAt: 1776991000000,
      approvedBy: "operator",
      completedAt: null,
      stationIds: ["CERGY"],
      connectionIds: [],
      receiptId: "RECEIPT-TOW",
      directions: [],
      plan: {
        kind: "towing",
        receivingTerminalStationId: "CERGY",
        direction: "toward-receiving-terminal",
        estimatedDuration: { minSeconds: 7_200, nominalSeconds: 10_800, maxSeconds: 14_400 },
        eta: {
          earliestAt: 1777007200000,
          expectedAt: 1777010800000,
          latestAt: 1777014400000,
        },
        basisProcedureId: PROCEDURE_ID,
        basisProcedureRevision: PROCEDURE_REVISION,
      },
      operatorApprovalRequired: false,
    },
    {
      measureId: "MEASURE-PROVISIONAL",
      kind: "provisional-service",
      lineCodes: ["RER_A"],
      status: "active",
      proposedAt: 1776990000000,
      approvedAt: 1776991000000,
      approvedBy: "operator",
      completedAt: null,
      stationIds: ["AUBER", "NATION"],
      connectionIds: [],
      receiptId: "RECEIPT-PROVISIONAL",
      directions: [],
      plan: {
        kind: "provisional-service",
        terminusStationIds: ["AUBER", "NATION"],
        directions: [
          { direction: "outbound", fromStationId: "AUBER", toStationId: "NATION" },
          { direction: "inbound", fromStationId: "NATION", toStationId: "AUBER" },
        ],
        targetHeadwaySeconds: 360,
        protectedStationIds: ["AUBER"],
        turnbackStationIds: ["CHARLES-DE-GAULLE", "NATION"],
        serviceSegments: [{
          terminalStationIds: ["CERGY", "CHARLES-DE-GAULLE"],
          turnbackStationId: "CHARLES-DE-GAULLE",
          directions: [
            { direction: "outbound", fromStationId: "CERGY", toStationId: "CHARLES-DE-GAULLE" },
            { direction: "inbound", fromStationId: "CHARLES-DE-GAULLE", toStationId: "CERGY" },
          ],
          graphInterstationIds: ["RER_A:CERGY-CDG"],
        }],
      },
      operatorApprovalRequired: false,
    },
    {
      measureId: "MEASURE-TURNBACK",
      kind: "turnback",
      lineCodes: ["RER_A"],
      status: "active",
      proposedAt: 1776990000000,
      approvedAt: 1776991000000,
      approvedBy: "operator",
      completedAt: null,
      stationIds: ["AUBER", "NATION"],
      connectionIds: [],
      receiptId: "RECEIPT-TURNBACK",
      directions: [],
      plan: {
        kind: "turnback",
        turnbackStationIds: ["AUBER", "NATION"],
        directions: [
          { direction: "outbound", fromStationId: "AUBER", toStationId: "NATION" },
          { direction: "inbound", fromStationId: "NATION", toStationId: "AUBER" },
        ],
        protectedStationIds: ["AUBER"],
        serviceSegments: [{
          terminalStationIds: ["CERGY", "CHARLES-DE-GAULLE"],
          turnbackStationId: "CHARLES-DE-GAULLE",
          directions: [
            { direction: "outbound", fromStationId: "CERGY", toStationId: "CHARLES-DE-GAULLE" },
            { direction: "inbound", fromStationId: "CHARLES-DE-GAULLE", toStationId: "CERGY" },
          ],
          graphInterstationIds: ["RER_A:CERGY-CDG"],
        }],
      },
      operatorApprovalRequired: false,
    },
  ],
  crowding: Array.from({ length: 20 }, (_, index) => ({
    stationId: "CROWD-" + index,
    lineCodes: ["RER_A"],
    estimatedPassengers: 500 + index,
    level: index === 0 ? "critical" : "elevated",
    updatedAt: 1777000000000,
  })),
  receipts: [{
    receiptId: "RECEIPT-PAX",
    capability: "publish-passenger-information",
    appliedAt: 1776999000000,
    affectedEntityIds: ["AUBER"],
  }],
  operatorApprovalRequired: true,
};

const contextWithOperationalResponse = {
  ...contextOutput,
  operationalResponse: operationalResponseOutput,
};

const searchOutput = {
  status: "procedures_found",
  incidentCode: INCIDENT_CODE,
  catalogRevision: "procedure-catalog-2026.08",
  matches: [{
    procedureId: PROCEDURE_ID,
    title: "Loss of train detection",
    revision: PROCEDURE_REVISION,
    contentHash: PROCEDURE_HASH,
  }],
  nonMutating: true,
};

const procedureOutput = {
  status: "procedure_ready",
  procedure: {
    procedureId: PROCEDURE_ID,
    title: "Loss of train detection",
    revision: PROCEDURE_REVISION,
    contentHash: PROCEDURE_HASH,
    documentRef: "procedures/PROC-SIG-TD-LOSS.json",
    steps: [
      {
        stepId: PROTECT_STEP,
        order: 1,
        phase: "protection",
        title: "Maintain route protection",
        instruction: "Keep the affected segment protected and meter trains upstream.",
        rationale: "Protection prevents an uncontrolled entry while detection is unavailable.",
        mandatory: true,
        responsibleRole: "ICC regulator",
        evidenceRequired: ["Confirm the protected segment.", "Confirm upstream trains are held."],
        durationRangeSeconds: { minSeconds: 30, nominalSeconds: 120, maxSeconds: 300 },
        capability: {
          command: "protect-and-hold",
          requiresOperatorConfirmation: true,
          reversible: true,
        },
      },
      {
        stepId: PASSENGER_INFO_STEP,
        order: 41,
        phase: "mitigate",
        title: "Publish reviewed passenger information",
        instruction: "Publish the reviewed disruption scope and connection consequences.",
        rationale: "The operational response reports that passenger information is due.",
        mandatory: false,
        responsibleRole: "ICC operator",
        evidenceRequired: ["Current incident revision.", "Operator approval."],
        durationRangeSeconds: { minSeconds: 30, nominalSeconds: 120, maxSeconds: 600 },
        capability: {
          command: "publish-passenger-information",
          requiresOperatorConfirmation: true,
          reversible: true,
        },
      },
      {
        stepId: VERIFY_STEP,
        order: 4,
        phase: "recovery",
        title: "Verify stable detection",
        instruction: "Verify stable train detection before clearing the restriction.",
        rationale: "Normal traffic requires stable detection evidence.",
        mandatory: true,
        responsibleRole: "ICC regulator",
        evidenceRequired: ["Confirm stable detection.", "Confirm no train remains held by the incident."],
        durationRangeSeconds: { minSeconds: 30, nominalSeconds: 60, maxSeconds: 180 },
        capability: {
          command: "close-incident",
          requiresOperatorConfirmation: true,
          reversible: false,
        },
      },
    ],
    normalStateCriteria: [
      "Train detection is stable.",
      "The incident restriction is cleared.",
    ],
  },
};

const modelRecommendation = {
  schemaVersion: "incident-decision.v2",
  incidentId: INCIDENT_ID,
  incidentCode: INCIDENT_CODE,
  decisionRevision: REVISION,
  procedureId: PROCEDURE_ID,
  procedureRevision: PROCEDURE_REVISION,
  procedureContentHash: PROCEDURE_HASH,
  executiveSummary: "Protect the affected segment, then verify stable detection before recovery.",
  actions: [
    {
      stepId: PROTECT_STEP,
      priority: 1,
      rationale: "Immediate protection is the first mandatory procedural step.",
      operatorChecks: ["Confirm the protected segment."],
    },
    {
      stepId: VERIFY_STEP,
      priority: 2,
      rationale: "The restriction may be cleared only after documented stability checks.",
      operatorChecks: ["Confirm stable detection."],
    },
  ],
  risks: ["Passenger delay accumulates while protection remains active."],
  normalStateCriteria: [
    "Train detection is stable.",
    "The incident restriction is cleared.",
  ],
  advisoryOnly: true,
  humanReviewRequired: true,
};

function response(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

function definition(
  name: string,
  execute: WebMcpToolDefinition["execute"],
  readOnlyHint: boolean,
): WebMcpToolDefinition {
  return {
    name,
    description: `Test tool ${name}.`,
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint },
    execute,
  };
}

function createTools(
  inspectOutput: unknown = contextOutput,
  retrievedProcedure: unknown = procedureOutput,
) {
  const order: string[] = [];
  const inspect = vi.fn(async () => {
    order.push("inspect");
    return inspectOutput;
  });
  const search = vi.fn(async () => {
    order.push("search");
    return searchOutput;
  });
  const get = vi.fn(async () => {
    order.push("get");
    return retrievedProcedure;
  });
  const apply = vi.fn(async (input: Record<string, unknown>) => {
    order.push("apply");
    return {
      status: "applied_to_simulation",
      incidentId: INCIDENT_ID,
      procedureId: PROCEDURE_ID,
      procedureRevision: PROCEDURE_REVISION,
      procedureContentHash: PROCEDURE_HASH,
      stepId: String(input.stepId),
      previousDecisionRevision: REVISION,
      decisionRevision: REVISION + 1,
      receiptId: "PROC-DEC-8-INC-RER-A-01",
    };
  });
  return {
    order,
    inspect,
    search,
    get,
    apply,
    definitions: [
      definition("inspect_incident_decision_context", inspect, true),
      definition("search_operational_procedures", search, true),
      definition("get_operational_procedure", get, true),
      definition("apply_reviewed_procedure_step", apply, false),
    ],
  };
}

function installModel(recommendation: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = [];
  let turn = 0;
  const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    if (String(request) === "/api/agent/reset") return response({ status: "reset" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    turn += 1;
    if (turn === 1) {
      return response({
        status: "tool_calls",
        runId: "run-1",
        calls: [{
          callId: "inspect-1",
          name: "inspect_incident_decision_context",
          arguments: { incidentId: INCIDENT_ID },
        }],
      });
    }
    if (turn === 2) {
      return response({
        status: "tool_calls",
        runId: "run-1",
        calls: [{
          callId: "search-1",
          name: "search_operational_procedures",
          arguments: { incidentCode: INCIDENT_CODE },
        }],
      });
    }
    if (turn === 3) {
      return response({
        status: "tool_calls",
        runId: "run-1",
        calls: [{
          callId: "get-1",
          name: "get_operational_procedure",
          arguments: {
            procedureId: PROCEDURE_ID,
            procedureRevision: PROCEDURE_REVISION,
            procedureContentHash: PROCEDURE_HASH,
          },
        }],
      });
    }
    return response({
      status: "completed",
      runId: "run-1",
      recommendation,
      usage: { inputTokens: 560, outputTokens: 210 },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { bodies, fetchMock };
}

async function deterministicDecision(
  tools: ReturnType<typeof createTools>,
  procedureCatalogueSequence?: number,
) {
  return analyzeIncidentDecision({
    incidentId: INCIDENT_ID,
    decisionRevision: REVISION,
    procedureCatalogueSequence,
    expectedToolNames: tools.definitions.map((tool) => tool.name),
    inPageTools: tools.definitions,
    modelEnabled: false,
    signal: new AbortController().signal,
  });
}

beforeEach(() => {
  clearIncidentDecisionCache();
  vi.stubGlobal("document", {});
});

afterEach(() => {
  clearIncidentDecisionCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("procedure-grounded incident decision agent", () => {
  it("runs inspect, search and get before accepting a model-assisted v2 recommendation", async () => {
    const tools = createTools();
    const { bodies } = installModel(modelRecommendation);
    const progress: string[] = [];

    const result = await analyzeIncidentDecision({
      incidentId: INCIDENT_ID,
      decisionRevision: REVISION,
      expectedToolNames: tools.definitions.map((tool) => tool.name),
      inPageTools: tools.definitions,
      modelEnabled: true,
      signal: new AbortController().signal,
      onProgress: (state) => progress.push(state),
    });

    expect(tools.order).toEqual(["inspect", "search", "get"]);
    expect(result).toMatchObject({
      transport: "in-page",
      modelAssisted: true,
      context: {
        incident: { incidentCode: INCIDENT_CODE },
        evidence: { decisionRevision: REVISION },
      },
      procedure: {
        procedureId: PROCEDURE_ID,
        revision: PROCEDURE_REVISION,
        contentHash: PROCEDURE_HASH,
      },
      recommendation: {
        procedureId: PROCEDURE_ID,
        procedureRevision: PROCEDURE_REVISION,
        actions: [
          { stepId: PROTECT_STEP, priority: 1 },
          { stepId: VERIFY_STEP, priority: 2 },
        ],
      },
      usage: { inputTokens: 560, outputTokens: 210 },
    });
    expect(JSON.stringify(result.recommendation))
      .not.toMatch(FORBIDDEN_OPERATOR_NARRATIVE);
    expect(progress).toEqual([
      "discovering",
      "reasoning",
      "inspecting",
      "reasoning",
      "searching",
      "reasoning",
      "reading",
      "reasoning",
    ]);

    const requestedTools = bodies[0].tools as Array<{ name: string }>;
    expect(requestedTools.map((tool) => tool.name)).toEqual([
      "inspect_incident_decision_context",
      "search_operational_procedures",
      "get_operational_procedure",
    ]);
    expect(requestedTools.map((tool) => tool.name))
      .not.toContain("apply_reviewed_procedure_step");
    expect(tools.inspect).toHaveBeenCalledWith(
      { incidentId: INCIDENT_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(tools.search).toHaveBeenCalledWith(
      { incidentCode: INCIDENT_CODE },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(tools.get).toHaveBeenCalledWith(
      {
        procedureId: PROCEDURE_ID,
        procedureRevision: PROCEDURE_REVISION,
        procedureContentHash: PROCEDURE_HASH,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("builds the ordered fallback only from mandatory retrieved procedure steps", async () => {
    const tools = createTools();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await deterministicDecision(tools);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tools.order).toEqual(["inspect", "search", "get"]);
    expect(result.modelAssisted).toBe(false);
    expect(result.agentWarning).toContain("disabled");
    expect(result.recommendation.actions.map((action) => action.stepId))
      .toEqual([PROTECT_STEP, VERIFY_STEP]);
    expect(result.recommendation.procedureContentHash).toBe(PROCEDURE_HASH);
    expect(JSON.stringify(result.recommendation))
      .not.toMatch(FORBIDDEN_OPERATOR_NARRATIVE);
    expect(result.recommendation.normalStateCriteria)
      .toEqual(procedureOutput.procedure.normalStateCriteria);
  });

  it("invalidates a cached decision when the procedure catalogue sequence changes", async () => {
    const firstTools = createTools({
      ...contextOutput,
      evidence: { ...contextOutput.evidence, procedureCatalogueSequence: 1 },
    });
    const first = await deterministicDecision(firstTools, 1);
    const secondTools = createTools({
      ...contextOutput,
      evidence: { ...contextOutput.evidence, procedureCatalogueSequence: 2 },
    });
    const second = await deterministicDecision(secondTools, 2);

    expect(first.context.evidence.procedureCatalogueSequence).toBe(1);
    expect(second.context.evidence.procedureCatalogueSequence).toBe(2);
    expect(secondTools.order).toEqual(["inspect", "search", "get"]);
  });

  it("parses and bounds the current operational-response projection", async () => {
    const result = await deterministicDecision(createTools(contextWithOperationalResponse));
    const operational = result.context.operationalResponse;

    expect(operational).toBeDefined();
    if (!operational) throw new Error("Missing parsed operational response.");
    expect(operational).toMatchObject({
      revision: 11,
      incidentCase: {
        incidentId: INCIDENT_ID,
        predictedDuration: {
          basis: "mandatory-procedure-steps",
          nominalSeconds: 2_400,
          eta: { expectedAt: 1777002400000 },
        },
        milestones: [
          expect.objectContaining({
            code: "passenger-information",
            capability: "publish-passenger-information",
            status: "due",
            dueBasis: "predicted-duration",
          }),
          expect.objectContaining({ code: "connections", status: "pending" }),
        ],
      },
      lineScada: [{
        lineCode: "RER_A",
        status: "degraded",
        communicationIncidentId: INCIDENT_ID,
      }],
      dispatches: [expect.objectContaining({
        status: "proposed",
        operatorApprovalRequired: true,
        plan: expect.objectContaining({
          team: "communications",
          estimatedDuration: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
        }),
      })],
      receipts: [{
        receiptId: "RECEIPT-PAX",
        capability: "publish-passenger-information",
        appliedAt: 1776999000000,
        affectedEntityIds: ["AUBER"],
      }],
      operatorApprovalRequired: true,
    });
    expect(operational.incidentCase.insertionStationIds).toHaveLength(32);
    expect(operational.incidentCase).toMatchObject({
      protectedStationIds: ["AUBER"],
      continuityBoundaryStationIds: ["CHARLES-DE-GAULLE", "NATION"],
    });
    expect(operational.crowding).toHaveLength(16);
    expect(operational.continuityMeasures.map((measure) => measure.plan?.kind))
      .toEqual([
        undefined,
        "train-insertion",
        "shuttle-bus",
        "towing",
        "provisional-service",
        "turnback",
      ]);
    expect(operational.continuityMeasures[1].stationIds).toHaveLength(32);
    expect(operational.continuityMeasures[1].plan).toMatchObject({
      kind: "train-insertion",
      stationId: "CERGY",
      direction: 1,
      capacityDeltaPassengers: 1_305,
    });
    expect(operational.continuityMeasures[2].plan).toMatchObject({
      kind: "shuttle-bus",
      directions: [
        { direction: "outbound", fromStationId: "AUBER", toStationId: "NATION" },
        { direction: "inbound", fromStationId: "NATION", toStationId: "AUBER" },
      ],
      cycle: { phase: "outbound", direction: "outbound" },
    });
    expect(operational.continuityMeasures[4].plan).toMatchObject({
      kind: "provisional-service",
      protectedStationIds: ["AUBER"],
      turnbackStationIds: ["CHARLES-DE-GAULLE", "NATION"],
      serviceSegments: [{
        turnbackStationId: "CHARLES-DE-GAULLE",
        graphInterstationIds: ["RER_A:CERGY-CDG"],
      }],
    });
  });

  it("keeps the previous recommendation unchanged when operationalResponse is absent or null", async () => {
    const absent = await deterministicDecision(createTools());
    clearIncidentDecisionCache();
    const explicitNull = await deterministicDecision(createTools({
      ...contextOutput,
      operationalResponse: null,
    }));

    expect(absent.context).not.toHaveProperty("operationalResponse");
    expect(explicitNull.context).not.toHaveProperty("operationalResponse");
    expect(absent.recommendation.actions.map((action) => action.stepId))
      .toEqual([PROTECT_STEP, VERIFY_STEP]);
    expect(explicitNull.recommendation.actions).toEqual(absent.recommendation.actions);
  });

  it("restores persisted authority evidence from the procedure execution context", async () => {
    const authorityRecord = {
      stepId: VERIFY_STEP,
      receiptId: "PROC-ACK-INC-RER-A-01-VERIFY",
      operatorId: "operator-evidence-test",
      recordedAt: 1777000000000,
      operatorEvidenceReference: "POL-RERA-20260830-117",
      evidenceKind: "police-clearance",
    };
    const result = await deterministicDecision(createTools({
      ...contextOutput,
      incident: {
        ...contextOutput.incident,
        procedureExecution: {
          managementState: "protected",
          procedureId: PROCEDURE_ID,
          procedureRevision: PROCEDURE_REVISION,
          completedStepIds: [VERIFY_STEP],
          stepRecords: [authorityRecord],
          nextRequiredStepId: null,
          recoveryStartedAt: null,
        },
      },
    }));

    expect(result.context.incident.procedureExecution.stepRecords)
      .toEqual([authorityRecord]);
  });

  it("adds a due optional document step locally without removing the mandatory next step and can apply it", async () => {
    const tools = createTools(contextWithOperationalResponse);
    const decision = await deterministicDecision(tools);

    expect(decision.modelAssisted).toBe(false);
    expect(decision.recommendation.actions.map((action) => action.stepId))
      .toEqual([PROTECT_STEP, VERIFY_STEP, PASSENGER_INFO_STEP]);
    expect(decision.recommendation.actions[0].stepId).toBe(PROTECT_STEP);

    await applyIncidentProcedureStep({
      package: decision,
      stepId: PASSENGER_INFO_STEP,
      inPageTools: tools.definitions,
      signal: new AbortController().signal,
    });

    expect(tools.apply).toHaveBeenCalledWith(expect.objectContaining({
      incidentId: INCIDENT_ID,
      procedureId: PROCEDURE_ID,
      stepId: PASSENGER_INFO_STEP,
      expectedDecisionRevision: REVISION,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("adds the same due optional document step to a valid model-assisted recommendation", async () => {
    const tools = createTools(contextWithOperationalResponse);
    installModel(modelRecommendation);

    const result = await analyzeIncidentDecision({
      incidentId: INCIDENT_ID,
      decisionRevision: REVISION,
      expectedToolNames: tools.definitions.map((tool) => tool.name),
      inPageTools: tools.definitions,
      modelEnabled: true,
      signal: new AbortController().signal,
    });

    expect(result.modelAssisted).toBe(true);
    expect(result.recommendation.actions.map((action) => action.stepId))
      .toEqual([PROTECT_STEP, VERIFY_STEP, PASSENGER_INFO_STEP]);
    expect(result.recommendation.actions[0].stepId).toBe(PROTECT_STEP);
  });

  it("does not create an operational option when the mapped step is outside the retrieved procedure", async () => {
    const procedureWithoutOptionalStep = {
      ...procedureOutput,
      procedure: {
        ...procedureOutput.procedure,
        steps: procedureOutput.procedure.steps.filter(
          (step) => step.stepId !== PASSENGER_INFO_STEP,
        ),
      },
    };
    const tools = createTools(
      contextWithOperationalResponse,
      procedureWithoutOptionalStep,
    );
    const decision = await deterministicDecision(tools);

    expect(decision.recommendation.actions.map((action) => action.stepId))
      .toEqual([PROTECT_STEP, VERIFY_STEP]);
    await expect(applyIncidentProcedureStep({
      package: decision,
      stepId: PASSENGER_INFO_STEP,
      inPageTools: tools.definitions,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "unknown_procedure_step",
    });
    expect(tools.apply).not.toHaveBeenCalled();
  });

  it("rejects a step outside the retrieved procedure plan before apply", async () => {
    const tools = createTools();
    const decision = await deterministicDecision(tools);

    await expect(applyIncidentProcedureStep({
      package: decision,
      stepId: "PROC-INVENTED-S99",
      inPageTools: tools.definitions,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "IncidentDecisionAgentError",
      code: "unknown_procedure_step",
    });
    expect(tools.apply).not.toHaveBeenCalled();
  });

  it("applies a cited step with the exact incident, procedure, hash and revision guard", async () => {
    const tools = createTools();
    const decision = await deterministicDecision(tools);
    const controller = new AbortController();

    const result = await applyIncidentProcedureStep({
      package: decision,
      stepId: PROTECT_STEP,
      inPageTools: tools.definitions,
      signal: controller.signal,
    });

    expect(tools.apply).toHaveBeenCalledWith({
      incidentId: INCIDENT_ID,
      procedureId: PROCEDURE_ID,
      procedureRevision: PROCEDURE_REVISION,
      procedureContentHash: PROCEDURE_HASH,
      stepId: PROTECT_STEP,
      expectedDecisionRevision: REVISION,
      confirmSimulation: true,
    }, { signal: controller.signal });
    expect(result).toMatchObject({
      status: "applied_to_simulation",
      stepId: PROTECT_STEP,
      decisionRevision: REVISION + 1,
    });
    expect(tools.order).toEqual(["inspect", "search", "get", "apply"]);
  });

  it("forwards an explicit operator authority reference to the reviewed WebMCP write", async () => {
    const tools = createTools();
    const decision = await deterministicDecision(tools);
    const operatorEvidenceReference = "POL-RERA-20260830-117";

    await applyIncidentProcedureStep({
      package: decision,
      stepId: PROTECT_STEP,
      operatorEvidenceReference,
      inPageTools: tools.definitions,
      signal: new AbortController().signal,
    });

    expect(tools.apply).toHaveBeenCalledWith(expect.objectContaining({
      stepId: PROTECT_STEP,
      operatorEvidenceReference,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("does not accept a model citation for a step absent from the retrieved document", async () => {
    const tools = createTools();
    installModel({
      ...modelRecommendation,
      actions: [{
        stepId: "PROC-INVENTED-S99",
        priority: 1,
        rationale: "Invented action.",
        operatorChecks: ["Invented check."],
      }],
    });

    const result = await analyzeIncidentDecision({
      incidentId: INCIDENT_ID,
      decisionRevision: REVISION,
      expectedToolNames: tools.definitions.map((tool) => tool.name),
      inPageTools: tools.definitions,
      modelEnabled: true,
      signal: new AbortController().signal,
    });

    expect(result.modelAssisted).toBe(false);
    expect(result.agentWarning).toContain("outside the retrieved procedure");
    expect(result.recommendation.actions.map((action) => action.stepId))
      .toEqual([PROTECT_STEP, VERIFY_STEP]);
    expect(result.recommendation.actions.map((action) => action.stepId))
      .not.toContain("PROC-INVENTED-S99");
    expect(tools.order).toEqual([
      "inspect", "search", "get",
      "inspect", "search", "get",
    ]);
  });
});
