import {
  discoverPageWebMcpTools,
  executeNativeWebMcpTool,
  NativeWebMcpError,
  type AgentToolDefinition,
  type NativeWebMcpCatalog,
  type WebMcpTransport,
} from "./nativeWebMcp";

export const SHIFT_LOG_TOOL_NAME = "inspect_shift_log";
const SHIFT_LOG_PAGE_SIZE = 80;
const MAX_AGENT_ROUNDS = 16;

export type ShiftReportAgentProgress =
  | "discovering"
  | "inspecting"
  | "reasoning"
  | "finalizing";

export interface ShiftReportDraft {
  schemaVersion: "shift-report-draft.v1";
  executiveSummary: string;
  notableEvents: Array<{ logEntryId: string; narrative: string }>;
  investigationPoints: Array<{
    title: string;
    narrative: string;
    logEntryIds: string[];
  }>;
  handoverItems: Array<{ text: string; logEntryIds: string[] }>;
  advisoryOnly: true;
}

export interface ShiftReportAgentResult {
  html: string;
  reportId: string;
  shiftId: string;
  sourceLogCount: number;
  sourceLogSequence: number;
  transport: WebMcpTransport;
  modelAssisted: boolean;
  warning?: string;
  usage?: { inputTokens: number; outputTokens: number };
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
      recommendation: ShiftReportDraft;
      evidence: {
        shiftId: string;
        reportId: string;
        latestLogSequence: number;
        logCount: number;
      };
      usage?: { inputTokens: number; outputTokens: number };
    };

interface PageEvidence {
  shiftId: string;
  reportId: string;
  latestLogSequence: number;
  nextAfterSequence: number;
  hasMore: boolean;
  count: number;
}

interface AccumulatedEvidence {
  shiftId: string | null;
  reportId: string;
  latestLogSequence: number | null;
  nextAfterSequence: number;
  complete: boolean;
  logCount: number;
}

interface FinalizedDraft {
  status: "draft_ready";
  reportId: string;
  html: string;
  modelAssisted: boolean;
  warning: string | null;
  sourceLogCount: number;
  sourceLogSequence: number;
}

export class ShiftReportAgentError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code = "shift_report_agent_failed", status?: number) {
    super(message);
    this.name = "ShiftReportAgentError";
    this.code = code;
    this.status = status;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShiftReportAgentError(`${label} is invalid.`, "invalid_shift_report_evidence");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ShiftReportAgentError(`${label} is invalid.`, "invalid_shift_report_evidence");
  }
  return Number(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ShiftReportAgentError(`${label} is invalid.`, "invalid_shift_report_evidence");
  }
  return value;
}

function parsePage(
  rawOutput: string,
  reportId: string,
  expectedAfterSequence: number,
): PageEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new ShiftReportAgentError(
      "The Shift Report WebMCP tool returned unreadable evidence.",
      "invalid_shift_report_evidence",
    );
  }
  const output = object(parsed, "Shift Report evidence");
  const page = object(output.page, "Shift Report page");
  const logs = output.logs;
  if (
    output.status !== "shift_log_page_ready" ||
    output.source !== "authenticated_server_persisted_shift_log" ||
    output.reportId !== reportId ||
    output.reportStatus !== "draft" ||
    page.afterSequence !== expectedAfterSequence ||
    page.limit !== SHIFT_LOG_PAGE_SIZE ||
    typeof page.hasMore !== "boolean" ||
    !Array.isArray(logs) ||
    logs.length < 1 ||
    logs.length > SHIFT_LOG_PAGE_SIZE ||
    page.count !== logs.length
  ) {
    throw new ShiftReportAgentError(
      "The Shift Report WebMCP evidence does not match the current report page.",
      "stale_shift_report_evidence",
    );
  }
  const last = object(logs.at(-1), "last Shift Report log entry");
  const lastSequence = integer(last.sequence, "last log sequence");
  const latestLogSequence = integer(output.latestLogSequence, "latest log sequence");
  if (
    (page.hasMore && page.nextAfterSequence !== lastSequence) ||
    (!page.hasMore && page.nextAfterSequence !== null) ||
    (!page.hasMore && lastSequence !== latestLogSequence)
  ) {
    throw new ShiftReportAgentError(
      "The Shift Report WebMCP pagination cursor is inconsistent.",
      "invalid_shift_report_evidence",
    );
  }
  return {
    shiftId: string(output.shiftId, "shiftId"),
    reportId,
    latestLogSequence,
    nextAfterSequence: lastSequence,
    hasMore: page.hasMore,
    count: logs.length,
  };
}

function mergePage(
  current: AccumulatedEvidence,
  page: PageEvidence,
): AccumulatedEvidence {
  if (
    (current.shiftId !== null && current.shiftId !== page.shiftId) ||
    (current.latestLogSequence !== null &&
      current.latestLogSequence !== page.latestLogSequence)
  ) {
    throw new ShiftReportAgentError(
      "The persisted shift log changed during WebMCP inspection. Request a new draft.",
      "stale_shift_report_evidence",
    );
  }
  return {
    shiftId: page.shiftId,
    reportId: current.reportId,
    latestLogSequence: page.latestLogSequence,
    nextAfterSequence: page.nextAfterSequence,
    complete: !page.hasMore,
    logCount: current.logCount + page.count,
  };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
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
  const payload = await responseJson(response);
  if (!response.ok) {
    throw new ShiftReportAgentError(
      typeof payload.message === "string"
        ? payload.message
        : "The Shift Report agent could not complete its WebMCP run.",
      typeof payload.code === "string" ? payload.code : "agent_request_failed",
      response.status,
    );
  }
  return payload as unknown as AgentTurn;
}

async function finalizeDraft(input: {
  reportId: string;
  evidence: AccumulatedEvidence;
  draft?: ShiftReportDraft;
  signal: AbortSignal;
}): Promise<FinalizedDraft> {
  if (
    !input.evidence.complete ||
    input.evidence.shiftId === null ||
    input.evidence.latestLogSequence === null
  ) {
    throw new ShiftReportAgentError(
      "The complete persisted shift log must be inspected before drafting.",
      "incomplete_shift_report_evidence",
    );
  }
  const response = await fetch("/api/reports/assist", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reportId: input.reportId,
      expectedShiftId: input.evidence.shiftId,
      expectedLogSequence: input.evidence.latestLogSequence,
      ...(input.draft ? { draft: input.draft } : {}),
    }),
    signal: input.signal,
  });
  const payload = await responseJson(response);
  if (
    !response.ok ||
    payload.status !== "draft_ready" ||
    typeof payload.html !== "string"
  ) {
    throw new ShiftReportAgentError(
      typeof payload.message === "string"
        ? payload.message
        : "The verified Shift Report draft could not be finalized.",
      typeof payload.code === "string" ? payload.code : "report_finalize_failed",
      response.status,
    );
  }
  return payload as unknown as FinalizedDraft;
}

function reportDefinitions(catalog: NativeWebMcpCatalog): AgentToolDefinition[] {
  const definitions = catalog.definitions.filter(
    (tool) => tool.name === SHIFT_LOG_TOOL_NAME,
  );
  if (definitions.length !== 1 || definitions[0].annotations?.readOnlyHint !== true) {
    throw new NativeWebMcpError("The read-only Shift Report WebMCP tool is unavailable.");
  }
  return definitions;
}

async function executeLogPage(
  catalog: NativeWebMcpCatalog,
  reportId: string,
  afterSequence: number,
  signal: AbortSignal,
): Promise<{ output: string; page: PageEvidence }> {
  const output = await executeNativeWebMcpTool(
    catalog,
    SHIFT_LOG_TOOL_NAME,
    { reportId, afterSequence, limit: SHIFT_LOG_PAGE_SIZE },
    signal,
  );
  return {
    output,
    page: parsePage(output, reportId, afterSequence),
  };
}

async function completeDirectInspection(
  catalog: NativeWebMcpCatalog,
  evidence: AccumulatedEvidence,
  signal: AbortSignal,
  onProgress?: (progress: ShiftReportAgentProgress) => void,
): Promise<AccumulatedEvidence> {
  let current = evidence;
  for (let round = 0; !current.complete && round < MAX_AGENT_ROUNDS - 1; round += 1) {
    onProgress?.("inspecting");
    const result = await executeLogPage(
      catalog,
      current.reportId,
      current.nextAfterSequence,
      signal,
    );
    current = mergePage(current, result.page);
  }
  if (!current.complete) {
    throw new ShiftReportAgentError(
      "The shift log exceeds the bounded WebMCP pagination limit.",
      "agent_round_limit",
    );
  }
  return current;
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
    // Runs expire server-side; cleanup failure does not invalidate inspected evidence.
  }
}

export async function generateShiftReportDraft(input: {
  reportId: string;
  expectedToolNames: readonly string[];
  inPageTools?: readonly WebMcpToolDefinition[];
  modelEnabled: boolean;
  signal: AbortSignal;
  onProgress?: (progress: ShiftReportAgentProgress) => void;
}): Promise<ShiftReportAgentResult> {
  input.onProgress?.("discovering");
  if (!input.expectedToolNames.includes(SHIFT_LOG_TOOL_NAME)) {
    throw new NativeWebMcpError("The page has not published its Shift Report tool yet.");
  }
  const catalog = await discoverPageWebMcpTools(
    [SHIFT_LOG_TOOL_NAME],
    input.inPageTools,
  );
  const definitions = reportDefinitions(catalog);
  let evidence: AccumulatedEvidence = {
    shiftId: null,
    reportId: input.reportId,
    latestLogSequence: null,
    nextAfterSequence: 0,
    complete: false,
    logCount: 0,
  };
  let runId: string | null = null;
  let draft: ShiftReportDraft | undefined;
  let usage: ShiftReportAgentResult["usage"];
  let warning: string | undefined;

  if (input.modelEnabled) {
    try {
      let body: Record<string, unknown> = {
        outputMode: "shift_report",
        reportId: input.reportId,
        tools: definitions,
      };
      for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
        input.onProgress?.("reasoning");
        const turn = await agentRequest(body, input.signal);
        runId = turn.runId;
        if (turn.status === "completed") {
          if (
            !evidence.complete ||
            turn.evidence.reportId !== input.reportId ||
            turn.evidence.shiftId !== evidence.shiftId ||
            turn.evidence.latestLogSequence !== evidence.latestLogSequence ||
            turn.evidence.logCount !== evidence.logCount
          ) {
            throw new ShiftReportAgentError(
              "The agent completed without the exact WebMCP shift-log evidence.",
              "incomplete_shift_report_evidence",
            );
          }
          draft = turn.recommendation;
          usage = turn.usage;
          break;
        }
        if (
          turn.calls.length !== 1 ||
          turn.calls[0].name !== SHIFT_LOG_TOOL_NAME ||
          turn.calls[0].arguments.reportId !== input.reportId ||
          turn.calls[0].arguments.afterSequence !== evidence.nextAfterSequence ||
          turn.calls[0].arguments.limit !== SHIFT_LOG_PAGE_SIZE
        ) {
          throw new ShiftReportAgentError(
            "The agent requested an unexpected Shift Report WebMCP page.",
            "invalid_agent_tool",
          );
        }
        input.onProgress?.("inspecting");
        const page = await executeLogPage(
          catalog,
          input.reportId,
          evidence.nextAfterSequence,
          input.signal,
        );
        evidence = mergePage(evidence, page.page);
        body = {
          runId: turn.runId,
          toolOutputs: [{ callId: turn.calls[0].callId, output: page.output }],
        };
      }
      if (!draft) {
        throw new ShiftReportAgentError(
          "The agent exceeded the bounded Shift Report WebMCP rounds.",
          "agent_round_limit",
        );
      }
    } catch (error) {
      if (input.signal.aborted) throw error;
      warning = error instanceof Error
        ? error.message
        : "OpenAI drafting is unavailable; a verified chronology will be prepared.";
      draft = undefined;
    } finally {
      await resetRun(runId);
    }
  } else {
    warning = "OpenAI is disabled; a verified chronology will be prepared.";
  }

  if (!evidence.complete) {
    evidence = await completeDirectInspection(
      catalog,
      evidence,
      input.signal,
      input.onProgress,
    );
  }
  input.onProgress?.("finalizing");
  const finalized = await finalizeDraft({
    reportId: input.reportId,
    evidence,
    ...(draft ? { draft } : {}),
    signal: input.signal,
  });
  if (
    finalized.reportId !== input.reportId ||
    finalized.sourceLogCount !== evidence.logCount ||
    finalized.sourceLogSequence !== evidence.latestLogSequence
  ) {
    throw new ShiftReportAgentError(
      "The finalized report does not match the WebMCP shift-log evidence.",
      "stale_shift_report_evidence",
    );
  }
  return {
    html: finalized.html,
    reportId: finalized.reportId,
    shiftId: evidence.shiftId!,
    sourceLogCount: finalized.sourceLogCount,
    sourceLogSequence: finalized.sourceLogSequence,
    transport: catalog.transport,
    modelAssisted: Boolean(draft && finalized.modelAssisted),
    ...(warning ? { warning } : {}),
    ...(usage ? { usage } : {}),
  };
}
