import {
  discoverPageWebMcpTools,
  executeNativeWebMcpTool,
  NativeWebMcpError,
  type AgentToolDefinition,
  type NativeWebMcpCatalog,
  type WebMcpTransport,
} from "./nativeWebMcp";
import type {
  ContinuityMeasureKind,
  ContinuityMeasurePlan,
  MaintenancePlan,
  OperationalDurationRange,
  OperationalEtaRange,
  OperationalResponseCapability,
  OperationalResponseMilestone,
  ProcedureDurationPrediction,
} from "../operations/operationalResponse";

const READ_TOOLS = [
  "inspect_incident_decision_context",
  "search_operational_procedures",
  "get_operational_procedure",
] as const;
const APPLY_TOOL = "apply_reviewed_procedure_step";
const MAX_ROUNDS = 9;

export type IncidentDecisionProgress =
  | "discovering"
  | "inspecting"
  | "searching"
  | "reading"
  | "reasoning";

export interface IncidentDecisionContext {
  status: "context_ready";
  incident: {
    id: string;
    incidentCode: string;
    title: string;
    type: string;
    effect: string;
    severity: string;
    status: string;
    occurrenceTime: string;
    lineCodes: string[];
    target: { type: string; id: string };
    affectedSegmentIds: string[];
    affectedStationCodes: string[];
    impactedTrainIds: string[];
    procedureExecution: {
      managementState: string;
      procedureId: string | null;
      procedureRevision: string | null;
      completedStepIds: string[];
      stepRecords: Array<{
        stepId: string;
        receiptId: string;
        operatorId: string;
        recordedAt: number;
        operatorEvidenceReference: string | null;
        evidenceKind: "works-handback" | "police-clearance" | null;
      }>;
      nextRequiredStepId: string | null;
      recoveryStartedAt: number | null;
    };
  };
  evidence: {
    timestamp: number;
    telemetryRevision: number;
    decisionRevision: number;
    scenarioId: string;
    procedureCatalogueSequence: number;
  };
  impact: {
    impactedTrainCount: number;
    passengersOnImpactedTrains: number;
    worstDelaySeconds: number;
    activeRestrictionCount: number;
    affectedLineCodes: string[];
    affectedSegmentIds: string[];
  };
  operationalResponse?: IncidentOperationalResponse;
}

export interface OperationalProcedureMatch {
  procedureId: string;
  title: string;
  revision: string;
  contentHash: string;
}

export interface OperationalProcedureSearch {
  status: "procedures_found";
  incidentCode: string;
  catalogRevision: string;
  matches: OperationalProcedureMatch[];
  nonMutating: true;
}

export type ProcedureCommand =
  | "acknowledge"
  | "protect-and-hold"
  | "degraded-operation"
  | "close-incident"
  | "publish-passenger-information"
  | "protect-connections"
  | "dispatch-maintenance"
  | "activate-provisional-service"
  | "activate-turnbacks"
  | "activate-shuttle-bus"
  | "insert-train"
  | "start-towing";

const PROCEDURE_COMMANDS: readonly ProcedureCommand[] = [
  "acknowledge", "protect-and-hold", "degraded-operation", "close-incident",
  "publish-passenger-information", "protect-connections", "dispatch-maintenance",
  "activate-provisional-service", "activate-turnbacks", "activate-shuttle-bus",
  "insert-train", "start-towing",
];


const MAX_OPERATIONAL_ITEMS = 16;
const MAX_OPERATIONAL_REFERENCES = 32;
const MAX_OPERATIONAL_DURATION_SECONDS = 365 * 24 * 60 * 60;

const MILESTONE_CAPABILITY_BY_CODE = {
  "passenger-information": "publish-passenger-information",
  connections: "protect-connections",
  "provisional-service": "activate-provisional-service",
  turnbacks: "activate-turnbacks",
  "shuttle-bus": "activate-shuttle-bus",
} as const satisfies Record<OperationalResponseMilestone["code"], OperationalResponseCapability>;

const CONTINUITY_CAPABILITY_BY_KIND = {
  "provisional-service": "activate-provisional-service",
  turnback: "activate-turnbacks",
  "shuttle-bus": "activate-shuttle-bus",
  "train-insertion": "insert-train",
  towing: "start-towing",
  "passenger-information": "publish-passenger-information",
  "connection-protection": "protect-connections",
} as const satisfies Record<ContinuityMeasureKind, OperationalResponseCapability>;

export interface IncidentOperationalResponse {
  revision: number;
  incidentCase: {
    incidentId: string;
    incidentCode: string;
    lineCodes: string[];
    openedAt: number;
    status: "active" | "resolved";
    protectedStationIds?: string[];
    continuityBoundaryStationIds?: string[];
    affectedStationIds: string[];
    affectedInterstationIds: string[];
    connectionIds: string[];
    terminalStationIds: string[];
    insertionStationIds: string[];
    predictedDuration: ProcedureDurationPrediction | null;
    milestones: OperationalResponseMilestone[];
  };
  lineScada: Array<{
    lineCode: string;
    status: "nominal" | "degraded" | "unavailable";
    lastHeartbeatAt: number;
    communicationIncidentId: string | null;
  }>;
  dispatches: Array<{
    dispatchId: string;
    lineCode: string;
    targetType: string;
    targetId: string;
    status: "proposed" | "dispatched" | "completed";
    proposedAt: number;
    dispatchedAt: number | null;
    completedAt: number | null;
    receiptId: string | null;
    plan: MaintenancePlan;
    operatorApprovalRequired: boolean;
  }>;
  continuityMeasures: Array<{
    measureId: string;
    kind: ContinuityMeasureKind;
    lineCodes: string[];
    status: "proposed" | "active" | "completed";
    proposedAt: number;
    approvedAt: number | null;
    approvedBy: string | null;
    completedAt: number | null;
    stationIds: string[];
    connectionIds: string[];
    receiptId: string | null;
    directions: Array<"outbound" | "inbound">;
    plan: ContinuityMeasurePlan | null;
    operatorApprovalRequired: boolean;
  }>;
  crowding: Array<{
    stationId: string;
    lineCodes: string[];
    estimatedPassengers: number;
    level: "normal" | "elevated" | "high" | "critical";
    updatedAt: number;
  }>;
  receipts: Array<{
    receiptId: string;
    capability: OperationalResponseCapability;
    appliedAt: number;
    affectedEntityIds: string[];
  }>;
  operatorApprovalRequired: true;
}

export interface OperationalProcedureStep {
  stepId: string;
  order: number;
  phase: string;
  title: string;
  instruction: string;
  rationale: string;
  mandatory: boolean;
  responsibleRole: string;
  evidenceRequired: string[];
  requiredEvidenceReferenceKind?: "works-handback" | "police-clearance";
  durationRangeSeconds: { minSeconds: number; nominalSeconds: number; maxSeconds: number };
  capability?: {
    command: ProcedureCommand;
    requiresOperatorConfirmation: true;
    reversible: boolean;
  };
}

export interface OperationalProcedure {
  procedureId: string;
  title: string;
  revision: string;
  contentHash: string;
  documentRef: string;
  steps: OperationalProcedureStep[];
  normalStateCriteria: string[];
}

export interface IncidentProcedureAction {
  stepId: string;
  priority: number;
  rationale: string;
  operatorChecks: string[];
}

export interface IncidentAgentRecommendation {
  incidentId: string;
  incidentCode: string;
  basedOnDecisionRevision: number;
  procedureId: string;
  procedureRevision: string;
  procedureContentHash: string;
  situationSummary: string;
  actions: IncidentProcedureAction[];
  risks: string[];
  normalStateCriteria: string[];
}

export interface IncidentDecisionPackage {
  incidentId: string;
  transport: WebMcpTransport;
  context: IncidentDecisionContext;
  search: OperationalProcedureSearch;
  procedure: OperationalProcedure;
  recommendation: IncidentAgentRecommendation;
  modelAssisted: boolean;
  agentWarning?: string;
  usage?: { inputTokens: number; outputTokens: number };
  generatedAt: number;
}

interface AgentCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

type AgentTurn =
  | { status: "tool_calls"; runId: string; calls: AgentCall[] }
  | {
      status: "completed";
      runId: string;
      recommendation?: unknown;
      usage?: { inputTokens: number; outputTokens: number };
    };

export class IncidentDecisionAgentError extends Error {
  constructor(
    message: string,
    readonly code = "incident_decision_failed",
    readonly status?: number,
  ) {
    super(message);
    this.name = "IncidentDecisionAgentError";
  }
}

const decisionCache = new Map<string, IncidentDecisionPackage>();

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IncidentDecisionAgentError(label + " is not a JSON object.", "invalid_agent_result");
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string, maximum = 900): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new IncidentDecisionAgentError(label + " is missing.", "invalid_agent_result");
  }
  return value.trim().slice(0, maximum);
}

function numeric(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IncidentDecisionAgentError(label + " is invalid.", "invalid_agent_result");
  }
  return value;
}

function textList(value: unknown, label: string, maximum = 16): string[] {
  if (!Array.isArray(value)) {
    throw new IncidentDecisionAgentError(label + " is not an array.", "invalid_agent_result");
  }
  return value.slice(0, maximum).map((item, index) =>
    textValue(item, label + "[" + index + "]", 420)
  );
}


function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  const parsed = textValue(value, label, 80);
  if (!allowed.includes(parsed as T)) {
    throw new IncidentDecisionAgentError(label + " is unsupported.", "invalid_agent_result");
  }
  return parsed as T;
}

function boundedNonNegativeNumber(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = numeric(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new IncidentDecisionAgentError(label + " is outside its bounds.", "invalid_agent_result");
  }
  return parsed;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null || value === undefined
    ? null
    : boundedNonNegativeNumber(value, label);
}

function nullableText(value: unknown, label: string, maximum = 160): string | null {
  return value === null || value === undefined
    ? null
    : textValue(value, label, maximum);
}

function parseDurationRange(value: unknown, label: string): OperationalDurationRange {
  const range = object(value, label);
  const result = {
    minSeconds: boundedNonNegativeNumber(
      range.minSeconds,
      label + ".minSeconds",
      MAX_OPERATIONAL_DURATION_SECONDS,
    ),
    nominalSeconds: boundedNonNegativeNumber(
      range.nominalSeconds,
      label + ".nominalSeconds",
      MAX_OPERATIONAL_DURATION_SECONDS,
    ),
    maxSeconds: boundedNonNegativeNumber(
      range.maxSeconds,
      label + ".maxSeconds",
      MAX_OPERATIONAL_DURATION_SECONDS,
    ),
  };
  if (
    result.minSeconds > result.nominalSeconds ||
    result.nominalSeconds > result.maxSeconds
  ) {
    throw new IncidentDecisionAgentError(
      label + " has an invalid duration order.",
      "invalid_agent_result",
    );
  }
  return result;
}

function parseEta(value: unknown, label: string): OperationalEtaRange {
  const eta = object(value, label);
  const result = {
    earliestAt: boundedNonNegativeNumber(eta.earliestAt, label + ".earliestAt"),
    expectedAt: boundedNonNegativeNumber(eta.expectedAt, label + ".expectedAt"),
    latestAt: boundedNonNegativeNumber(eta.latestAt, label + ".latestAt"),
  };
  if (result.earliestAt > result.expectedAt || result.expectedAt > result.latestAt) {
    throw new IncidentDecisionAgentError(
      label + " has an invalid ETA order.",
      "invalid_agent_result",
    );
  }
  return result;
}

function parseDurationPrediction(
  value: unknown,
  label: string,
): ProcedureDurationPrediction | null {
  if (value === null || value === undefined) return null;
  const prediction = object(value, label);
  if (prediction.basis !== "mandatory-procedure-steps") {
    throw new IncidentDecisionAgentError(label + ".basis is unsupported.", "invalid_agent_result");
  }
  return {
    ...parseDurationRange(prediction, label),
    basis: "mandatory-procedure-steps",
    procedureId: textValue(prediction.procedureId, label + ".procedureId", 100),
    procedureRevision: textValue(
      prediction.procedureRevision,
      label + ".procedureRevision",
      80,
    ),
    calculatedAt: boundedNonNegativeNumber(
      prediction.calculatedAt,
      label + ".calculatedAt",
    ),
    eta: parseEta(prediction.eta, label + ".eta"),
  };
}

const OPERATIONAL_CAPABILITIES: readonly OperationalResponseCapability[] = [
  "publish-passenger-information",
  "protect-connections",
  "dispatch-maintenance",
  "activate-provisional-service",
  "activate-turnbacks",
  "activate-shuttle-bus",
  "insert-train",
  "start-towing",
];

function parseMilestone(value: unknown, index: number): OperationalResponseMilestone {
  const label = "operationalResponse.incidentCase.milestones[" + index + "]";
  const milestone = object(value, label);
  const code = enumValue(
    milestone.code,
    Object.keys(MILESTONE_CAPABILITY_BY_CODE) as OperationalResponseMilestone["code"][],
    label + ".code",
  );
  const capability = enumValue(
    milestone.capability,
    OPERATIONAL_CAPABILITIES,
    label + ".capability",
  );
  if (capability !== MILESTONE_CAPABILITY_BY_CODE[code]) {
    throw new IncidentDecisionAgentError(
      label + " does not match the controlled capability mapping.",
      "invalid_agent_result",
    );
  }
  const dueBasis = milestone.dueBasis === null || milestone.dueBasis === undefined
    ? null
    : enumValue(
        milestone.dueBasis,
        ["predicted-duration", "elapsed-duration"] as const,
        label + ".dueBasis",
      );
  return {
    code,
    thresholdSeconds: boundedNonNegativeNumber(
      milestone.thresholdSeconds,
      label + ".thresholdSeconds",
      MAX_OPERATIONAL_DURATION_SECONDS,
    ),
    capability,
    status: enumValue(
      milestone.status,
      ["pending", "due", "applied"] as const,
      label + ".status",
    ),
    dueAt: nullableNumber(milestone.dueAt, label + ".dueAt"),
    dueBasis,
    appliedAt: nullableNumber(milestone.appliedAt, label + ".appliedAt"),
    receiptId: nullableText(milestone.receiptId, label + ".receiptId", 140),
  };
}

function parseMaintenancePlan(value: unknown, label: string): MaintenancePlan {
  const plan = object(value, label);
  return {
    team: enumValue(
      plan.team,
      ["communications", "infrastructure", "traction-power", "rolling-stock"] as const,
      label + ".team",
    ),
    targetStationIds: textList(
      plan.targetStationIds,
      label + ".targetStationIds",
      MAX_OPERATIONAL_REFERENCES,
    ),
    estimatedDuration: parseDurationRange(
      plan.estimatedDuration,
      label + ".estimatedDuration",
    ),
    eta: parseEta(plan.eta, label + ".eta"),
    basisProcedureId: nullableText(
      plan.basisProcedureId,
      label + ".basisProcedureId",
      100,
    ),
    basisProcedureRevision: nullableText(
      plan.basisProcedureRevision,
      label + ".basisProcedureRevision",
      80,
    ),
  };
}

function parseServiceLeg(value: unknown, label: string) {
  const leg = object(value, label);
  return {
    direction: enumValue(
      leg.direction,
      ["outbound", "inbound"] as const,
      label + ".direction",
    ),
    fromStationId: textValue(leg.fromStationId, label + ".fromStationId", 140),
    toStationId: textValue(leg.toStationId, label + ".toStationId", 140),
  };
}

function parseServiceLegs(value: unknown, label: string, maximum = 2) {
  if (!Array.isArray(value)) {
    throw new IncidentDecisionAgentError(label + " is not an array.", "invalid_agent_result");
  }
  return value.slice(0, maximum).map((item, index) =>
    parseServiceLeg(item, label + "[" + index + "]")
  );
}

function parseStationPair(value: unknown, label: string): [string, string] {
  const pair = textList(value, label, 2);
  if (pair.length !== 2) {
    throw new IncidentDecisionAgentError(label + " must contain two stations.", "invalid_agent_result");
  }
  return [pair[0], pair[1]];
}

function parseOptionalTextList(
  value: unknown,
  label: string,
  maximum = MAX_OPERATIONAL_REFERENCES,
): string[] | undefined {
  return value === undefined ? undefined : textList(value, label, maximum);
}

function parseProvisionalServiceSegments(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new IncidentDecisionAgentError(label + " is not an array.", "invalid_agent_result");
  }
  return value.slice(0, MAX_OPERATIONAL_ITEMS).map((entry, index) => {
    const itemLabel = label + "[" + index + "]";
    const segment = object(entry, itemLabel);
    const directions = parseServiceLegs(segment.directions, itemLabel + ".directions");
    if (directions.length !== 2) {
      throw new IncidentDecisionAgentError(
        itemLabel + ".directions must contain two legs.",
        "invalid_agent_result",
      );
    }
    return {
      terminalStationIds: parseStationPair(
        segment.terminalStationIds,
        itemLabel + ".terminalStationIds",
      ),
      turnbackStationId: textValue(
        segment.turnbackStationId,
        itemLabel + ".turnbackStationId",
        140,
      ),
      directions: [directions[0], directions[1]] as const,
      graphInterstationIds: textList(
        segment.graphInterstationIds,
        itemLabel + ".graphInterstationIds",
        MAX_OPERATIONAL_REFERENCES,
      ),
    };
  });
}

function parseContinuityPlan(
  value: unknown,
  measureKind: ContinuityMeasureKind,
  label: string,
): ContinuityMeasurePlan | null {
  if (value === null || value === undefined) return null;
  const plan = object(value, label);
  const kind = enumValue(
    plan.kind,
    ["shuttle-bus", "train-insertion", "towing", "provisional-service", "turnback"] as const,
    label + ".kind",
  );
  if (kind !== measureKind) {
    throw new IncidentDecisionAgentError(
      label + " does not match its continuity measure.",
      "invalid_agent_result",
    );
  }
  if (kind === "train-insertion") {
    const direction = numeric(plan.direction, label + ".direction");
    if (direction !== 1 && direction !== -1) {
      throw new IncidentDecisionAgentError(label + ".direction is invalid.", "invalid_agent_result");
    }
    return {
      kind,
      stationId: textValue(plan.stationId, label + ".stationId", 140),
      destinationStationId: textValue(
        plan.destinationStationId,
        label + ".destinationStationId",
        140,
      ),
      direction,
      capacityDeltaPassengers: boundedNonNegativeNumber(
        plan.capacityDeltaPassengers,
        label + ".capacityDeltaPassengers",
        100_000,
      ),
    };
  }
  if (kind === "towing") {
    if (plan.direction !== "toward-receiving-terminal") {
      throw new IncidentDecisionAgentError(label + ".direction is invalid.", "invalid_agent_result");
    }
    return {
      kind,
      receivingTerminalStationId: textValue(
        plan.receivingTerminalStationId,
        label + ".receivingTerminalStationId",
        140,
      ),
      direction: "toward-receiving-terminal",
      estimatedDuration: parseDurationRange(
        plan.estimatedDuration,
        label + ".estimatedDuration",
      ),
      eta: parseEta(plan.eta, label + ".eta"),
      basisProcedureId: nullableText(
        plan.basisProcedureId,
        label + ".basisProcedureId",
        100,
      ),
      basisProcedureRevision: nullableText(
        plan.basisProcedureRevision,
        label + ".basisProcedureRevision",
        80,
      ),
    };
  }
  if (kind === "provisional-service") {
    const directions = parseServiceLegs(plan.directions, label + ".directions");
    if (directions.length !== 2) {
      throw new IncidentDecisionAgentError(
        label + ".directions must contain two legs.",
        "invalid_agent_result",
      );
    }
    const protectedStationIds = parseOptionalTextList(
      plan.protectedStationIds,
      label + ".protectedStationIds",
    );
    const turnbackStationIds = parseOptionalTextList(
      plan.turnbackStationIds,
      label + ".turnbackStationIds",
    );
    const serviceSegments = parseProvisionalServiceSegments(
      plan.serviceSegments,
      label + ".serviceSegments",
    );
    return {
      kind,
      terminusStationIds: parseStationPair(
        plan.terminusStationIds,
        label + ".terminusStationIds",
      ),
      directions: [directions[0], directions[1]],
      targetHeadwaySeconds: boundedNonNegativeNumber(
        plan.targetHeadwaySeconds,
        label + ".targetHeadwaySeconds",
        MAX_OPERATIONAL_DURATION_SECONDS,
      ),
      ...(protectedStationIds ? { protectedStationIds } : {}),
      ...(turnbackStationIds ? { turnbackStationIds } : {}),
      ...(serviceSegments ? { serviceSegments } : {}),
    };
  }
  if (kind === "turnback") {
    const protectedStationIds = parseOptionalTextList(
      plan.protectedStationIds,
      label + ".protectedStationIds",
    );
    const serviceSegments = parseProvisionalServiceSegments(
      plan.serviceSegments,
      label + ".serviceSegments",
    );
    return {
      kind,
      turnbackStationIds: textList(
        plan.turnbackStationIds,
        label + ".turnbackStationIds",
        MAX_OPERATIONAL_REFERENCES,
      ),
      directions: parseServiceLegs(
        plan.directions,
        label + ".directions",
        MAX_OPERATIONAL_ITEMS,
      ),
      ...(protectedStationIds ? { protectedStationIds } : {}),
      ...(serviceSegments ? { serviceSegments } : {}),
    };
  }
  const directions = parseServiceLegs(plan.directions, label + ".directions");
  if (directions.length !== 2) {
    throw new IncidentDecisionAgentError(
      label + ".directions must contain two legs.",
      "invalid_agent_result",
    );
  }
  const cycle = object(plan.cycle, label + ".cycle");
  const cycleDirection = cycle.direction === null || cycle.direction === undefined
    ? null
    : enumValue(
        cycle.direction,
        ["outbound", "inbound"] as const,
        label + ".cycle.direction",
      );
  return {
    kind,
    terminusStationIds: parseStationPair(
      plan.terminusStationIds,
      label + ".terminusStationIds",
    ),
    directions: [directions[0], directions[1]],
    fleetSize: boundedNonNegativeNumber(plan.fleetSize, label + ".fleetSize", 1_000),
    headwaySeconds: boundedNonNegativeNumber(
      plan.headwaySeconds,
      label + ".headwaySeconds",
      MAX_OPERATIONAL_DURATION_SECONDS,
    ),
    vehicleCapacityPassengers: boundedNonNegativeNumber(
      plan.vehicleCapacityPassengers,
      label + ".vehicleCapacityPassengers",
      10_000,
    ),
    capacityPerHour: boundedNonNegativeNumber(
      plan.capacityPerHour,
      label + ".capacityPerHour",
      1_000_000,
    ),
    routeTravelSeconds: boundedNonNegativeNumber(
      plan.routeTravelSeconds,
      label + ".routeTravelSeconds",
      MAX_OPERATIONAL_DURATION_SECONDS,
    ),
    layoverSeconds: boundedNonNegativeNumber(
      plan.layoverSeconds,
      label + ".layoverSeconds",
      MAX_OPERATIONAL_DURATION_SECONDS,
    ),
    graphInterstationIds: textList(
      plan.graphInterstationIds,
      label + ".graphInterstationIds",
      MAX_OPERATIONAL_REFERENCES,
    ),
    cycle: {
      phase: enumValue(
        cycle.phase,
        ["awaiting-approval", "outbound", "at-destination", "inbound", "at-origin"] as const,
        label + ".cycle.phase",
      ),
      direction: cycleDirection,
      atStationId: nullableText(
        cycle.atStationId,
        label + ".cycle.atStationId",
        140,
      ),
      cycleIndex: boundedNonNegativeNumber(
        cycle.cycleIndex,
        label + ".cycle.cycleIndex",
        1_000_000,
      ),
      phaseStartedAt: boundedNonNegativeNumber(
        cycle.phaseStartedAt,
        label + ".cycle.phaseStartedAt",
      ),
      nextTransitionAt: nullableNumber(
        cycle.nextTransitionAt,
        label + ".cycle.nextTransitionAt",
      ),
    },
  };
}

function parseOperationalResponse(
  value: unknown,
  incidentId: string,
  incidentCode: string,
): IncidentOperationalResponse | undefined {
  if (value === null || value === undefined) return undefined;
  const root = object(value, "operationalResponse");
  if (root.operatorApprovalRequired !== true) {
    throw new IncidentDecisionAgentError(
      "operationalResponse must preserve operator approval.",
      "invalid_agent_result",
    );
  }
  const incidentCase = object(
    root.incidentCase,
    "operationalResponse.incidentCase",
  );
  if (incidentCase.incidentId !== incidentId || incidentCase.incidentCode !== incidentCode) {
    throw new IncidentDecisionAgentError(
      "operationalResponse is bound to a different incident.",
      "context_mismatch",
    );
  }

  const lineScada = Array.isArray(root.lineScada)
    ? root.lineScada.slice(0, MAX_OPERATIONAL_ITEMS).map((entry, index) => {
        const label = "operationalResponse.lineScada[" + index + "]";
        const item = object(entry, label);
        return {
          lineCode: textValue(item.lineCode, label + ".lineCode", 40),
          status: enumValue(
            item.status,
            ["nominal", "degraded", "unavailable"] as const,
            label + ".status",
          ),
          lastHeartbeatAt: boundedNonNegativeNumber(
            item.lastHeartbeatAt,
            label + ".lastHeartbeatAt",
          ),
          communicationIncidentId: nullableText(
            item.communicationIncidentId,
            label + ".communicationIncidentId",
            140,
          ),
        };
      })
    : (() => {
        throw new IncidentDecisionAgentError(
          "operationalResponse.lineScada is not an array.",
          "invalid_agent_result",
        );
      })();

  const dispatches = Array.isArray(root.dispatches)
    ? root.dispatches.slice(0, MAX_OPERATIONAL_ITEMS).map((entry, index) => {
        const label = "operationalResponse.dispatches[" + index + "]";
        const item = object(entry, label);
        const status = enumValue(
          item.status,
          ["proposed", "dispatched", "completed"] as const,
          label + ".status",
        );
        const operatorApprovalRequired = item.operatorApprovalRequired === true;
        if (operatorApprovalRequired !== (status === "proposed")) {
          throw new IncidentDecisionAgentError(
            label + " has an inconsistent approval state.",
            "invalid_agent_result",
          );
        }
        return {
          dispatchId: textValue(item.dispatchId, label + ".dispatchId", 140),
          lineCode: textValue(item.lineCode, label + ".lineCode", 40),
          targetType: textValue(item.targetType, label + ".targetType", 80),
          targetId: textValue(item.targetId, label + ".targetId", 160),
          status,
          proposedAt: boundedNonNegativeNumber(item.proposedAt, label + ".proposedAt"),
          dispatchedAt: nullableNumber(item.dispatchedAt, label + ".dispatchedAt"),
          completedAt: nullableNumber(item.completedAt, label + ".completedAt"),
          receiptId: nullableText(item.receiptId, label + ".receiptId", 140),
          plan: parseMaintenancePlan(item.plan, label + ".plan"),
          operatorApprovalRequired,
        };
      })
    : (() => {
        throw new IncidentDecisionAgentError(
          "operationalResponse.dispatches is not an array.",
          "invalid_agent_result",
        );
      })();

  const continuityMeasures = Array.isArray(root.continuityMeasures)
    ? root.continuityMeasures.slice(0, MAX_OPERATIONAL_ITEMS).map((entry, index) => {
        const label = "operationalResponse.continuityMeasures[" + index + "]";
        const item = object(entry, label);
        const kind = enumValue(
          item.kind,
          Object.keys(CONTINUITY_CAPABILITY_BY_KIND) as ContinuityMeasureKind[],
          label + ".kind",
        );
        const status = enumValue(
          item.status,
          ["proposed", "active", "completed"] as const,
          label + ".status",
        );
        const operatorApprovalRequired = item.operatorApprovalRequired === true;
        if (operatorApprovalRequired !== (status === "proposed")) {
          throw new IncidentDecisionAgentError(
            label + " has an inconsistent approval state.",
            "invalid_agent_result",
          );
        }
        return {
          measureId: textValue(item.measureId, label + ".measureId", 160),
          kind,
          lineCodes: textList(
            item.lineCodes,
            label + ".lineCodes",
            MAX_OPERATIONAL_ITEMS,
          ),
          status,
          proposedAt: boundedNonNegativeNumber(item.proposedAt, label + ".proposedAt"),
          approvedAt: nullableNumber(item.approvedAt, label + ".approvedAt"),
          approvedBy: nullableText(item.approvedBy, label + ".approvedBy", 140),
          completedAt: nullableNumber(item.completedAt, label + ".completedAt"),
          stationIds: textList(
            item.stationIds,
            label + ".stationIds",
            MAX_OPERATIONAL_REFERENCES,
          ),
          connectionIds: textList(
            item.connectionIds,
            label + ".connectionIds",
            MAX_OPERATIONAL_REFERENCES,
          ),
          receiptId: nullableText(item.receiptId, label + ".receiptId", 140),
          directions: Array.isArray(item.directions)
            ? item.directions.slice(0, 2).map((direction, directionIndex) =>
                enumValue(
                  direction,
                  ["outbound", "inbound"] as const,
                  label + ".directions[" + directionIndex + "]",
                )
              )
            : (() => {
                throw new IncidentDecisionAgentError(
                  label + ".directions is not an array.",
                  "invalid_agent_result",
                );
              })(),
          plan: parseContinuityPlan(item.plan, kind, label + ".plan"),
          operatorApprovalRequired,
        };
      })
    : (() => {
        throw new IncidentDecisionAgentError(
          "operationalResponse.continuityMeasures is not an array.",
          "invalid_agent_result",
        );
      })();

  const crowding = Array.isArray(root.crowding)
    ? root.crowding.slice(0, MAX_OPERATIONAL_ITEMS).map((entry, index) => {
        const label = "operationalResponse.crowding[" + index + "]";
        const item = object(entry, label);
        return {
          stationId: textValue(item.stationId, label + ".stationId", 140),
          lineCodes: textList(
            item.lineCodes,
            label + ".lineCodes",
            MAX_OPERATIONAL_ITEMS,
          ),
          estimatedPassengers: boundedNonNegativeNumber(
            item.estimatedPassengers,
            label + ".estimatedPassengers",
            10_000_000,
          ),
          level: enumValue(
            item.level,
            ["normal", "elevated", "high", "critical"] as const,
            label + ".level",
          ),
          updatedAt: boundedNonNegativeNumber(item.updatedAt, label + ".updatedAt"),
        };
      })
    : (() => {
        throw new IncidentDecisionAgentError(
          "operationalResponse.crowding is not an array.",
          "invalid_agent_result",
        );
      })();

  const receipts = Array.isArray(root.receipts)
    ? root.receipts.slice(0, MAX_OPERATIONAL_ITEMS).map((entry, index) => {
        const label = "operationalResponse.receipts[" + index + "]";
        const item = object(entry, label);
        return {
          receiptId: textValue(item.receiptId, label + ".receiptId", 140),
          capability: enumValue(
            item.capability,
            OPERATIONAL_CAPABILITIES,
            label + ".capability",
          ),
          appliedAt: boundedNonNegativeNumber(item.appliedAt, label + ".appliedAt"),
          affectedEntityIds: textList(
            item.affectedEntityIds,
            label + ".affectedEntityIds",
            MAX_OPERATIONAL_REFERENCES,
          ),
        };
      })
    : (() => {
        throw new IncidentDecisionAgentError(
          "operationalResponse.receipts is not an array.",
          "invalid_agent_result",
        );
      })();

  const milestones = Array.isArray(incidentCase.milestones)
    ? incidentCase.milestones.slice(0, 8).map(parseMilestone)
    : (() => {
        throw new IncidentDecisionAgentError(
          "operationalResponse.incidentCase.milestones is not an array.",
          "invalid_agent_result",
        );
      })();

  return {
    revision: boundedNonNegativeNumber(root.revision, "operationalResponse.revision"),
    incidentCase: {
      incidentId,
      incidentCode,
      lineCodes: textList(
        incidentCase.lineCodes,
        "operationalResponse.incidentCase.lineCodes",
        MAX_OPERATIONAL_ITEMS,
      ),
      openedAt: boundedNonNegativeNumber(
        incidentCase.openedAt,
        "operationalResponse.incidentCase.openedAt",
      ),
      status: enumValue(
        incidentCase.status,
        ["active", "resolved"] as const,
        "operationalResponse.incidentCase.status",
      ),
      ...(incidentCase.protectedStationIds === undefined ? {} : {
        protectedStationIds: textList(
          incidentCase.protectedStationIds,
          "operationalResponse.incidentCase.protectedStationIds",
          MAX_OPERATIONAL_REFERENCES,
        ),
      }),
      ...(incidentCase.continuityBoundaryStationIds === undefined ? {} : {
        continuityBoundaryStationIds: textList(
          incidentCase.continuityBoundaryStationIds,
          "operationalResponse.incidentCase.continuityBoundaryStationIds",
          MAX_OPERATIONAL_REFERENCES,
        ),
      }),
      affectedStationIds: textList(
        incidentCase.affectedStationIds,
        "operationalResponse.incidentCase.affectedStationIds",
        MAX_OPERATIONAL_REFERENCES,
      ),
      affectedInterstationIds: textList(
        incidentCase.affectedInterstationIds,
        "operationalResponse.incidentCase.affectedInterstationIds",
        MAX_OPERATIONAL_REFERENCES,
      ),
      connectionIds: textList(
        incidentCase.connectionIds,
        "operationalResponse.incidentCase.connectionIds",
        MAX_OPERATIONAL_REFERENCES,
      ),
      terminalStationIds: textList(
        incidentCase.terminalStationIds,
        "operationalResponse.incidentCase.terminalStationIds",
        MAX_OPERATIONAL_REFERENCES,
      ),
      insertionStationIds: textList(
        incidentCase.insertionStationIds,
        "operationalResponse.incidentCase.insertionStationIds",
        MAX_OPERATIONAL_REFERENCES,
      ),
      predictedDuration: parseDurationPrediction(
        incidentCase.predictedDuration,
        "operationalResponse.incidentCase.predictedDuration",
      ),
      milestones,
    },
    lineScada,
    dispatches,
    continuityMeasures,
    crowding,
    receipts,
    operatorApprovalRequired: true,
  };
}

function toolJson(output: string, toolName: string): Record<string, unknown> {
  try {
    return object(JSON.parse(output) as unknown, toolName + " output");
  } catch (error) {
    if (error instanceof IncidentDecisionAgentError) throw error;
    throw new IncidentDecisionAgentError(
      toolName + " returned unreadable JSON.",
      "invalid_webmcp_output",
    );
  }
}

function parseContext(raw: Record<string, unknown>, incidentId: string): IncidentDecisionContext {
  if (raw.status !== "context_ready") {
    throw new IncidentDecisionAgentError(
      textValue(raw.message ?? "Incident context is unavailable.", "context error"),
      "context_unavailable",
    );
  }
  const incident = object(raw.incident, "incident");
  if (incident.id !== incidentId) {
    throw new IncidentDecisionAgentError("WebMCP returned a different incident.", "context_mismatch");
  }
  const target = object(incident.target, "incident.target");
  const execution = incident.procedureExecution &&
      typeof incident.procedureExecution === "object" &&
      !Array.isArray(incident.procedureExecution)
    ? object(incident.procedureExecution, "incident.procedureExecution")
    : {};
  const evidence = object(raw.evidence, "evidence");
  const impact = object(raw.impact, "impact");
  const incidentCode = textValue(incident.incidentCode, "incident.incidentCode", 80);
  const operationalResponse = parseOperationalResponse(
    raw.operationalResponse,
    incidentId,
    incidentCode,
  );
  return {
    status: "context_ready",
    incident: {
      id: incidentId,
      incidentCode,
      title: textValue(incident.title, "incident.title"),
      type: textValue(incident.type, "incident.type"),
      effect: textValue(incident.effect, "incident.effect"),
      severity: textValue(incident.severity, "incident.severity"),
      status: textValue(incident.status, "incident.status"),
      occurrenceTime: textValue(incident.occurrenceTime, "incident.occurrenceTime"),
      lineCodes: textList(incident.lineCodes, "incident.lineCodes"),
      target: {
        type: textValue(target.type, "incident.target.type"),
        id: textValue(target.id, "incident.target.id"),
      },
      affectedSegmentIds: textList(incident.affectedSegmentIds, "incident.affectedSegmentIds"),
      affectedStationCodes: textList(incident.affectedStationCodes ?? [], "incident.affectedStationCodes"),
      impactedTrainIds: textList(incident.impactedTrainIds, "incident.impactedTrainIds"),
      procedureExecution: {
        managementState: typeof execution.managementState === "string"
          ? execution.managementState
          : "unassessed",
        procedureId: typeof execution.procedureId === "string"
          ? execution.procedureId
          : null,
        procedureRevision: typeof execution.procedureRevision === "string"
          ? execution.procedureRevision
          : null,
        completedStepIds: Array.isArray(execution.completedStepIds)
          ? textList(execution.completedStepIds, "incident.procedureExecution.completedStepIds", 20)
          : [],
        stepRecords: Array.isArray(execution.stepRecords)
          ? execution.stepRecords.slice(0, 64).map((entry, index) => {
              const label = `incident.procedureExecution.stepRecords[${index}]`;
              const record = object(entry, label);
              const rawKind = record.evidenceKind;
              const evidenceKind = rawKind === "works-handback" || rawKind === "police-clearance"
                ? rawKind
                : null;
              return {
                stepId: textValue(record.stepId, `${label}.stepId`, 100),
                receiptId: textValue(record.receiptId, `${label}.receiptId`, 180),
                operatorId: textValue(record.operatorId, `${label}.operatorId`, 160),
                recordedAt: numeric(record.recordedAt, `${label}.recordedAt`),
                operatorEvidenceReference: typeof record.operatorEvidenceReference === "string"
                  ? textValue(
                      record.operatorEvidenceReference,
                      `${label}.operatorEvidenceReference`,
                      160,
                    )
                  : null,
                evidenceKind,
              };
            })
          : [],
        nextRequiredStepId: typeof execution.nextRequiredStepId === "string"
          ? execution.nextRequiredStepId
          : null,
        recoveryStartedAt: typeof execution.recoveryStartedAt === "number" &&
            Number.isFinite(execution.recoveryStartedAt)
          ? execution.recoveryStartedAt
          : null,
      },
    },
    evidence: {
      timestamp: numeric(evidence.timestamp, "evidence.timestamp"),
      telemetryRevision: numeric(evidence.telemetryRevision, "evidence.telemetryRevision"),
      decisionRevision: numeric(evidence.decisionRevision, "evidence.decisionRevision"),
      scenarioId: textValue(evidence.scenarioId, "evidence.scenarioId"),
      procedureCatalogueSequence: evidence.procedureCatalogueSequence === undefined
        ? 0
        : numeric(
            evidence.procedureCatalogueSequence,
            "evidence.procedureCatalogueSequence",
          ),
    },
    impact: {
      impactedTrainCount: numeric(impact.impactedTrainCount, "impact.impactedTrainCount"),
      passengersOnImpactedTrains: numeric(
        impact.passengersOnImpactedTrains,
        "impact.passengersOnImpactedTrains",
      ),
      worstDelaySeconds: numeric(impact.worstDelaySeconds, "impact.worstDelaySeconds"),
      activeRestrictionCount: numeric(impact.activeRestrictionCount, "impact.activeRestrictionCount"),
      affectedLineCodes: textList(impact.affectedLineCodes, "impact.affectedLineCodes"),
      affectedSegmentIds: textList(impact.affectedSegmentIds, "impact.affectedSegmentIds"),
    },
    ...(operationalResponse ? { operationalResponse } : {}),
  };
}

function parseSearch(
  raw: Record<string, unknown>,
  incidentCode: string,
): OperationalProcedureSearch {
  if (
    raw.status !== "procedures_found" ||
    raw.incidentCode !== incidentCode ||
    !Array.isArray(raw.matches) ||
    raw.matches.length === 0
  ) {
    throw new IncidentDecisionAgentError(
      "No applicable controlled procedure was found for incident code " + incidentCode + ".",
      "procedure_unavailable",
    );
  }
  const matches = raw.matches.slice(0, 8).map((entry, index) => {
    const match = object(entry, "matches[" + index + "]");
    return {
      procedureId: textValue(match.procedureId, "matches[" + index + "].procedureId", 100),
      title: textValue(match.title, "matches[" + index + "].title"),
      revision: textValue(match.revision, "matches[" + index + "].revision", 80),
      contentHash: textValue(match.contentHash, "matches[" + index + "].contentHash", 160),
    };
  });
  return {
    status: "procedures_found",
    incidentCode,
    catalogRevision: textValue(raw.catalogRevision ?? "procedure-catalogue-current", "catalogRevision", 100),
    matches,
    nonMutating: true,
  };
}

function parseStep(entry: unknown, index: number): OperationalProcedureStep {
  const step = object(entry, "procedure.steps[" + index + "]");
  let capability: OperationalProcedureStep["capability"];
  if (step.capability !== undefined && step.capability !== null) {
    const value = object(step.capability, "procedure.steps[" + index + "].capability");
    const command = textValue(value.command, "procedure.steps[" + index + "].capability.command", 80);
    if (!PROCEDURE_COMMANDS.includes(command as ProcedureCommand)) {
      throw new IncidentDecisionAgentError("A procedure step exposes an unsupported command.", "invalid_procedure");
    }
    capability = {
      command: command as ProcedureCommand,
      requiresOperatorConfirmation: true,
      reversible: value.reversible === true,
    };
  }
  const duration = object(
    step.durationRangeSeconds,
    "procedure.steps[" + index + "].durationRangeSeconds",
  );
  const durationRangeSeconds = {
    minSeconds: numeric(duration.minSeconds, "durationRangeSeconds.minSeconds"),
    nominalSeconds: numeric(duration.nominalSeconds, "durationRangeSeconds.nominalSeconds"),
    maxSeconds: numeric(duration.maxSeconds, "durationRangeSeconds.maxSeconds"),
  };
  const requiredEvidenceReferenceKind =
    step.requiredEvidenceReferenceKind === "works-handback" ||
    step.requiredEvidenceReferenceKind === "police-clearance"
      ? step.requiredEvidenceReferenceKind
      : undefined;
  if (
    durationRangeSeconds.minSeconds < 0 ||
    durationRangeSeconds.minSeconds > durationRangeSeconds.nominalSeconds ||
    durationRangeSeconds.nominalSeconds > durationRangeSeconds.maxSeconds
  ) {
    throw new IncidentDecisionAgentError("A procedure step exposes an invalid duration range.", "invalid_procedure");
  }
  return {
    stepId: textValue(step.stepId, "procedure.steps[" + index + "].stepId", 100),
    order: numeric(step.order, "procedure.steps[" + index + "].order"),
    phase: textValue(step.phase, "procedure.steps[" + index + "].phase", 80),
    title: textValue(step.title, "procedure.steps[" + index + "].title"),
    instruction: textValue(step.instruction, "procedure.steps[" + index + "].instruction", 1400),
    rationale: textValue(step.rationale, "procedure.steps[" + index + "].rationale", 900),
    mandatory: step.mandatory === true,
    responsibleRole: textValue(step.responsibleRole, "procedure.steps[" + index + "].responsibleRole", 160),
    evidenceRequired: textList(
      step.evidenceRequired ?? [],
      "procedure.steps[" + index + "].evidenceRequired",
      8,
    ),
    durationRangeSeconds,
    ...(requiredEvidenceReferenceKind ? { requiredEvidenceReferenceKind } : {}),
    ...(capability ? { capability } : {}),
  };
}

function parseProcedure(
  raw: Record<string, unknown>,
  match: OperationalProcedureMatch,
): OperationalProcedure {
  if (raw.status !== "procedure_ready") {
    throw new IncidentDecisionAgentError("The selected procedure could not be read.", "procedure_unavailable");
  }
  const value = object(raw.procedure, "procedure");
  const procedureId = textValue(value.procedureId, "procedure.procedureId", 100);
  const revision = textValue(value.revision, "procedure.revision", 80);
  const contentHash = textValue(value.contentHash, "procedure.contentHash", 160);
  if (
    procedureId !== match.procedureId ||
    revision !== match.revision ||
    contentHash !== match.contentHash
  ) {
    throw new IncidentDecisionAgentError(
      "The retrieved procedure does not match the searched revision.",
      "procedure_mismatch",
    );
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new IncidentDecisionAgentError("The selected procedure contains no usable step.", "procedure_unavailable");
  }
  const steps = value.steps.slice(0, 20).map(parseStep).sort((left, right) => left.order - right.order);
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length) {
    throw new IncidentDecisionAgentError(
      "The selected procedure contains duplicate step identifiers.",
      "invalid_procedure",
    );
  }
  return {
    procedureId,
    title: textValue(value.title, "procedure.title"),
    revision,
    contentHash,
    documentRef: textValue(value.documentRef, "procedure.documentRef", 180),
    steps,
    normalStateCriteria: textList(value.normalStateCriteria, "procedure.normalStateCriteria", 12),
  };
}

function operationalProposedCapabilities(
  context: IncidentDecisionContext,
): Set<ProcedureCommand> {
  const operational = context.operationalResponse;
  const capabilities = new Set<ProcedureCommand>();
  if (!operational) return capabilities;
  for (const milestone of operational.incidentCase.milestones) {
    if (milestone.status === "due") {
      capabilities.add(MILESTONE_CAPABILITY_BY_CODE[milestone.code]);
    }
  }
  if (operational.dispatches.some((dispatch) => dispatch.status === "proposed")) {
    capabilities.add("dispatch-maintenance");
  }
  for (const measure of operational.continuityMeasures) {
    if (measure.status === "proposed") {
      capabilities.add(CONTINUITY_CAPABILITY_BY_KIND[measure.kind]);
    }
  }
  return capabilities;
}

function appendOperationalProcedureOptions(
  recommendation: IncidentAgentRecommendation,
  context: IncidentDecisionContext,
  procedure: OperationalProcedure,
): IncidentAgentRecommendation {
  const capabilities = operationalProposedCapabilities(context);
  if (capabilities.size === 0) return recommendation;
  const completed = new Set(context.incident.procedureExecution.completedStepIds);
  const cited = new Set(recommendation.actions.map((action) => action.stepId));
  const additional = procedure.steps.filter((step) =>
    !step.mandatory &&
    !completed.has(step.stepId) &&
    !cited.has(step.stepId) &&
    step.capability !== undefined &&
    capabilities.has(step.capability.command)
  );
  if (additional.length === 0) return recommendation;
  const nextPriority = recommendation.actions.reduce(
    (maximum, action) => Math.max(maximum, action.priority),
    0,
  ) + 1;
  return {
    ...recommendation,
    actions: [
      ...recommendation.actions,
      ...additional.map((step, index) => ({
        stepId: step.stepId,
        priority: nextPriority + index,
        rationale: step.rationale,
        operatorChecks: step.evidenceRequired.slice(0, 4),
      })),
    ],
  };
}

function fallbackRecommendation(
  context: IncidentDecisionContext,
  procedure: OperationalProcedure,
): IncidentAgentRecommendation {
  const selectedSteps = procedure.steps.filter((step) => step.mandatory);
  const completed = new Set(context.incident.procedureExecution.completedStepIds);
  const remaining = selectedSteps.filter((step) => !completed.has(step.stepId));
  const source = remaining.length > 0
    ? remaining
    : selectedSteps.length > 0
      ? selectedSteps
      : procedure.steps.slice(0, 1);
  const recommendation: IncidentAgentRecommendation = {
    incidentId: context.incident.id,
    incidentCode: context.incident.incidentCode,
    basedOnDecisionRevision: context.evidence.decisionRevision,
    procedureId: procedure.procedureId,
    procedureRevision: procedure.revision,
    procedureContentHash: procedure.contentHash,
    situationSummary:
      "Procedure " + procedure.procedureId + " applies to " +
      context.incident.incidentCode +
      ". Follow its cited steps and verify all prerequisites before recovery.",
    actions: source.map((step, index) => ({
      stepId: step.stepId,
      priority: index + 1,
      rationale: step.rationale,
      operatorChecks: step.evidenceRequired.slice(0, 4),
    })),
    risks: [
      "Do not act outside the cited procedure revision.",
      "Escalate when a prerequisite or required evidence is unavailable.",
    ],
    normalStateCriteria: procedure.normalStateCriteria,
  };
  return appendOperationalProcedureOptions(recommendation, context, procedure);
}

function parseRecommendation(
  raw: unknown,
  context: IncidentDecisionContext,
  procedure: OperationalProcedure,
): IncidentAgentRecommendation {
  const value = object(raw, "agent recommendation");
  if (
    value.schemaVersion !== "incident-decision.v2" ||
    value.incidentId !== context.incident.id ||
    value.incidentCode !== context.incident.incidentCode ||
    value.decisionRevision !== context.evidence.decisionRevision ||
    value.procedureId !== procedure.procedureId ||
    value.procedureRevision !== procedure.revision ||
    value.procedureContentHash !== procedure.contentHash ||
    value.advisoryOnly !== true ||
    value.humanReviewRequired !== true
  ) {
    throw new IncidentDecisionAgentError(
      "The recommendation is not bound to the retrieved procedure evidence.",
      "recommendation_mismatch",
    );
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    throw new IncidentDecisionAgentError(
      "The agent returned no cited procedure step.",
      "recommendation_mismatch",
    );
  }
  const available = new Set(procedure.steps.map((step) => step.stepId));
  const observed = new Set<string>();
  const actions = value.actions.slice(0, 12).map((entry, index) => {
    const action = object(entry, "actions[" + index + "]");
    const stepId = textValue(action.stepId, "actions[" + index + "].stepId", 100);
    if (!available.has(stepId) || observed.has(stepId)) {
      throw new IncidentDecisionAgentError(
        "The agent cited a step outside the retrieved procedure.",
        "recommendation_mismatch",
      );
    }
    observed.add(stepId);
    return {
      stepId,
      priority: numeric(action.priority, "actions[" + index + "].priority"),
      rationale: textValue(action.rationale, "actions[" + index + "].rationale"),
      operatorChecks: textList(action.operatorChecks, "actions[" + index + "].operatorChecks", 6),
    };
  }).sort((left, right) => left.priority - right.priority);
  const completed = new Set(context.incident.procedureExecution.completedStepIds);
  const requiredNextStepId =
    context.incident.procedureExecution.nextRequiredStepId ??
    procedure.steps.find((step) => step.mandatory && !completed.has(step.stepId))?.stepId ??
    null;
  if (requiredNextStepId && !observed.has(requiredNextStepId)) {
    throw new IncidentDecisionAgentError(
      "The agent omitted the next mandatory step from the retrieved procedure.",
      "recommendation_mismatch",
    );
  }
  const normalStateCriteria = textList(
    value.normalStateCriteria,
    "normalStateCriteria",
    12,
  );
  if (
    normalStateCriteria.length !== procedure.normalStateCriteria.length ||
    normalStateCriteria.some(
      (criterion, index) => criterion !== procedure.normalStateCriteria[index],
    )
  ) {
    throw new IncidentDecisionAgentError(
      "The agent changed the retrieved procedure return-to-normal criteria.",
      "recommendation_mismatch",
    );
  }
  return {
    incidentId: context.incident.id,
    incidentCode: context.incident.incidentCode,
    basedOnDecisionRevision: context.evidence.decisionRevision,
    procedureId: procedure.procedureId,
    procedureRevision: procedure.revision,
    procedureContentHash: procedure.contentHash,
    situationSummary: textValue(value.executiveSummary, "executiveSummary"),
    actions,
    risks: textList(value.risks, "risks", 8),
    normalStateCriteria,
  };
}

async function agentRequest(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AgentTurn> {
  const response = await fetch("/api/agent/turn", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new IncidentDecisionAgentError(
      "The decision agent returned an unreadable response.",
      "agent_invalid_response",
      response.status,
    );
  }
  if (!response.ok) {
    const error = object(payload, "agent error");
    throw new IncidentDecisionAgentError(
      typeof error.message === "string"
        ? error.message
        : "The decision agent could not analyze this incident.",
      typeof error.code === "string" ? error.code : "agent_request_failed",
      response.status,
    );
  }
  return payload as AgentTurn;
}

function analysisDefinitions(catalog: NativeWebMcpCatalog): AgentToolDefinition[] {
  const allowed = new Set<string>(READ_TOOLS);
  const definitions = catalog.definitions.filter((tool) => allowed.has(tool.name));
  if (definitions.length !== READ_TOOLS.length) {
    throw new NativeWebMcpError("The procedural incident WebMCP tools are incomplete.");
  }
  return definitions;
}

async function resetRun(runId: string | null): Promise<void> {
  if (!runId) return;
  try {
    await fetch("/api/agent/reset", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
  } catch {
    // Runs also expire server-side; cleanup failure is non-fatal.
  }
}

async function deterministicEvidence(input: {
  incidentId: string;
  decisionRevision: number;
  procedureCatalogueSequence?: number;
  catalog: NativeWebMcpCatalog;
  signal: AbortSignal;
  onProgress?: (progress: IncidentDecisionProgress) => void;
}): Promise<{
  context: IncidentDecisionContext;
  search: OperationalProcedureSearch;
  procedure: OperationalProcedure;
}> {
  input.onProgress?.("inspecting");
  const context = parseContext(
    toolJson(
      await executeNativeWebMcpTool(
        input.catalog,
        "inspect_incident_decision_context",
        { incidentId: input.incidentId },
        input.signal,
      ),
      "inspect_incident_decision_context",
    ),
    input.incidentId,
  );
  if (context.evidence.decisionRevision !== input.decisionRevision) {
    throw new IncidentDecisionAgentError(
      "The operational decision revision changed before analysis.",
      "stale_decision_context",
    );
  }
  if (
    input.procedureCatalogueSequence !== undefined &&
    context.evidence.procedureCatalogueSequence !== input.procedureCatalogueSequence
  ) {
    throw new IncidentDecisionAgentError(
      "The procedure catalogue changed before analysis.",
      "stale_procedure_catalogue",
    );
  }
  input.onProgress?.("searching");
  const search = parseSearch(
    toolJson(
      await executeNativeWebMcpTool(
        input.catalog,
        "search_operational_procedures",
        { incidentCode: context.incident.incidentCode },
        input.signal,
      ),
      "search_operational_procedures",
    ),
    context.incident.incidentCode,
  );
  input.onProgress?.("reading");
  const procedure = parseProcedure(
    toolJson(
      await executeNativeWebMcpTool(
        input.catalog,
        "get_operational_procedure",
        {
          procedureId: search.matches[0].procedureId,
          procedureRevision: search.matches[0].revision,
          procedureContentHash: search.matches[0].contentHash,
        },
        input.signal,
      ),
      "get_operational_procedure",
    ),
    search.matches[0],
  );
  return { context, search, procedure };
}

function cachedDecision(
  incidentId: string,
  decisionRevision: number,
  procedureCatalogueSequence?: number,
): IncidentDecisionPackage | null {
  const cached = decisionCache.get(incidentId);
  return cached?.context.evidence.decisionRevision === decisionRevision &&
    (procedureCatalogueSequence === undefined ||
      cached.context.evidence.procedureCatalogueSequence === procedureCatalogueSequence)
    ? cached
    : null;
}

export function clearIncidentDecisionCache(): void {
  decisionCache.clear();
}

export async function analyzeIncidentDecision(input: {
  incidentId: string;
  decisionRevision: number;
  procedureCatalogueSequence?: number;
  expectedToolNames: readonly string[];
  inPageTools?: readonly WebMcpToolDefinition[];
  modelEnabled: boolean;
  maxToolRounds?: number;
  signal: AbortSignal;
  onProgress?: (progress: IncidentDecisionProgress) => void;
}): Promise<IncidentDecisionPackage> {
  const cached = cachedDecision(
    input.incidentId,
    input.decisionRevision,
    input.procedureCatalogueSequence,
  );
  if (cached) return cached;
  input.onProgress?.("discovering");
  if (READ_TOOLS.some((name) => !input.expectedToolNames.includes(name))) {
    throw new NativeWebMcpError("The page has not published its procedural incident tools yet.");
  }
  const catalog = await discoverPageWebMcpTools(READ_TOOLS, input.inPageTools);
  const definitions = analysisDefinitions(catalog);

  if (!input.modelEnabled) {
    const evidence = await deterministicEvidence({ ...input, catalog });
    const result: IncidentDecisionPackage = {
      incidentId: input.incidentId,
      transport: catalog.transport,
      ...evidence,
      recommendation: fallbackRecommendation(evidence.context, evidence.procedure),
      modelAssisted: false,
      agentWarning:
        "OpenAI analysis is disabled; the ordered fallback is derived only from the retrieved procedure.",
      generatedAt: Date.now(),
    };
    decisionCache.set(input.incidentId, result);
    return result;
  }

  let runId: string | null = null;
  let contextOutput: Record<string, unknown> | null = null;
  let searchOutput: Record<string, unknown> | null = null;
  let procedureOutput: Record<string, unknown> | null = null;
  try {
    let body: Record<string, unknown> = {
      outputMode: "incident_decision",
      incidentId: input.incidentId,
      tools: definitions,
    };
    const roundLimit = Math.min(
      MAX_ROUNDS,
      Math.max(5, input.maxToolRounds ?? MAX_ROUNDS),
    );
    for (let round = 0; round < roundLimit; round += 1) {
      input.onProgress?.("reasoning");
      const turn = await agentRequest(body, input.signal);
      runId = turn.runId;
      if (turn.status === "completed") {
        if (!contextOutput || !searchOutput || !procedureOutput || !turn.recommendation) {
          throw new IncidentDecisionAgentError(
            "The agent completed without the required procedure evidence.",
            "incomplete_agent_evidence",
          );
        }
        const context = parseContext(contextOutput, input.incidentId);
        if (context.evidence.decisionRevision !== input.decisionRevision) {
          throw new IncidentDecisionAgentError(
            "The incident context changed during analysis.",
            "stale_decision_context",
          );
        }
        if (
          input.procedureCatalogueSequence !== undefined &&
          context.evidence.procedureCatalogueSequence !== input.procedureCatalogueSequence
        ) {
          throw new IncidentDecisionAgentError(
            "The procedure catalogue changed during analysis.",
            "stale_procedure_catalogue",
          );
        }
        const search = parseSearch(searchOutput, context.incident.incidentCode);
        const rawProcedure = object(procedureOutput.procedure, "procedure");
        const match = search.matches.find(
          (candidate) => candidate.procedureId === rawProcedure.procedureId,
        );
        if (!match) {
          throw new IncidentDecisionAgentError(
            "The agent opened a procedure outside the search results.",
            "procedure_mismatch",
          );
        }
        const procedure = parseProcedure(procedureOutput, match);
        const result: IncidentDecisionPackage = {
          incidentId: input.incidentId,
          transport: catalog.transport,
          context,
          search,
          procedure,
          recommendation: appendOperationalProcedureOptions(
            parseRecommendation(turn.recommendation, context, procedure),
            context,
            procedure,
          ),
          modelAssisted: true,
          usage: turn.usage,
          generatedAt: Date.now(),
        };
        decisionCache.set(input.incidentId, result);
        return result;
      }

      const outputs: Array<{ callId: string; output: string }> = [];
      for (const call of turn.calls) {
        if (!READ_TOOLS.includes(call.name as typeof READ_TOOLS[number])) {
          throw new IncidentDecisionAgentError(
            "The agent requested a tool outside the read-only procedure workflow.",
            "invalid_agent_tool",
          );
        }
        input.onProgress?.(
          call.name === "inspect_incident_decision_context"
            ? "inspecting"
            : call.name === "search_operational_procedures"
              ? "searching"
              : "reading",
        );
        const output = await executeNativeWebMcpTool(
          catalog,
          call.name,
          call.arguments,
          input.signal,
        );
        const parsed = toolJson(output, call.name);
        if (call.name === "inspect_incident_decision_context") contextOutput = parsed;
        if (call.name === "search_operational_procedures") searchOutput = parsed;
        if (call.name === "get_operational_procedure") procedureOutput = parsed;
        outputs.push({ callId: call.callId, output });
      }
      body = { runId: turn.runId, toolOutputs: outputs };
    }
    throw new IncidentDecisionAgentError(
      "The agent exceeded the bounded procedure-analysis rounds.",
      "agent_round_limit",
    );
  } catch (error) {
    if (input.signal.aborted) throw error;
    const evidence = await deterministicEvidence({ ...input, catalog });
    const result: IncidentDecisionPackage = {
      incidentId: input.incidentId,
      transport: catalog.transport,
      ...evidence,
      recommendation: fallbackRecommendation(evidence.context, evidence.procedure),
      modelAssisted: false,
      agentWarning:
        error instanceof Error ? error.message : "The model explanation was unavailable.",
      generatedAt: Date.now(),
    };
    decisionCache.set(input.incidentId, result);
    return result;
  } finally {
    await resetRun(runId);
  }
}

export async function applyIncidentProcedureStep(input: {
  package: IncidentDecisionPackage;
  stepId: string;
  operatorEvidenceReference?: string;
  inPageTools?: readonly WebMcpToolDefinition[];
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const action = input.package.recommendation.actions.find(
    (candidate) => candidate.stepId === input.stepId,
  );
  const step = input.package.procedure.steps.find(
    (candidate) => candidate.stepId === input.stepId,
  );
  if (!action || !step) {
    throw new IncidentDecisionAgentError(
      "This action is not cited by the retrieved procedure plan.",
      "unknown_procedure_step",
    );
  }
  const catalog = await discoverPageWebMcpTools(
    [APPLY_TOOL],
    input.inPageTools,
  );
  const output = toolJson(
    await executeNativeWebMcpTool(
      catalog,
      APPLY_TOOL,
      {
        incidentId: input.package.incidentId,
        procedureId: input.package.procedure.procedureId,
        procedureRevision: input.package.procedure.revision,
        procedureContentHash: input.package.procedure.contentHash,
        stepId: step.stepId,
        expectedDecisionRevision:
          input.package.context.evidence.decisionRevision,
        confirmSimulation: true,
        ...(input.operatorEvidenceReference
          ? { operatorEvidenceReference: input.operatorEvidenceReference }
          : {}),
      },
      input.signal,
    ),
    APPLY_TOOL,
  );
  if (
    output.status !== "applied_to_simulation" &&
    output.status !== "procedure_step_acknowledged"
  ) {
    throw new IncidentDecisionAgentError(
      typeof output.message === "string"
        ? output.message
        : "The reviewed procedure step was blocked.",
      typeof output.reason === "string"
        ? output.reason
        : "procedure_step_blocked",
    );
  }
  clearIncidentDecisionCache();
  return output;
}
