import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROCEDURE_FEEDBACK_FIELDS,
  requestProcedureFeedback,
  type ProcedureFeedbackRequest,
} from "./feedback";

const request: ProcedureFeedbackRequest = {
  procedureId: "ICC-PROC-TEST",
  expectedProcedureRevision: "rev.2",
  expectedProcedureContentHash: "sha256:test",
  stepId: "ICC-PROC-TEST-S01",
  values: Object.fromEntries(
    PROCEDURE_FEEDBACK_FIELDS.map((field) => [field, `${field} draft`]),
  ) as ProcedureFeedbackRequest["values"],
};

function feedbackBody() {
  return {
    status: "feedback_ready",
    schemaVersion: "procedure-edit-feedback.v1",
    procedureId: request.procedureId,
    procedureRevision: request.expectedProcedureRevision,
    procedureContentHash: request.expectedProcedureContentHash,
    stepId: request.stepId,
    draftFingerprint: "sha256:draft",
    generatedAt: Date.UTC(2026, 8, 2, 3, 0, 0),
    feedbackMode: "agent-grounded",
    modelAssisted: true,
    model: "gpt-5.6-terra",
    webResearchPerformed: true,
    summary: "Draft reviewed.",
    webResearchSummary: "Public operational guidance was consulted.",
    cautions: [],
    evidenceCounts: {
      previousEdits: 1,
      operatorActions: 2,
      rexLogEntries: 3,
      procedureExecutions: 1,
      publicSources: 1,
    },
    fieldFeedback: PROCEDURE_FEEDBACK_FIELDS.map((field) => ({
      field,
      assessment: `${field} assessment`,
      suggestion: `${field} suggestion`,
      rationale: `${field} rationale`,
      logEntryIds: [],
      basis: ["general-knowledge"],
    })),
    sources: [{
      sourceId: "WEB-01",
      title: "Public authority guidance",
      url: "https://example.test/guidance",
      domain: "example.test",
    }],
    warning: null,
    advisoryOnly: true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("procedure feedback browser client", () => {
  it("posts the exact editor draft through the authenticated same-origin endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(feedbackBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestProcedureFeedback(request)).resolves.toMatchObject({
      procedureId: request.procedureId,
      fieldFeedback: expect.arrayContaining([
        expect.objectContaining({ field: "completionCriteria" }),
      ]),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/procedures/feedback", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  });

  it("shows the server conflict message when the procedure revision is stale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "stale_procedure_revision",
      message: "Reopen the procedure before requesting feedback.",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(requestProcedureFeedback(request))
      .rejects.toThrow("Reopen the procedure before requesting feedback.");
  });

  it("rejects a nominal response that omits feedback for an editable field", async () => {
    const incomplete = feedbackBody();
    incomplete.fieldFeedback = incomplete.fieldFeedback.filter(
      (item) => item.field !== "maxSeconds",
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(incomplete), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(requestProcedureFeedback(request))
      .rejects.toThrow("invalid procedure feedback response");
  });
});
