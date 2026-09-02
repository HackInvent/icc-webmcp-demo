import {
  discoverPageWebMcpTools,
  executeNativeWebMcpTool,
  NativeWebMcpError,
  type AgentToolDefinition,
  type NativeWebMcpCatalog,
  type WebMcpTransport,
} from "./nativeWebMcp";
import type { NativeLineCode } from "../rail/nativeNetwork";

export const PASSENGER_FLOW_IMPACT_TOOL = "inspect_passenger_flow_impact";

export type PassengerFlowPriorityScope = NativeLineCode | "ALL";
export type PassengerFlowPriorityProgress = "discovering" | "inspecting" | "reasoning";

export interface PassengerFlowPriorityHotspot {
  stationCode: string;
  stationName: string;
  waitingPassengers: number;
}

export interface PassengerFlowPriorityCandidate {
  evidenceRank: number;
  incidentId: string;
  incidentCode: string;
  title: string;
  lineCode: NativeLineCode;
  location: string;
  severity: "low" | "medium" | "high" | "critical";
  occurrenceTime: string;
  waitingQueuePassengers: number;
  arrivalsPerMinute: number;
  affectedStationCount: number;
  impactedTrainCount: number;
  passengersOnImpactedTrains: number;
  queueHotspots: PassengerFlowPriorityHotspot[];
}

export interface PassengerFlowPriorityContext {
  line: PassengerFlowPriorityScope;
  observedAt: number;
  telemetryRevision: number;
  decisionRevision: number;
  activeIncidentCount: number;
  candidates: PassengerFlowPriorityCandidate[];
}

export interface PassengerFlowPriorityItem extends PassengerFlowPriorityCandidate {
  recommendation: string;
  rationale: string;
}

export interface PassengerFlowPriorityPackage {
  context: PassengerFlowPriorityContext;
  summary: string;
  priorities: PassengerFlowPriorityItem[];
  transport: WebMcpTransport;
  modelAssisted: boolean;
  agentWarning?: string;
  usage?: { inputTokens: number; outputTokens: number };
  generatedAt: number;
}

interface AgentToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

type AgentTurn =
  | { status: "tool_calls"; runId: string; calls: AgentToolCall[] }
  | {
      status: "completed";
      runId: string;
      recommendation: unknown;
      usage?: { inputTokens: number; outputTokens: number };
    };

const LINE_CODES = new Set<string>([
  "M1", "M2", "M3", "M3BIS", "M4", "M5", "M6", "M7", "M7BIS", "M8", "M9",
  "M10", "M11", "M12", "M13", "M14", "RER_A", "RER_B", "RER_C", "RER_D", "RER_E",
]);
const MAX_AGENT_ROUNDS = 3;

export class PassengerFlowPriorityAgentError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code = "passenger_flow_agent_failed", status?: number) {
    super(message);
    this.name = "PassengerFlowPriorityAgentError";
    this.code = code;
    this.status = status;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PassengerFlowPriorityAgentError(`${label} is invalid.`, "invalid_passenger_flow_evidence");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new PassengerFlowPriorityAgentError(`${label} is invalid.`, "invalid_passenger_flow_evidence");
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PassengerFlowPriorityAgentError(`${label} is invalid.`, "invalid_passenger_flow_evidence");
  }
  return Number(value);
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PassengerFlowPriorityAgentError(`${label} is invalid.`, "invalid_passenger_flow_evidence");
  }
  return value;
}

function parseCandidate(value: unknown, expectedRank: number): PassengerFlowPriorityCandidate {
  const candidate = object(value, `candidate ${expectedRank}`);
  const lineCode = boundedString(candidate.lineCode, "candidate lineCode", 16);
  const severity = boundedString(candidate.severity, "candidate severity", 16);
  if (!LINE_CODES.has(lineCode) || !["low", "medium", "high", "critical"].includes(severity)) {
    throw new PassengerFlowPriorityAgentError("Candidate scope is invalid.", "invalid_passenger_flow_evidence");
  }
  const rawHotspots = candidate.queueHotspots;
  if (!Array.isArray(rawHotspots) || rawHotspots.length > 3) {
    throw new PassengerFlowPriorityAgentError("Candidate hotspots are invalid.", "invalid_passenger_flow_evidence");
  }
  const evidenceRank = nonNegativeInteger(candidate.evidenceRank, "candidate evidenceRank");
  if (evidenceRank !== expectedRank) {
    throw new PassengerFlowPriorityAgentError("Candidate ranking is invalid.", "invalid_passenger_flow_evidence");
  }
  const occurrenceTime = boundedString(candidate.occurrenceTime, "candidate occurrenceTime", 40);
  if (!Number.isFinite(Date.parse(occurrenceTime))) {
    throw new PassengerFlowPriorityAgentError("Candidate occurrence time is invalid.", "invalid_passenger_flow_evidence");
  }
  return {
    evidenceRank,
    incidentId: boundedString(candidate.incidentId, "candidate incidentId", 96),
    incidentCode: boundedString(candidate.incidentCode, "candidate incidentCode", 96),
    title: boundedString(candidate.title, "candidate title", 240),
    lineCode: lineCode as NativeLineCode,
    location: boundedString(candidate.location, "candidate location", 240),
    severity: severity as PassengerFlowPriorityCandidate["severity"],
    occurrenceTime,
    waitingQueuePassengers: nonNegativeInteger(candidate.waitingQueuePassengers, "candidate waiting queue"),
    arrivalsPerMinute: nonNegativeNumber(candidate.arrivalsPerMinute, "candidate arrival rate"),
    affectedStationCount: nonNegativeInteger(candidate.affectedStationCount, "candidate station count"),
    impactedTrainCount: nonNegativeInteger(candidate.impactedTrainCount, "candidate train count"),
    passengersOnImpactedTrains: nonNegativeInteger(candidate.passengersOnImpactedTrains, "candidate onboard passengers"),
    queueHotspots: rawHotspots.map((rawHotspot) => {
      const hotspot = object(rawHotspot, "queue hotspot");
      return {
        stationCode: boundedString(hotspot.stationCode, "hotspot stationCode", 96),
        stationName: boundedString(hotspot.stationName, "hotspot stationName", 240),
        waitingPassengers: nonNegativeInteger(hotspot.waitingPassengers, "hotspot waiting queue"),
      };
    }),
  };
}

function parseContext(rawOutput: string, expectedLine: PassengerFlowPriorityScope): PassengerFlowPriorityContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new PassengerFlowPriorityAgentError(
      "The Passenger Flow WebMCP tool returned unreadable evidence.",
      "invalid_passenger_flow_evidence",
    );
  }
  const output = object(parsed, "Passenger Flow evidence");
  const scope = object(output.scope, "Passenger Flow scope");
  if (output.status !== "passenger_flow_context_ready" || scope.line !== expectedLine) {
    throw new PassengerFlowPriorityAgentError(
      "The Passenger Flow evidence does not match the selected line.",
      "stale_passenger_flow_context",
    );
  }
  if (!Array.isArray(output.candidates) || output.candidates.length > 12) {
    throw new PassengerFlowPriorityAgentError("Passenger Flow candidates are invalid.", "invalid_passenger_flow_evidence");
  }
  const candidates = output.candidates.map((candidate, index) => parseCandidate(candidate, index + 1));
  if (new Set(candidates.map((candidate) => candidate.incidentId)).size !== candidates.length) {
    throw new PassengerFlowPriorityAgentError("Passenger Flow candidates are duplicated.", "invalid_passenger_flow_evidence");
  }
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1].waitingQueuePassengers < candidates[index].waitingQueuePassengers) {
      throw new PassengerFlowPriorityAgentError("Passenger Flow candidates are not queue-ranked.", "invalid_passenger_flow_evidence");
    }
  }
  const activeIncidentCount = nonNegativeInteger(output.activeIncidentCount, "active incident count");
  if (activeIncidentCount < candidates.length) {
    throw new PassengerFlowPriorityAgentError("Active incident count is invalid.", "invalid_passenger_flow_evidence");
  }
  return {
    line: expectedLine,
    observedAt: nonNegativeInteger(scope.observedAt, "observedAt"),
    telemetryRevision: nonNegativeInteger(scope.telemetryRevision, "telemetryRevision"),
    decisionRevision: nonNegativeInteger(scope.decisionRevision, "decisionRevision"),
    activeIncidentCount,
    candidates,
  };
}

function fallbackPackage(
  context: PassengerFlowPriorityContext,
  transport: WebMcpTransport,
  warning?: string,
): PassengerFlowPriorityPackage {
  const selected = context.candidates.slice(0, 3);
  const priorities = selected.map<PassengerFlowPriorityItem>((candidate) => ({
    ...candidate,
    recommendation: `Open the controlled response workflow for ${candidate.incidentCode}.`,
    rationale: candidate.waitingQueuePassengers > 0
      ? `${candidate.waitingQueuePassengers.toLocaleString("en-GB")} waiting passengers are currently within this incident scope, the largest remaining queue-relief opportunity at rank ${candidate.evidenceRank}.`
      : `No waiting queue is currently measured within this incident scope; severity and impacted-train exposure determine rank ${candidate.evidenceRank}.`,
  }));
  return {
    context,
    summary: priorities.length
      ? `${priorities.length} active incident${priorities.length === 1 ? "" : "s"} should be reviewed in current queue-impact order.`
      : "No active incident currently constrains a measured station waiting queue in this line scope.",
    priorities,
    transport,
    modelAssisted: false,
    ...(warning ? { agentWarning: warning } : {}),
    generatedAt: Date.now(),
  };
}

function parseRecommendation(
  raw: unknown,
  context: PassengerFlowPriorityContext,
): Pick<PassengerFlowPriorityPackage, "summary" | "priorities"> {
  const value = object(raw, "Passenger Flow agent recommendation");
  if (
    value.schemaVersion !== "passenger-flow-priority-analysis.v1" ||
    value.advisoryOnly !== true ||
    !Array.isArray(value.priorities)
  ) {
    throw new PassengerFlowPriorityAgentError("The agent recommendation is invalid.", "invalid_agent_response");
  }
  const expected = context.candidates.slice(0, 3);
  if (value.priorities.length !== expected.length) {
    throw new PassengerFlowPriorityAgentError("The agent changed the verified priority count.", "recommendation_mismatch");
  }
  const priorities = value.priorities.map<PassengerFlowPriorityItem>((rawItem, index) => {
    const item = object(rawItem, `agent priority ${index + 1}`);
    if (item.rank !== index + 1 || item.incidentId !== expected[index].incidentId) {
      throw new PassengerFlowPriorityAgentError("The agent changed the verified incident ranking.", "recommendation_mismatch");
    }
    return {
      ...expected[index],
      recommendation: boundedString(item.recommendation, "agent recommendation", 360),
      rationale: boundedString(item.rationale, "agent rationale", 600),
    };
  });
  return {
    summary: boundedString(value.summary, "agent summary", 700),
    priorities,
  };
}

async function agentRequest(body: Record<string, unknown>, signal: AbortSignal): Promise<AgentTurn> {
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
    throw new PassengerFlowPriorityAgentError("The passenger-flow agent returned an unreadable response.", "agent_invalid_response", response.status);
  }
  if (!response.ok) {
    const error = object(payload, "agent error");
    throw new PassengerFlowPriorityAgentError(
      typeof error.message === "string" ? error.message : "The passenger-flow agent could not complete its analysis.",
      typeof error.code === "string" ? error.code : "agent_request_failed",
      response.status,
    );
  }
  return payload as AgentTurn;
}

function analysisDefinitions(catalog: NativeWebMcpCatalog): AgentToolDefinition[] {
  const definitions = catalog.definitions.filter((tool) => tool.name === PASSENGER_FLOW_IMPACT_TOOL);
  if (definitions.length !== 1 || definitions[0].annotations?.readOnlyHint !== true) {
    throw new NativeWebMcpError("The Passenger Flow read-only WebMCP tool is unavailable.");
  }
  return definitions;
}

async function readContext(
  catalog: NativeWebMcpCatalog,
  line: PassengerFlowPriorityScope,
  signal: AbortSignal,
): Promise<{ context: PassengerFlowPriorityContext; output: string }> {
  const output = await executeNativeWebMcpTool(
    catalog,
    PASSENGER_FLOW_IMPACT_TOOL,
    { line },
    signal,
  );
  return { context: parseContext(output, line), output };
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
    // Runs expire server-side; cleanup failure does not invalidate a completed read.
  }
}

export async function analyzePassengerFlowPriorities(input: {
  line: PassengerFlowPriorityScope;
  expectedToolNames: readonly string[];
  inPageTools?: readonly WebMcpToolDefinition[];
  modelEnabled: boolean;
  signal: AbortSignal;
  onProgress?: (progress: PassengerFlowPriorityProgress) => void;
}): Promise<PassengerFlowPriorityPackage> {
  input.onProgress?.("discovering");
  if (!input.expectedToolNames.includes(PASSENGER_FLOW_IMPACT_TOOL)) {
    throw new NativeWebMcpError("The page has not published its Passenger Flow tool yet.");
  }
  const catalog = await discoverPageWebMcpTools(
    [PASSENGER_FLOW_IMPACT_TOOL],
    input.inPageTools,
  );
  const definitions = analysisDefinitions(catalog);

  if (!input.modelEnabled) {
    input.onProgress?.("inspecting");
    const { context } = await readContext(catalog, input.line, input.signal);
    return fallbackPackage(
      context,
      catalog.transport,
      "OpenAI analysis is disabled; queue-impact ordering remains available from verified WebMCP evidence.",
    );
  }

  let runId: string | null = null;
  let context: PassengerFlowPriorityContext | null = null;
  try {
    let body: Record<string, unknown> = {
      outputMode: "passenger_flow_priority",
      line: input.line,
      tools: definitions,
    };
    for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
      input.onProgress?.("reasoning");
      const turn = await agentRequest(body, input.signal);
      runId = turn.runId;
      if (turn.status === "completed") {
        if (!context) {
          throw new PassengerFlowPriorityAgentError("The agent completed without WebMCP evidence.", "incomplete_agent_evidence");
        }
        const recommendation = parseRecommendation(turn.recommendation, context);
        return {
          context,
          ...recommendation,
          transport: catalog.transport,
          modelAssisted: true,
          usage: turn.usage,
          generatedAt: Date.now(),
        };
      }
      if (
        turn.calls.length !== 1 ||
        turn.calls[0].name !== PASSENGER_FLOW_IMPACT_TOOL ||
        turn.calls[0].arguments.line !== input.line
      ) {
        throw new PassengerFlowPriorityAgentError("The agent requested an unexpected WebMCP tool call.", "invalid_agent_tool");
      }
      input.onProgress?.("inspecting");
      const evidence = await readContext(catalog, input.line, input.signal);
      context = evidence.context;
      body = {
        runId: turn.runId,
        toolOutputs: [{ callId: turn.calls[0].callId, output: evidence.output }],
      };
    }
    throw new PassengerFlowPriorityAgentError("The agent exceeded the bounded analysis rounds.", "agent_round_limit");
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (!context) {
      input.onProgress?.("inspecting");
      context = (await readContext(catalog, input.line, input.signal)).context;
    }
    return fallbackPackage(
      context,
      catalog.transport,
      error instanceof Error ? error.message : "The model explanation is temporarily unavailable.",
    );
  } finally {
    await resetRun(runId);
  }
}
