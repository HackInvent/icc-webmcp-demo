import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineId } from "../domain";
import { createInitialSnapshot } from "../scenario";
import { loadPassengerFeed } from "./feed";
import { createPrimReplayPayload } from "./replay";

describe("PRIM live/replay feed loader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the live proxy for four lines and parses all responses through SIRI Lite", async () => {
    const snapshot = { ...createInitialSnapshot(), timestamp: Date.now() };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const lineId = url.searchParams.get("lineId") as LineId;
      return new Response(JSON.stringify(createPrimReplayPayload(snapshot, lineId)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadPassengerFeed({
      mode: "prim-live",
      snapshot,
      endpoint: "https://icc.example/.netlify/functions/prim-line",
    });

    expect(result.status).toBe("ready");
    expect(result.observations).toHaveLength(12);
    expect(result.observations.every((observation) => observation.quality === "live")).toBe(true);
    expect(result.lines.every((line) => line.status === "ready")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining("lineId=RER_A"),
      expect.stringContaining("lineId=RER_B"),
      expect.stringContaining("lineId=M13"),
      expect.stringContaining("lineId=M14"),
    ]));
  });

  it("keeps successful lines visible when one live line fails", async () => {
    const snapshot = createInitialSnapshot();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const lineId = new URL(String(input)).searchParams.get("lineId") as LineId;
      if (lineId === "M14") return new Response("upstream unavailable", { status: 503 });
      return new Response(JSON.stringify(createPrimReplayPayload(snapshot, lineId)), { status: 200 });
    }));

    const result = await loadPassengerFeed({
      mode: "prim-live",
      snapshot,
      endpoint: "https://icc.example/prim",
    });

    expect(result.status).toBe("partial");
    expect(result.observations).toHaveLength(9);
    expect(result.error).toContain("1/4 line feeds unavailable: M14");
    expect(result.lines.find((line) => line.lineId === "M14")).toEqual(expect.objectContaining({
      status: "error",
      observationCount: 0,
      error: expect.stringContaining("503"),
    }));
  });
});
