import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../server/agent.mjs";
import { parsedServerConfig } from "./server-fixture.mjs";

const REPORT_ID = "report-shift-agent-test";
const SHIFT_ID = "shift-report-agent-test";
const SHIFT_TOOL = {
  name: "inspect_shift_log",
  description: "Read one bounded chronological page from the persisted current-shift log.",
  inputSchema: {
    type: "object",
    properties: {
      reportId: { type: "string" },
      afterSequence: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 80 },
    },
    required: ["reportId", "afterSequence", "limit"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const LOGS = [
  {
    id: "LOG-TEST-00001",
    sequence: 1,
    category: "incident",
    eventType: "incident-present",
    actor: "system",
    recordedAt: 1_788_000_000_000,
    operationalTime: 1_788_000_000_000,
    title: "Signal detection failure",
    summary: "RER A · Auber · active",
    summaryTruncated: false,
    incidentId: "INC-RERA-001",
    entityIds: ["INC-RERA-001"],
    entityIdsTruncated: false,
    durationSeconds: 0,
  },
  {
    id: "LOG-TEST-00002",
    sequence: 2,
    category: "operator-action",
    eventType: "procedure-step-recorded",
    actor: "operator",
    recordedAt: 1_788_000_120_000,
    operationalTime: 1_788_000_120_000,
    title: "Protection step recorded",
    summary: "Procedure step S01 recorded.",
    summaryTruncated: false,
    incidentId: "INC-RERA-001",
    entityIds: ["INC-RERA-001", "S01"],
    entityIdsTruncated: false,
    durationSeconds: 120,
  },
];

function toolPage(logs, options = {}) {
  const latestLogSequence = options.latestLogSequence ?? LOGS.at(-1).sequence;
  const afterSequence = options.afterSequence ?? 0;
  const hasMore = options.hasMore ?? false;
  return {
    status: "shift_log_page_ready",
    source: "authenticated_server_persisted_shift_log",
    shiftId: SHIFT_ID,
    reportId: REPORT_ID,
    reportStatus: "draft",
    startedAt: 1_788_000_000_000,
    startedOperationalTime: 1_788_000_000_000,
    latestLogSequence,
    page: {
      afterSequence,
      limit: 80,
      count: logs.length,
      nextAfterSequence: hasMore ? logs.at(-1).sequence : null,
      hasMore,
    },
    logs,
    guardrails: {
      readOnly: true,
      chronological: true,
      operatorReviewRequired: true,
    },
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function toolCall(callId, afterSequence) {
  return jsonResponse({
    output: [{
      type: "function_call",
      call_id: callId,
      name: SHIFT_TOOL.name,
      arguments: JSON.stringify({
        reportId: REPORT_ID,
        afterSequence,
        limit: 80,
      }),
    }],
    usage: { input_tokens: 50, output_tokens: 12 },
  });
}

function responseWithDraft(draft) {
  return jsonResponse({
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(draft) }],
    }],
    usage: { input_tokens: 220, output_tokens: 90 },
  });
}

function draft(overrides = {}) {
  return {
    schemaVersion: "shift-report-draft.v1",
    executiveSummary: "One signalling incident required protection within two minutes of the logged occurrence.",
    notableEvents: [{
      logEntryId: "LOG-TEST-00002",
      narrative: "The operator recorded the protection step 120 seconds after the incident entry.",
    }],
    investigationPoints: [{
      title: "Detection failure follow-up",
      narrative: "Review the detection failure and protection chronology.",
      logEntryIds: ["LOG-TEST-00001", "LOG-TEST-00002"],
    }],
    handoverItems: [],
    advisoryOnly: true,
    ...overrides,
  };
}

async function completeSinglePageRun(service) {
  const first = await service.turn("shift-session", {
    outputMode: "shift_report",
    reportId: REPORT_ID,
    tools: [SHIFT_TOOL],
  });
  expect(first).toEqual(expect.objectContaining({
    status: "tool_calls",
    calls: [{
      callId: "call-shift-log-1",
      name: SHIFT_TOOL.name,
      arguments: { reportId: REPORT_ID, afterSequence: 0, limit: 80 },
    }],
  }));
  return service.turn("shift-session", {
    runId: first.runId,
    toolOutputs: [{
      callId: "call-shift-log-1",
      output: toolPage(LOGS),
    }],
  });
}

describe("Shift Report server-side WebMCP agent mode", () => {
  it("forces a read-only WebMCP log inspection before returning cited content", async () => {
    const requests = [];
    const runtimeLog = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1
        ? toolCall("call-shift-log-1", 0)
        : responseWithDraft(draft());
    });
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl,
      runtimeStore: {
        currentModel: () => "gpt-5.6-sol",
        currentReasoningEffort: () => "low",
        record: async (entry) => runtimeLog.push(entry),
      },
    });

    const result = await completeSinglePageRun(service);

    expect(result).toMatchObject({
      status: "completed",
      recommendation: {
        schemaVersion: "shift-report-draft.v1",
        advisoryOnly: true,
        notableEvents: [{ logEntryId: "LOG-TEST-00002" }],
      },
      evidence: {
        shiftId: SHIFT_ID,
        reportId: REPORT_ID,
        latestLogSequence: 2,
        logCount: 2,
      },
      usage: { inputTokens: 220, outputTokens: 90 },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: "gpt-5.6-sol",
      tool_choice: { type: "function", name: SHIFT_TOOL.name },
      tools: [{ type: "function", name: SHIFT_TOOL.name }],
      parallel_tool_calls: false,
      text: {
        format: {
          type: "json_schema",
          name: "shift_report_draft",
          strict: true,
        },
      },
      store: false,
    });
    expect(requests[0].instructions).toContain("WebMCP");
    expect(requests[1].tool_choice).toBe("none");
    expect(JSON.stringify(requests[1].input)).toContain("LOG-TEST-00001");
    expect(runtimeLog).toEqual([
      expect.objectContaining({
        category: "report",
        outcome: "tool_calls",
        toolNames: [SHIFT_TOOL.name],
      }),
      expect.objectContaining({
        category: "report",
        outcome: "completed",
        inputTokens: 220,
        outputTokens: 90,
      }),
    ]);
  });

  it("follows the exact pagination cursor before allowing the final draft", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) return toolCall("call-shift-log-1", 0);
      if (requests.length === 2) return toolCall("call-shift-log-2", 1);
      return responseWithDraft(draft());
    });
    const service = new AgentService(parsedServerConfig(), { fetchImpl });
    const first = await service.turn("shift-pages", {
      outputMode: "shift_report",
      reportId: REPORT_ID,
      tools: [SHIFT_TOOL],
    });
    const second = await service.turn("shift-pages", {
      runId: first.runId,
      toolOutputs: [{
        callId: "call-shift-log-1",
        output: toolPage([LOGS[0]], { latestLogSequence: 2, hasMore: true }),
      }],
    });
    expect(second.calls[0].arguments.afterSequence).toBe(1);
    const completed = await service.turn("shift-pages", {
      runId: second.runId,
      toolOutputs: [{
        callId: "call-shift-log-2",
        output: toolPage([LOGS[1]], {
          latestLogSequence: 2,
          afterSequence: 1,
          hasMore: false,
        }),
      }],
    });
    expect(completed.status).toBe("completed");
    expect(completed.evidence.logCount).toBe(2);
    expect(requests).toHaveLength(3);
  });

  it("rejects a model draft that cites a log entry absent from WebMCP evidence", async () => {
    const requests = [];
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return requests.length === 1
          ? toolCall("call-shift-log-1", 0)
          : responseWithDraft(draft({
              notableEvents: [{
                logEntryId: "LOG-INVENTED-99999",
                narrative: "This event was invented and must be rejected.",
              }],
            }));
      },
    });

    await expect(completeSinglePageRun(service)).rejects.toMatchObject({
      code: "invalid_report_draft",
      status: 502,
    });
  });
});
