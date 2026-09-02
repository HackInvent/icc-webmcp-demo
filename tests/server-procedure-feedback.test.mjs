import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../server/agent.mjs";
import { createParisIccServer } from "../server/app.mjs";
import {
  buildProcedureFeedbackEvidence,
  generalProcedureFeedback,
  PROCEDURE_FEEDBACK_FIELDS,
} from "../server/procedure-feedback.mjs";
import { OPERATIONAL_PROCEDURE_CATALOGUE } from "../src/procedures/index.ts";
import { parsedServerConfig, TEST_ACCESS_CODE } from "./server-fixture.mjs";

const procedure = OPERATIONAL_PROCEDURE_CATALOGUE[0];
const step = procedure.steps[0];

function editorValues(source = step) {
  return {
    title: source.title,
    instruction: source.instruction,
    rationale: source.rationale,
    responsibleRole: source.responsibleRole,
    preconditions: source.preconditions.join("\n"),
    evidenceRequired: source.evidenceRequired.join("\n"),
    completionCriteria: source.completionCriteria.join("\n"),
    minSeconds: String(source.durationRangeSeconds.minSeconds),
    nominalSeconds: String(source.durationRangeSeconds.nominalSeconds),
    maxSeconds: String(source.durationRangeSeconds.maxSeconds),
  };
}

function requestBody(overrides = {}) {
  return {
    procedureId: procedure.procedureId,
    expectedProcedureRevision: procedure.revision,
    expectedProcedureContentHash: procedure.contentHash,
    stepId: step.stepId,
    values: editorValues(),
    ...overrides,
  };
}

function logEntry(overrides) {
  return {
    id: "LOG-DEFAULT-00001",
    sequence: 1,
    category: "operator-action",
    eventType: "procedure-step-recorded",
    actor: "operator",
    recordedAt: 1_788_000_000_000,
    operationalTime: 1_788_000_000_000,
    title: "Procedure action",
    summary: "Recorded from the operating desk.",
    incidentId: null,
    entityIds: [],
    durationSeconds: 60,
    ...overrides,
  };
}

function evidenceSnapshot() {
  return {
    procedureCatalogue: undefined,
    procedureExecutions: [{
      incidentId: "INC-PROCEDURE-REX-01",
      procedureId: procedure.procedureId,
      procedureRevision: procedure.revision,
      completedStepIds: [step.stepId],
      stepRecords: [{
        stepId: step.stepId,
        receiptId: "RECEIPT-PROCEDURE-01",
        recordedAt: 1_788_000_060_000,
        operatorEvidenceReference: null,
        evidenceKind: null,
      }],
      recoveryStartedAt: null,
    }],
    shift: {
      logs: [
        logEntry({
          id: "LOG-EDIT-00001",
          eventType: "procedure-step-revision-published",
          entityIds: [procedure.procedureId, step.stepId],
        }),
        logEntry({
          id: "LOG-REX-00002",
          sequence: 2,
          incidentId: "INC-PROCEDURE-REX-01",
          entityIds: ["INC-PROCEDURE-REX-01", procedure.procedureId, step.stepId],
        }),
        logEntry({
          id: "LOG-UNRELATED-00003",
          sequence: 3,
          incidentId: "INC-OTHER-01",
          entityIds: ["ICC-PROC-OTHER-001"],
          summary: "UNRELATED-SHOULD-NOT-LEAVE-SERVER",
        }),
      ],
    },
  };
}

function modelDraft() {
  return {
    schemaVersion: "procedure-edit-feedback.v1",
    summary: "The draft is usable, but evidence wording can be made more observable.",
    webResearchSummary: "A public railway safety source supports explicit evidence and completion wording.",
    fieldFeedback: PROCEDURE_FEEDBACK_FIELDS.map((field) => ({
      field,
      assessment: `${field} was reviewed against the available evidence.`,
      suggestion: `Make ${field} concise, observable and bounded.`,
      rationale: "The operator must be able to verify the intended result.",
      logEntryIds: field === "title"
        ? ["LOG-EDIT-00001"]
        : field === "instruction"
          ? ["LOG-REX-00002"]
          : [],
      basis: field === "title"
        ? ["operator-history"]
        : field === "instruction"
          ? ["operational-rex", "public-source"]
          : ["general-knowledge"],
    })),
    cautions: ["Keep local authority and human approval gates unchanged."],
    advisoryOnly: true,
  };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie.");
  return value.split(";", 1)[0];
}

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

describe("procedure edit feedback evidence", () => {
  it("limits context to the selected procedure and produces guidance for every field when no agent result exists", () => {
    const evidence = buildProcedureFeedbackEvidence(
      evidenceSnapshot(),
      requestBody(),
      1_788_000_120_000,
    );

    expect(evidence.history.logEntries.map((entry) => entry.id)).toEqual([
      "LOG-EDIT-00001",
      "LOG-REX-00002",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("UNRELATED-SHOULD-NOT-LEAVE-SERVER");
    expect(evidence.evidenceCounts).toEqual({
      previousEdits: 1,
      operatorActions: 2,
      rexLogEntries: 1,
      procedureExecutions: 1,
    });

    const fallback = generalProcedureFeedback(evidence, "Agent unavailable.");
    expect(fallback).toMatchObject({
      feedbackMode: "general-guidance",
      modelAssisted: false,
      warning: "Agent unavailable.",
      evidenceCounts: { publicSources: 0 },
    });
    expect(fallback.fieldFeedback.map((item) => item.field)).toEqual(PROCEDURE_FEEDBACK_FIELDS);
    expect(fallback.fieldFeedback.every((item) => item.basis.includes("general-knowledge"))).toBe(true);
  });

  it("rejects a stale procedure revision before any model or web request", () => {
    expect(() => buildProcedureFeedbackEvidence(
      evidenceSnapshot(),
      requestBody({ expectedProcedureRevision: "stale-revision" }),
    )).toThrowError(expect.objectContaining({
      code: "stale_procedure_revision",
      status: 409,
    }));
  });
});

describe("server-hosted procedure feedback agent", () => {
  it("uses web search, verified citations and only procedure-linked REX", async () => {
    const evidence = buildProcedureFeedbackEvidence(evidenceSnapshot(), requestBody(), 1_788_000_120_000);
    const requests = [];
    const runtimeLog = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        output: [
          {
            type: "web_search_call",
            id: "ws-procedure-01",
            status: "completed",
            action: {
              type: "search",
              sources: [{
                type: "url",
                title: "Public railway safety guidance",
                url: "https://rail.example.org/public-guidance#evidence",
              }],
            },
          },
          {
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: JSON.stringify(modelDraft()),
              annotations: [{
                type: "url_citation",
                title: "Public railway safety guidance",
                url: "https://rail.example.org/public-guidance#evidence",
                start_index: 10,
                end_index: 20,
              }],
            }],
          },
        ],
        usage: { input_tokens: 420, output_tokens: 240 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl,
      runtimeStore: {
        currentModel: () => "gpt-5.6-sol",
        currentReasoningEffort: () => "high",
        record: async (entry) => runtimeLog.push(entry),
      },
    });

    const result = await service.reviewProcedureEdit(evidence);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "gpt-5.6-sol",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      max_tool_calls: 3,
      include: ["web_search_call.action.sources"],
      reasoning: { effort: "high" },
      store: false,
      text: { format: { type: "json_schema", name: "procedure_edit_feedback", strict: true } },
    });
    expect(JSON.stringify(requests[0].input)).toContain("LOG-EDIT-00001");
    expect(JSON.stringify(requests[0].input)).toContain("LOG-REX-00002");
    expect(JSON.stringify(requests[0].input)).not.toContain("UNRELATED-SHOULD-NOT-LEAVE-SERVER");
    expect(result.feedback).toMatchObject({
      feedbackMode: "agent-grounded",
      modelAssisted: true,
      model: "gpt-5.6-sol",
      webResearchPerformed: true,
      sources: [{
        sourceId: "WEB-01",
        url: "https://rail.example.org/public-guidance",
        domain: "rail.example.org",
      }],
    });
    expect(result.feedback.fieldFeedback).toHaveLength(PROCEDURE_FEEDBACK_FIELDS.length);
    expect(result.feedback.fieldFeedback.find((item) => item.field === "title")).toMatchObject({
      logEntryIds: ["LOG-EDIT-00001"],
      basis: ["operator-history"],
    });
    expect(runtimeLog).toEqual([expect.objectContaining({
      category: "procedure",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      entityId: procedure.procedureId,
      outcome: "completed",
      inputTokens: 420,
      outputTokens: 240,
    })]);
  });
});

describe("procedure feedback HTTP endpoint", () => {
  it("is authenticated, revision-safe and remains useful when OpenAI is disabled", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-procedure-feedback-"));
    const distDirectory = path.join(directory, "dist");
    mkdirSync(distDirectory);
    writeFileSync(path.join(distDirectory, "index.html"), "<!doctype html><title>Paris ICC</title>");
    const config = parsedServerConfig({
      openai: { enabled: false, apiKey: "" },
      storage: {
        databasePath: path.join(directory, "operations.sqlite"),
        agentRuntimePath: path.join(directory, "agent-runtime.json"),
        tickIntervalMs: 5_000,
      },
    });
    config.server.distDirectory = distDirectory;
    const application = createParisIccServer(config);
    await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await application.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const address = application.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const anonymous = await fetch(`${baseUrl}/api/procedures/feedback`, {
      method: "POST",
      headers: {
        Origin: config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    expect(anonymous.status).toBe(401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: TEST_ACCESS_CODE }),
    });
    const cookie = cookieFrom(login);
    const feedbackResponse = await fetch(`${baseUrl}/api/procedures/feedback`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    expect(feedbackResponse.status).toBe(200);
    const feedback = await feedbackResponse.json();
    expect(feedback).toMatchObject({
      status: "feedback_ready",
      feedbackMode: "general-guidance",
      modelAssisted: false,
      procedureId: procedure.procedureId,
      stepId: step.stepId,
      evidenceCounts: { publicSources: 0 },
    });
    expect(feedback.fieldFeedback).toHaveLength(PROCEDURE_FEEDBACK_FIELDS.length);

    const staleResponse = await fetch(`${baseUrl}/api/procedures/feedback`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody({ expectedProcedureRevision: "stale-revision" })),
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ error: "stale_procedure_revision" });
  });
});
