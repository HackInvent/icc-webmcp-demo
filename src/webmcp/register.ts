import type { RailSnapshot } from "../rail/domain";
import { createIccTools, type IccToolDependencies } from "./tools";

export interface RegistrationResult {
  supported: boolean;
  count: number;
  names: string[];
  tools: WebMcpToolDefinition[];
  dispose: () => Promise<void>;
}

export interface WebMcpAvailability {
  checked: boolean;
  supported: boolean;
  count: number;
  names: string[];
}

export type WebMcpActivityKind = "read" | "analysis" | "write";
export type WebMcpActivityStatus =
  | "awaiting_approval"
  | "running"
  | "completed"
  | "blocked"
  | "failed";

export interface WebMcpActivity {
  id: string;
  toolName: string;
  label: string;
  kind: WebMcpActivityKind;
  status: WebMcpActivityStatus;
  outcome: string;
  startedAt: string;
  completedAt?: string;
}

export const MUTATING_WEBMCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "apply_reviewed_schedule_change",
  "simulate_track_circuit_closure",
  "simulate_regulation_action",
  "apply_reviewed_procedure_step",
  "create_simulated_network_incident",
  "control_network_simulation",
]);

export interface WebMcpApprovalRequest {
  id: string;
  toolName: string;
  label: string;
  kind: WebMcpActivityKind;
  input: Readonly<Record<string, unknown>>;
  /** Exact serialized arguments that will execute if this request is approved. */
  inputJson: string;
  requestedAt: string;
  railRevision: number;
  nativeDecisionRevision?: number;
  simulationOnly: boolean;
}

export type WebMcpApprovalDecision =
  | boolean
  | {
      approved: boolean;
      reason?: string;
    };

export type WebMcpApprovalHandler = (
  request: WebMcpApprovalRequest,
  options?: { signal?: AbortSignal },
) => Promise<WebMcpApprovalDecision> | WebMcpApprovalDecision;

const TOOL_LABELS: Record<string, string> = {
  inspect_prim_feed: "Inspect PRIM evidence & provenance",
  prepare_shift_brief: "Prepare cross-domain shift brief",
  inspect_network_state: "Inspect network state",
  get_circulation: "Inspect circulation",
  inspect_j1_capacity: "Inspect D-1 capacity",
  list_operational_incidents: "List operational incidents",
  inspect_schedule_plan: "Inspect schedule plan",
  preview_schedule_change: "Preview schedule change",
  evaluate_schedule_impact: "Evaluate schedule impact",
  apply_reviewed_schedule_change: "Apply reviewed schedule change",
  simulate_track_circuit_closure: "Simulate track-circuit closure",
  simulate_regulation_action: "Simulate regulation action",
  inspect_network_digital_twin: "Inspect native network digital twin",
  inspect_incident_decision_context: "Inspect incident decision context",
  search_operational_procedures: "Search controlled operating procedures",
  get_operational_procedure: "Open controlled procedure revision",
  apply_reviewed_procedure_step: "Apply reviewed procedure step",
  create_simulated_network_incident: "Create simulated network incident",
  control_network_simulation: "Control native network simulation",
};

let invocationCounter = 0;

export function webMcpActivityKind(toolName: string): WebMcpActivityKind {
  if (MUTATING_WEBMCP_TOOL_NAMES.has(toolName)) return "write";
  if (toolName.startsWith("preview_") || toolName.startsWith("evaluate_")) return "analysis";
  return "read";
}

function outputStatus(output: unknown): { status: WebMcpActivityStatus; outcome: string } {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return { status: "completed", outcome: "completed" };
  }
  const value = (output as Record<string, unknown>).status;
  const outcome = typeof value === "string" ? value.replaceAll("_", " ") : "completed";
  if (
    typeof value === "string" &&
    (value === "blocked" || value === "not_found" || value.endsWith("_required"))
  ) {
    return { status: "blocked", outcome };
  }
  return { status: "completed", outcome };
}

function blockedOutput(reason: string, message: string): Record<string, unknown> {
  return {
    status: "blocked",
    reason,
    message,
  };
}

function freezeJsonValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    value.forEach(freezeJsonValue);
  } else {
    Object.values(value as Record<string, unknown>).forEach(freezeJsonValue);
  }
  return Object.freeze(value);
}

function cloneWriteInput(input: Record<string, unknown>): {
  executionInput: Record<string, unknown>;
  approvalInput: Readonly<Record<string, unknown>>;
  inputJson: string;
} {
  const inputJson = JSON.stringify(input);
  if (!inputJson) throw new Error("Tool arguments must be a JSON object.");
  const executionInput = JSON.parse(inputJson) as unknown;
  const approvalInput = JSON.parse(inputJson) as unknown;
  if (
    !executionInput ||
    typeof executionInput !== "object" ||
    Array.isArray(executionInput) ||
    !approvalInput ||
    typeof approvalInput !== "object" ||
    Array.isArray(approvalInput)
  ) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return {
    executionInput: executionInput as Record<string, unknown>,
    approvalInput: freezeJsonValue(approvalInput) as Readonly<Record<string, unknown>>,
    inputJson,
  };
}

function approvalAccepted(decision: WebMcpApprovalDecision): boolean {
  return typeof decision === "boolean" ? decision : decision.approved;
}

function approvalReason(decision: WebMcpApprovalDecision): string {
  if (typeof decision === "boolean" || typeof decision.reason !== "string") {
    return "The operator did not approve this tool call.";
  }
  return decision.reason.trim().slice(0, 160) ||
    "The operator did not approve this tool call.";
}

function wrapToolDefinition(
  definition: WebMcpToolDefinition,
  getSnapshot: () => RailSnapshot,
  dependencies: IccToolDependencies,
  onActivity?: (activity: WebMcpActivity) => void,
  requestApproval?: WebMcpApprovalHandler,
): WebMcpToolDefinition {
  const execute = definition.execute;
  return {
    ...definition,
    execute: async (rawInput, options) => {
      invocationCounter += 1;
      const id = `webmcp-${Date.now().toString(36)}-${invocationCounter.toString(36)}`;
      const startedAt = new Date().toISOString();
      const kind = webMcpActivityKind(definition.name);
      const base = {
        id,
        toolName: definition.name,
        label: TOOL_LABELS[definition.name] ?? definition.name.replaceAll("_", " "),
        kind,
        startedAt,
      };
      try {
        let input = rawInput;
        const approvalRequired = kind === "write";
        if (approvalRequired) {
          const cloned = cloneWriteInput(rawInput);
          input = cloned.executionInput;
          onActivity?.({
            ...base,
            status: "awaiting_approval",
            outcome: "human approval required",
          });
          if (options?.signal?.aborted) {
            const output = blockedOutput(
              "request_aborted",
              "The request was cancelled before operator approval.",
            );
            onActivity?.({
              ...base,
              ...outputStatus(output),
              completedAt: new Date().toISOString(),
            });
            return output;
          }
          if (!requestApproval) {
            const output = blockedOutput(
              "human_approval_unavailable",
              "Operator approval is unavailable for this WebMCP tool call.",
            );
            onActivity?.({
              ...base,
              ...outputStatus(output),
              completedAt: new Date().toISOString(),
            });
            return output;
          }
          let decision: WebMcpApprovalDecision;
          try {
            const snapshot = getSnapshot();
            decision = await requestApproval({
              id,
              toolName: definition.name,
              label: base.label,
              kind,
              input: cloned.approvalInput,
              inputJson: cloned.inputJson,
              requestedAt: startedAt,
              railRevision: snapshot.revision,
              nativeDecisionRevision:
                dependencies.nativeNetwork?.getSnapshot().decisionRevision,
              simulationOnly: kind === "write",
            }, { signal: options?.signal });
          } catch (error) {
            const aborted = options?.signal?.aborted ||
              (error instanceof Error && error.name === "AbortError");
            const output = blockedOutput(
              aborted ? "request_aborted" : "human_approval_unavailable",
              aborted
                ? "The request was cancelled before operator approval."
                : "The operator approval request could not be completed.",
            );
            onActivity?.({
              ...base,
              ...outputStatus(output),
              completedAt: new Date().toISOString(),
            });
            return output;
          }
          if (!approvalAccepted(decision)) {
            const output = blockedOutput(
              "human_approval_rejected",
              approvalReason(decision),
            );
            onActivity?.({
              ...base,
              ...outputStatus(output),
              completedAt: new Date().toISOString(),
            });
            return output;
          }
          if (options?.signal?.aborted) {
            const output = blockedOutput(
              "request_aborted",
              "The request was cancelled before the approved mutation executed.",
            );
            onActivity?.({
              ...base,
              ...outputStatus(output),
              completedAt: new Date().toISOString(),
            });
            return output;
          }
        }

        onActivity?.({ ...base, status: "running", outcome: "running" });
        const output = await execute(input, options);
        const result = outputStatus(output);
        onActivity?.({ ...base, ...result, completedAt: new Date().toISOString() });
        return output;
      } catch (error) {
        onActivity?.({
          ...base,
          status: "failed",
          outcome: error instanceof Error ? error.message.slice(0, 80) : "tool failed",
          completedAt: new Date().toISOString(),
        });
        throw error;
      }
    },
  };
}

export function createIccToolCatalog(
  getSnapshot: () => RailSnapshot,
  dependencies: IccToolDependencies,
  onActivity?: (activity: WebMcpActivity) => void,
  requestApproval?: WebMcpApprovalHandler,
): WebMcpToolDefinition[] {
  return createIccTools(getSnapshot, dependencies).map((definition) =>
    wrapToolDefinition(
      definition,
      getSnapshot,
      dependencies,
      onActivity,
      requestApproval,
    )
  );
}

export async function registerIccTools(
  getSnapshot: () => RailSnapshot,
  dependencies: IccToolDependencies,
  onActivity?: (activity: WebMcpActivity) => void,
  requestApproval?: WebMcpApprovalHandler,
): Promise<RegistrationResult> {
  const definitions = createIccToolCatalog(
    getSnapshot,
    dependencies,
    onActivity,
    requestApproval,
  );
  const context = document.modelContext;
  if (!context || typeof context.registerTool !== "function") {
    return {
      supported: false,
      count: 0,
      names: definitions.map((tool) => tool.name),
      tools: definitions,
      dispose: async () => undefined,
    };
  }
  const controller = new AbortController();
  try {
    for (const definition of definitions) {
      await context.registerTool(definition, { signal: controller.signal });
    }
  } catch (error) {
    controller.abort();
    throw error;
  }
  return {
    supported: true,
    count: definitions.length,
    names: definitions.map((tool) => tool.name),
    tools: definitions,
    dispose: async () => controller.abort(),
  };
}
