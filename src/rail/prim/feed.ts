import type {
  LineId,
  PassengerFeedLineStatus,
  PassengerFeedMode,
  PassengerFeedSnapshot,
  RailSnapshot,
} from "../domain";
import {
  parsePrimSiriLine,
  PRIM_LINE_IDS,
  PRIM_LINE_REFS,
  type ParsedPrimLine,
} from "./contract";
import { createPrimReplayPayload } from "./replay";

export const PRIM_LIMITATIONS = [
  "PRIM SIRI Lite supplies passenger estimated calls, not continuous vehicle positions.",
  "Track-circuit occupancy, signalling, traction power and crew resources remain deterministic simulation data.",
  "This connector is read-only: no command is sent to Île-de-France Mobilités or a railway operator.",
] as const;

export const DEFAULT_PRIM_PROXY_ENDPOINT = "/.netlify/functions/prim-line";

export function emptyPassengerFeed(mode: PassengerFeedMode): PassengerFeedSnapshot {
  return {
    mode,
    status: mode === "simulation" ? "idle" : "loading",
    provider: "Île-de-France Mobilités PRIM",
    contract: "SIRI Lite Estimated Timetable",
    requestedAt: null,
    receivedAt: null,
    endpoint: mode === "prim-live" ? DEFAULT_PRIM_PROXY_ENDPOINT : null,
    observations: [],
    lines: PRIM_LINE_IDS.map((lineId) => ({
      lineId,
      lineRef: PRIM_LINE_REFS[lineId],
      status: "error",
      observationCount: 0,
      responseTimestamp: null,
      error: mode === "simulation" ? "Passenger feed disabled." : "Waiting for first refresh.",
    })),
    limitations: [...PRIM_LIMITATIONS],
    error: null,
  };
}

interface LoadPassengerFeedOptions {
  mode: Exclude<PassengerFeedMode, "simulation">;
  snapshot: RailSnapshot;
  endpoint?: string;
  signal?: AbortSignal;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "Unknown PRIM connector error.";
}

async function loadLiveLine(
  endpoint: string,
  lineId: LineId,
  signal?: AbortSignal,
): Promise<ParsedPrimLine> {
  const separator = endpoint.includes("?") ? "&" : "?";
  const response = await fetch(`${endpoint}${separator}lineId=${encodeURIComponent(lineId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 180);
    throw new Error(`PRIM proxy returned ${response.status}${message ? `: ${message}` : ""}`);
  }
  return parsePrimSiriLine(await response.json() as unknown, lineId, "live");
}

export async function loadPassengerFeed({
  mode,
  snapshot,
  endpoint = DEFAULT_PRIM_PROXY_ENDPOINT,
  signal,
}: LoadPassengerFeedOptions): Promise<PassengerFeedSnapshot> {
  const requestedAt = new Date().toISOString();
  const results = await Promise.allSettled(
    PRIM_LINE_IDS.map(async (lineId) => mode === "prim-live"
      ? loadLiveLine(endpoint, lineId, signal)
      : parsePrimSiriLine(
          createPrimReplayPayload(snapshot, lineId),
          lineId,
          "simulated",
          requestedAt,
        )),
  );
  const parsed: ParsedPrimLine[] = [];
  const lines: PassengerFeedLineStatus[] = results.map((result, index) => {
    const lineId = PRIM_LINE_IDS[index];
    if (result.status === "fulfilled") {
      parsed.push(result.value);
      return {
        lineId,
        lineRef: result.value.lineRef,
        status: "ready",
        observationCount: result.value.observations.length,
        responseTimestamp: result.value.responseTimestamp,
        error: null,
      };
    }
    return {
      lineId,
      lineRef: PRIM_LINE_REFS[lineId],
      status: "error",
      observationCount: 0,
      responseTimestamp: null,
      error: safeError(result.reason),
    };
  });
  const failed = lines.filter((line) => line.status === "error");
  const status = failed.length === 0 ? "ready" : failed.length === lines.length ? "error" : "partial";
  const error = failed.length === 0
    ? null
    : `${failed.length}/${lines.length} line feeds unavailable: ${failed.map((line) => line.lineId).join(", ")}`;

  return {
    mode,
    status,
    provider: "Île-de-France Mobilités PRIM",
    contract: "SIRI Lite Estimated Timetable",
    requestedAt,
    receivedAt: new Date().toISOString(),
    endpoint: mode === "prim-live" ? endpoint : "embedded://prim-siri-contract-replay",
    observations: parsed.flatMap((line) => line.observations),
    lines,
    limitations: [...PRIM_LIMITATIONS],
    error,
  };
}
