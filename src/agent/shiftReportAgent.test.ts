import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  generateShiftReportDraft,
  SHIFT_LOG_TOOL_NAME,
  type ShiftReportAgentProgress,
  type ShiftReportDraft,
} from "./shiftReportAgent";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const REPORT_ID = "report-client-test";
const SHIFT_ID = "shift-client-test";

beforeAll(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { modelContext: undefined },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function pageOutput() {
  return {
    status: "shift_log_page_ready",
    source: "authenticated_server_persisted_shift_log",
    shiftId: SHIFT_ID,
    reportId: REPORT_ID,
    reportStatus: "draft",
    startedAt: 1_788_000_000_000,
    startedOperationalTime: 1_788_000_000_000,
    latestLogSequence: 1,
    page: {
      afterSequence: 0,
      limit: 80,
      count: 1,
      nextAfterSequence: null,
      hasMore: false,
    },
    logs: [{
      id: "LOG-CLIENT-00001",
      sequence: 1,
      title: "Shift opened",
      summary: "Operations shift opened.",
    }],
  };
}

function draft(): ShiftReportDraft {
  return {
    schemaVersion: "shift-report-draft.v1",
    executiveSummary: "The operational shift opened with no unresolved event.",
    notableEvents: [{
      logEntryId: "LOG-CLIENT-00001",
      narrative: "The operations shift opened.",
    }],
    investigationPoints: [],
    handoverItems: [],
    advisoryOnly: true,
  };
}

function tool(): WebMcpToolDefinition {
  return {
    name: SHIFT_LOG_TOOL_NAME,
    description: "Read the persisted current-shift log.",
    inputSchema: {
      type: "object",
      properties: {
        reportId: { type: "string" },
        afterSequence: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["reportId", "afterSequence", "limit"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: vi.fn(async () => pageOutput()),
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function finalized(modelAssisted: boolean) {
  return {
    status: "draft_ready",
    reportId: REPORT_ID,
    html: "<h1>End-of-shift report</h1>",
    modelAssisted,
    warning: modelAssisted ? null : "Deterministic chronology.",
    sourceLogCount: 1,
    sourceLogSequence: 1,
  };
}

describe("Shift Report WebMCP browser agent", () => {
  it("still inspects the page tool before deterministic fallback when OpenAI is disabled", async () => {
    const shiftTool = tool();
    const progress: ShiftReportAgentProgress[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/reports/assist");
      expect(JSON.parse(String(init?.body))).toEqual({
        reportId: REPORT_ID,
        expectedShiftId: SHIFT_ID,
        expectedLogSequence: 1,
      });
      return jsonResponse(finalized(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateShiftReportDraft({
      reportId: REPORT_ID,
      expectedToolNames: [SHIFT_LOG_TOOL_NAME],
      inPageTools: [shiftTool],
      modelEnabled: false,
      signal: new AbortController().signal,
      onProgress: (state) => progress.push(state),
    });

    expect(shiftTool.execute).toHaveBeenCalledWith(
      { reportId: REPORT_ID, afterSequence: 0, limit: 80 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(progress).toEqual(["discovering", "inspecting", "finalizing"]);
    expect(result).toMatchObject({
      transport: "in-page",
      modelAssisted: false,
      shiftId: SHIFT_ID,
      sourceLogCount: 1,
    });
  });

  it("executes the model-requested page tool and finalizes the cited WebMCP draft", async () => {
    const shiftTool = tool();
    let turn = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agent/turn") {
        turn += 1;
        if (turn === 1) {
          return jsonResponse({
            status: "tool_calls",
            runId: "run-shift-client",
            calls: [{
              callId: "call-shift-client",
              name: SHIFT_LOG_TOOL_NAME,
              arguments: { reportId: REPORT_ID, afterSequence: 0, limit: 80 },
            }],
          });
        }
        return jsonResponse({
          status: "completed",
          runId: "run-shift-client",
          recommendation: draft(),
          evidence: {
            shiftId: SHIFT_ID,
            reportId: REPORT_ID,
            latestLogSequence: 1,
            logCount: 1,
          },
          usage: { inputTokens: 100, outputTokens: 50 },
        });
      }
      if (url === "/api/agent/reset") return jsonResponse({ status: "reset" });
      if (url === "/api/reports/assist") {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          reportId: REPORT_ID,
          expectedShiftId: SHIFT_ID,
          expectedLogSequence: 1,
          draft: draft(),
        });
        return jsonResponse(finalized(true));
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateShiftReportDraft({
      reportId: REPORT_ID,
      expectedToolNames: [SHIFT_LOG_TOOL_NAME],
      inPageTools: [shiftTool],
      modelEnabled: true,
      signal: new AbortController().signal,
    });

    expect(turn).toBe(2);
    expect(shiftTool.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      modelAssisted: true,
      transport: "in-page",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
  });
});
