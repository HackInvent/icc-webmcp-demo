import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../server/agent.mjs";
import { parsedServerConfig } from "./server-fixture.mjs";

const EVIDENCE = {
  shiftId: "shift-report-agent-test",
  startedAt: 1_788_000_000_000,
  startedOperationalTime: 1_788_000_000_000,
  latestLogSequence: 2,
  logs: [
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
      incidentId: "INC-RERA-001",
      entityIds: ["INC-RERA-001"],
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
      incidentId: "INC-RERA-001",
      entityIds: ["INC-RERA-001", "S01"],
      durationSeconds: 120,
    },
  ],
};

function responseWithDraft(draft) {
  return new Response(JSON.stringify({
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(draft) }],
    }],
    usage: { input_tokens: 220, output_tokens: 90 },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
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

describe("server-hosted shift-report agent", () => {
  it("reads bounded persisted log evidence and returns only cited structured content", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return responseWithDraft(draft());
    });
    const runtimeLog = [];
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl,
      runtimeStore: {
        currentModel: () => "gpt-5.6-sol",
        record: async (entry) => runtimeLog.push(entry),
      },
    });

    const result = await service.draftShiftReport(EVIDENCE);

    expect(result).toMatchObject({
      draft: {
        schemaVersion: "shift-report-draft.v1",
        advisoryOnly: true,
        notableEvents: [{ logEntryId: "LOG-TEST-00002" }],
      },
      usage: { inputTokens: 220, outputTokens: 90 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "shift_report_draft",
          strict: true,
        },
      },
    });
    expect(JSON.stringify(requests[0].input)).toContain("LOG-TEST-00001");
    expect(requests[0].instructions).toContain("persisted shift-log evidence");
    expect(runtimeLog).toEqual([
      expect.objectContaining({
        category: "report",
        model: "gpt-5.6-sol",
        outcome: "completed",
        inputTokens: 220,
        outputTokens: 90,
      }),
    ]);
  });

  it("rejects a model draft that cites a log entry not present in evidence", async () => {
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: async () => responseWithDraft(draft({
        notableEvents: [{
          logEntryId: "LOG-INVENTED-99999",
          narrative: "This event was invented and must be rejected.",
        }],
      })),
    });

    await expect(service.draftShiftReport(EVIDENCE)).rejects.toMatchObject({
      code: "invalid_report_draft",
      status: 502,
    });
  });
});
