export const PROCEDURE_FEEDBACK_FIELDS = [
  "title",
  "instruction",
  "rationale",
  "responsibleRole",
  "preconditions",
  "evidenceRequired",
  "completionCriteria",
  "minSeconds",
  "nominalSeconds",
  "maxSeconds",
] as const;

export type ProcedureFeedbackField = typeof PROCEDURE_FEEDBACK_FIELDS[number];

export type ProcedureFeedbackBasis =
  | "operator-history"
  | "operational-rex"
  | "public-source"
  | "general-knowledge";

export type ProcedureFeedbackValues = Record<ProcedureFeedbackField, string>;

export interface ProcedureFeedbackRequest {
  procedureId: string;
  expectedProcedureRevision: string;
  expectedProcedureContentHash: string;
  stepId: string;
  values: ProcedureFeedbackValues;
}

export interface ProcedureFieldFeedback {
  field: ProcedureFeedbackField;
  assessment: string;
  suggestion: string;
  rationale: string;
  logEntryIds: readonly string[];
  basis: readonly ProcedureFeedbackBasis[];
}

export interface ProcedureFeedbackSource {
  sourceId: string;
  title: string;
  url: string;
  domain: string;
}

export interface ProcedureFeedbackResponse {
  status: "feedback_ready";
  schemaVersion: "procedure-edit-feedback.v1";
  procedureId: string;
  procedureRevision: string;
  procedureContentHash: string;
  stepId: string;
  draftFingerprint: string;
  generatedAt: number;
  feedbackMode: "agent-grounded" | "general-guidance";
  modelAssisted: boolean;
  model?: string;
  webResearchPerformed: boolean;
  summary: string;
  webResearchSummary: string;
  cautions: readonly string[];
  evidenceCounts: {
    previousEdits: number;
    operatorActions: number;
    rexLogEntries: number;
    procedureExecutions: number;
    publicSources: number;
  };
  fieldFeedback: readonly ProcedureFieldFeedback[];
  sources: readonly ProcedureFeedbackSource[];
  warning: string | null;
  advisoryOnly: true;
}

export type ProcedureFeedbackHandler = (
  input: ProcedureFeedbackRequest,
) => Promise<ProcedureFeedbackResponse>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function requestProcedureFeedback(
  input: ProcedureFeedbackRequest,
): Promise<ProcedureFeedbackResponse> {
  const response = await fetch("/api/procedures/feedback", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new Error(
      typeof body.message === "string" && body.message.trim()
        ? body.message
        : "The procedure feedback request failed.",
    );
  }
  const counts = record(body.evidenceCounts);
  const fields = Array.isArray(body.fieldFeedback) ? body.fieldFeedback : [];
  const observedFields = new Set(fields.map((item) => record(item)?.field));
  if (
    body.status !== "feedback_ready" ||
    body.schemaVersion !== "procedure-edit-feedback.v1" ||
    typeof body.procedureId !== "string" ||
    typeof body.procedureRevision !== "string" ||
    typeof body.procedureContentHash !== "string" ||
    typeof body.stepId !== "string" ||
    typeof body.draftFingerprint !== "string" ||
    typeof body.summary !== "string" ||
    !counts ||
    !PROCEDURE_FEEDBACK_FIELDS.every((field) => observedFields.has(field))
  ) {
    throw new Error("The server returned an invalid procedure feedback response.");
  }
  return body as unknown as ProcedureFeedbackResponse;
}
