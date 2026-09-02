import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../server/agent.mjs";
import { parsedServerConfig } from "./server-fixture.mjs";

const PASSENGER_TOOL = {
  name: "inspect_passenger_flow_impact",
  description: "Read active incident scopes and their observed station waiting queues.",
  inputSchema: {
    type: "object",
    properties: { line: { type: "string", enum: ["ALL", "RER_A", "M14", "M13"] } },
    required: ["line"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const CANDIDATES = [
  {
    incidentId: "INC-RERA-SIGNAL",
    incidentCode: "ICC-INC-INF-INT-BLK-001",
    title: "Loss of train detection on the central trunk",
    lineCode: "RER_A",
    location: "Châtelet - Les Halles — Auber",
    severity: "critical",
    occurrenceTime: "2026-08-28T11:00:00.000Z",
    waitingQueuePassengers: 332,
    arrivalsPerMinute: 166.67,
    affectedStationCount: 2,
    impactedTrainCount: 1,
    passengersOnImpactedTrains: 700,
    queueHotspots: [{
      stationCode: "IDFM:474151",
      stationName: "Châtelet - Les Halles",
      waitingPassengers: 166,
    }],
    evidenceRank: 1,
  },
  {
    incidentId: "INC-M14-POWER",
    incidentCode: "ICC-INC-INF-INT-BLK-002",
    title: "Traction power instability in the central section",
    lineCode: "M14",
    location: "Châtelet — Gare de Lyon",
    severity: "high",
    occurrenceTime: "2026-08-28T11:01:00.000Z",
    waitingQueuePassengers: 66,
    arrivalsPerMinute: 33.1,
    affectedStationCount: 2,
    impactedTrainCount: 0,
    passengersOnImpactedTrains: 0,
    queueHotspots: [{
      stationCode: "IDFM:71264",
      stationName: "Châtelet",
      waitingPassengers: 33,
    }],
    evidenceRank: 2,
  },
  {
    incidentId: "INC-M13-WORKS",
    incidentCode: "ICC-INC-WRK-INT-BLK-001",
    title: "Engineering possession intruding into the operating window",
    lineCode: "M13",
    location: "Place de Clichy — La Fourche",
    severity: "high",
    occurrenceTime: "2026-08-28T11:02:00.000Z",
    waitingQueuePassengers: 32,
    arrivalsPerMinute: 16.79,
    affectedStationCount: 2,
    impactedTrainCount: 1,
    passengersOnImpactedTrains: 722,
    queueHotspots: [{
      stationCode: "IDFM:71435",
      stationName: "Place de Clichy",
      waitingPassengers: 16,
    }],
    evidenceRank: 3,
  },
];

const TOOL_EVIDENCE = {
  status: "passenger_flow_context_ready",
  objective: "Prioritise active incidents for maximum observed queue relief.",
  scope: {
    line: "ALL",
    observedAt: 1788267600000,
    telemetryRevision: 42,
    decisionRevision: 3,
  },
  selectionMethod: {
    primary: "waitingQueuePassengers descending",
    tieBreakers: ["severity descending"],
    maximumPriorities: 3,
  },
  activeIncidentCount: 3,
  candidates: CANDIDATES,
  resultTruncated: false,
};

function recommendation(priorities = CANDIDATES) {
  return {
    schemaVersion: "passenger-flow-priority-analysis.v1",
    summary: "Review the three active incidents in observed queue-impact order.",
    priorities: priorities.map((candidate, index) => ({
      rank: index + 1,
      incidentId: candidate.incidentId,
      recommendation: `Open the controlled response workflow for ${candidate.incidentCode}.`,
      rationale: `${candidate.waitingQueuePassengers} waiting passengers are currently within this incident scope.`,
    })),
    advisoryOnly: true,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function modelFetch(finalRecommendation, requests) {
  return vi.fn(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return jsonResponse({
        output: [{
          type: "function_call",
          call_id: "call-passenger-impact",
          name: PASSENGER_TOOL.name,
          arguments: JSON.stringify({ line: "ALL" }),
        }],
        usage: { input_tokens: 50, output_tokens: 10 },
      });
    }
    return jsonResponse({
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(finalRecommendation) }],
      }],
      usage: { input_tokens: 200, output_tokens: 90 },
    });
  });
}

async function completeRun(service) {
  const first = await service.turn("passenger-session", {
    outputMode: "passenger_flow_priority",
    line: "ALL",
    tools: [PASSENGER_TOOL],
  });
  expect(first).toEqual(expect.objectContaining({
    status: "tool_calls",
    calls: [{
      callId: "call-passenger-impact",
      name: PASSENGER_TOOL.name,
      arguments: { line: "ALL" },
    }],
  }));
  return service.turn("passenger-session", {
    runId: first.runId,
    toolOutputs: [{ callId: "call-passenger-impact", output: TOOL_EVIDENCE }],
  });
}

describe("Passenger Flow server-side agent mode", () => {
  it("forces one read-only WebMCP inspection and returns the exact top three", async () => {
    const requests = [];
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: modelFetch(recommendation(), requests),
    });

    const result = await completeRun(service);

    expect(result).toEqual(expect.objectContaining({
      status: "completed",
      recommendation: expect.objectContaining({
        schemaVersion: "passenger-flow-priority-analysis.v1",
        priorities: expect.arrayContaining([
          expect.objectContaining({ rank: 1, incidentId: "INC-RERA-SIGNAL" }),
          expect.objectContaining({ rank: 2, incidentId: "INC-M14-POWER" }),
          expect.objectContaining({ rank: 3, incidentId: "INC-M13-WORKS" }),
        ]),
        advisoryOnly: true,
      }),
    }));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(expect.objectContaining({
      tool_choice: { type: "function", name: PASSENGER_TOOL.name },
      parallel_tool_calls: false,
      text: { format: expect.objectContaining({
        type: "json_schema",
        name: "passenger_flow_priority_analysis",
        strict: true,
      }) },
    }));
    expect(requests[1].tool_choice).toBe("none");
    expect(JSON.stringify(requests[1].input)).toContain("waitingQueuePassengers");
  });

  it("rejects a model response that changes the verified queue ranking", async () => {
    const requests = [];
    const swapped = recommendation([CANDIDATES[1], CANDIDATES[0], CANDIDATES[2]]);
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: modelFetch(swapped, requests),
    });

    await expect(completeRun(service)).rejects.toMatchObject({
      code: "invalid_passenger_flow_priority_response",
      status: 502,
    });
  });
});
