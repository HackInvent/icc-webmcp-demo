import { describe, expect, it, vi } from "vitest";
import { AgentProtocolError, AgentService } from "../server/agent.mjs";
import { parsedServerConfig, TEST_WEBMCP_TOOL } from "./server-fixture.mjs";

const INCIDENT_ID = "INC-RERA-SIGNAL";
const INCIDENT_CODE = "SIG-TD-LOSS";
const INCIDENT_REVISION = 7;
const PROCEDURE_ID = "PROC-SIG-TD-LOSS";
const PROCEDURE_REVISION = "3.2";
const PROCEDURE_CONTENT_HASH = "a".repeat(64);
const PROTECT_STEP_ID = "PROC-SIG-TD-LOSS-S01";
const VERIFY_STEP_ID = "PROC-SIG-TD-LOSS-S04";
const FORBIDDEN_INCIDENT_PAYLOAD_LANGUAGE =
  /\b(?:simulation|simulated|simulator|simulating|synthetic|demo|demonstration|deterministic|scenario|exercise|sandbox|modelled|modeled)\b|local[- ]simulation|scenarioId|simulationOnly|sourceKind|safetyNotice|demo-authored/i;

const INCIDENT_INSPECT_TOOL = {
  name: "inspect_incident_decision_context",
  description: "Inspect one incident decision context without mutating the simulation.",
  inputSchema: {
    type: "object",
    properties: { incidentId: { type: "string" } },
    required: ["incidentId"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const PROCEDURE_SEARCH_TOOL = {
  name: "search_operational_procedures",
  description: "Search applicable operational procedures by incident codification.",
  inputSchema: {
    type: "object",
    properties: { incidentCode: { type: "string" } },
    required: ["incidentCode"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const PROCEDURE_GET_TOOL = {
  name: "get_operational_procedure",
  description: "Read one exact operational procedure without mutating the simulation.",
  inputSchema: {
    type: "object",
    properties: {
      procedureId: { type: "string" },
      procedureRevision: { type: "string" },
      procedureContentHash: { type: "string" },
    },
    required: ["procedureId", "procedureRevision", "procedureContentHash"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const INCIDENT_TOOLS = [
  INCIDENT_INSPECT_TOOL,
  PROCEDURE_SEARCH_TOOL,
  PROCEDURE_GET_TOOL,
];

const INCIDENT_CONTEXT = {
  status: "context_ready",
  incident: {
    id: INCIDENT_ID,
    incidentCode: INCIDENT_CODE,
    title: "Simulated loss of train detection",
    type: "infrastructure",
    effect: "closure",
    severity: "high",
    status: "active",
    occurrenceTime: "2026-08-29T08:42:00.000Z",
    lineCodes: ["RER_A"],
    target: { type: "interstation", id: "RER_A:AUBER-NATION" },
    impactedTrainIds: ["RERA-001"],
  },
  evidence: {
    decisionRevision: INCIDENT_REVISION,
    telemetryRevision: 19,
    timestamp: 1777000000000,
    scenarioId: "deterministic-demo",
  },
  impact: {
    impactedTrainCount: 1,
    passengersOnImpactedTrains: 630,
    worstDelaySeconds: 480,
    activeRestrictionCount: 1,
  },
  impactedTrains: [{ id: "RERA-001", quality: "simulated" }],
  provenance: { operations: "local deterministic simulation" },
  limitations: ["Synthetic demonstration data."],
  simulationOnly: true,
};

const PROCEDURE_SEARCH_RESULT = {
  status: "procedures_found",
  incidentCode: INCIDENT_CODE,
  matches: [{
    procedureId: PROCEDURE_ID,
    revision: PROCEDURE_REVISION,
    title: "Loss of train detection",
    contentHash: PROCEDURE_CONTENT_HASH,
    sourceKind: "demo-authored",
    official: false,
  }],
  catalogRevision: "DEMO-SCENARIO-1",
  simulationOnly: true,
};

const PROCEDURE_RESULT = {
  status: "procedure_ready",
  procedure: {
    procedureId: PROCEDURE_ID,
    revision: PROCEDURE_REVISION,
    contentHash: PROCEDURE_CONTENT_HASH,
    steps: [
      { stepId: PROTECT_STEP_ID, instruction: "Maintain route protection." },
      { stepId: VERIFY_STEP_ID, instruction: "Verify stable train detection before recovery." },
    ],
    normalStateCriteria: [
      "Train detection is stable and the incident restriction is cleared.",
    ],
  },
};

function incidentRecommendation(overrides = {}) {
  return {
    schemaVersion: "incident-decision.v2",
    incidentId: INCIDENT_ID,
    incidentCode: INCIDENT_CODE,
    decisionRevision: INCIDENT_REVISION,
    procedureId: PROCEDURE_ID,
    procedureRevision: PROCEDURE_REVISION,
    procedureContentHash: PROCEDURE_CONTENT_HASH,
    executiveSummary: "Apply the codified protection and verification sequence under operator control.",
    actions: [
      {
        stepId: PROTECT_STEP_ID,
        priority: 1,
        rationale: "The retrieved procedure requires protection before any recovery attempt.",
        operatorChecks: ["Confirm the protected segment and regulating authority."],
      },
      {
        stepId: VERIFY_STEP_ID,
        priority: 2,
        rationale: "Normal operation can resume only after the documented stability check.",
        operatorChecks: ["Confirm stable detection evidence before clearing the restriction."],
      },
    ],
    risks: ["Passenger delay can accumulate while protection remains active."],
    normalStateCriteria: ["Train detection is stable and the incident restriction is cleared."],
    advisoryOnly: true,
    humanReviewRequired: true,
    ...overrides,
  };
}

function incidentFetch(finalOutput, requests = []) {
  return vi.fn(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return jsonResponse({
        output: [{
          type: "function_call",
          call_id: "call-incident-context",
          name: INCIDENT_INSPECT_TOOL.name,
          arguments: JSON.stringify({ incidentId: INCIDENT_ID }),
        }],
      });
    }
    if (requests.length === 2) {
      return jsonResponse({
        output: [{
          type: "function_call",
          call_id: "call-procedure-search",
          name: PROCEDURE_SEARCH_TOOL.name,
          arguments: JSON.stringify({ incidentCode: INCIDENT_CODE }),
        }],
      });
    }
    if (requests.length === 3) {
      return jsonResponse({
        output: [{
          type: "function_call",
          call_id: "call-procedure-get",
          name: PROCEDURE_GET_TOOL.name,
          arguments: JSON.stringify({
            procedureId: PROCEDURE_ID,
            procedureRevision: PROCEDURE_REVISION,
            procedureContentHash: PROCEDURE_CONTENT_HASH,
          }),
        }],
      });
    }
    return jsonResponse(finalOutput);
  });
}

async function advanceIncidentRun(service) {
  const first = await service.turn("session-incident", {
    outputMode: "incident_decision",
    incidentId: INCIDENT_ID,
    tools: INCIDENT_TOOLS,
  });
  const second = await service.turn("session-incident", {
    runId: first.runId,
    toolOutputs: [{ callId: "call-incident-context", output: INCIDENT_CONTEXT }],
  });
  const third = await service.turn("session-incident", {
    runId: second.runId,
    toolOutputs: [{ callId: "call-procedure-search", output: PROCEDURE_SEARCH_RESULT }],
  });
  return service.turn("session-incident", {
    runId: third.runId,
    toolOutputs: [{ callId: "call-procedure-get", output: PROCEDURE_RESULT }],
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("server-side OpenAI agent loop", () => {
  it("round-trips a model call through a native WebMCP output before answering", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        return jsonResponse({
          output: [{
            type: "function_call",
            call_id: "call-network-1",
            name: TEST_WEBMCP_TOOL.name,
            arguments: JSON.stringify({ line: "RER_A" }),
          }],
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      }
      return jsonResponse({
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "RER A has one high-priority simulated incident at decision revision 0.",
          }],
        }],
        usage: { input_tokens: 100, output_tokens: 30 },
      });
    });
    const service = new AgentService(parsedServerConfig(), { fetchImpl });

    const first = await service.turn("session-a", {
      prompt: "Inspect RER A.",
      tools: [TEST_WEBMCP_TOOL],
    });
    expect(first).toEqual({
      status: "tool_calls",
      runId: expect.any(String),
      calls: [{
        callId: "call-network-1",
        name: TEST_WEBMCP_TOOL.name,
        arguments: { line: "RER_A" },
      }],
    });
    expect(requests[0]).toMatchObject({
      model: "gpt-5.6-terra",
      store: false,
      parallel_tool_calls: false,
      tools: [{ type: "function", name: TEST_WEBMCP_TOOL.name }],
    });
    expect(requests[0]).not.toHaveProperty("text");
    expect(requests[0].tool_choice).toBe("auto");
    expect(requests[0].instructions).toContain("native WebMCP");
    expect(requests[0].instructions).toContain("English only");

    const second = await service.turn("session-a", {
      runId: first.runId,
      toolOutputs: [{
        callId: "call-network-1",
        output: JSON.stringify({ status: "ok", decisionRevision: 0 }),
      }],
    });
    expect(second).toMatchObject({
      status: "completed",
      runId: first.runId,
      message: expect.stringContaining("decision revision 0"),
      usage: { inputTokens: 100, outputTokens: 30 },
    });
    expect(requests[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call-network-1" }),
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call-network-1",
        output: expect.stringContaining("decisionRevision"),
      }),
    ]));
  });

  it("binds outputs to the authenticated run and exact pending call IDs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      output: [{
        type: "function_call",
        call_id: "call-exact",
        name: TEST_WEBMCP_TOOL.name,
        arguments: "{}",
      }],
    }));
    const service = new AgentService(parsedServerConfig(), { fetchImpl });
    const first = await service.turn("session-a", {
      prompt: "Inspect.",
      tools: [TEST_WEBMCP_TOOL],
    });

    await expect(service.turn("session-b", {
      runId: first.runId,
      toolOutputs: [{ callId: "call-exact", output: "{}" }],
    })).rejects.toMatchObject({ code: "run_not_found", status: 404 });
    await expect(service.turn("session-a", {
      runId: first.runId,
      toolOutputs: [{ callId: "call-other", output: "{}" }],
    })).rejects.toMatchObject({ code: "invalid_tool_outputs" });
  });

  it("rejects model calls to tools the native page did not publish", async () => {
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: async () => jsonResponse({
        output: [{
          type: "function_call",
          call_id: "call-unknown",
          name: "unpublished_control",
          arguments: "{}",
        }],
      }),
    });
    await expect(service.turn("session-a", {
      prompt: "Inspect.",
      tools: [TEST_WEBMCP_TOOL],
    })).rejects.toBeInstanceOf(AgentProtocolError);
  });

  it("returns a strict procedure-grounded incident decision after three guarded WebMCP reads", async () => {
    const requests = [];
    const recommendation = incidentRecommendation();
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: incidentFetch({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(recommendation) }],
        }],
        usage: { input_tokens: 300, output_tokens: 110 },
      }, requests),
    });

    const completed = await advanceIncidentRun(service);

    expect(completed).toEqual({
      status: "completed",
      runId: expect.any(String),
      recommendation,
      usage: { inputTokens: 300, outputTokens: 110 },
    });
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toMatch(FORBIDDEN_INCIDENT_PAYLOAD_LANGUAGE);
    }
    expect(requests[0]).toMatchObject({
      tool_choice: { type: "function", name: INCIDENT_INSPECT_TOOL.name },
      parallel_tool_calls: false,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "incident_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining([
              "incidentId",
              "incidentCode",
              "procedureId",
              "procedureRevision",
              "procedureContentHash",
              "actions",
              "advisoryOnly",
              "humanReviewRequired",
            ]),
            properties: {
              advisoryOnly: { type: "boolean", const: true },
              actions: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["stepId", "priority", "rationale", "operatorChecks"],
                },
              },
            },
          },
        },
      },
    });
    expect(requests[0].input[0].content).toContain(INCIDENT_ID);
    expect(requests[0].instructions).toContain("English only");

    expect(requests[1].tool_choice).toEqual({
      type: "function",
      name: PROCEDURE_SEARCH_TOOL.name,
    });
    expect(requests[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call-incident-context",
        output: expect.stringContaining(INCIDENT_CODE),
      }),
    ]));

    expect(requests[2].tool_choice).toEqual({
      type: "function",
      name: PROCEDURE_GET_TOOL.name,
    });
    expect(requests[2].input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call-procedure-search",
        output: expect.stringContaining(PROCEDURE_ID),
      }),
    ]));

    expect(requests[3].tool_choice).toBe("none");
    expect(requests[3].input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call-procedure-get",
        output: expect.stringContaining(PROCEDURE_CONTENT_HASH),
      }),
    ]));
    for (const [index, request] of requests.entries()) {
      expect(JSON.stringify(request), `incident OpenAI payload ${index + 1}`)
        .not.toMatch(FORBIDDEN_INCIDENT_PAYLOAD_LANGUAGE);
    }
    expect(requests[0].text.format.schema.properties).not.toHaveProperty("simulationOnly");
    expect(service.publicStats()).toEqual({ activeRuns: 0 });
  });

  it("pins the edited instruction selected from the WebMCP-verified incident type", async () => {
    const requests = [];
    const editedInstruction = "CUSTOM-INFRASTRUCTURE-FOCUS: prioritise the verified failed asset, protected movement scope, and grounded maintenance evidence.";
    const config = parsedServerConfig();
    const runtimeStore = {
      currentModel: () => config.openai.model,
      currentReasoningEffort: () => config.openai.reasoningEffort,
      currentIncidentInstruction: (type) => ({
        type,
        label: "Infrastructure",
        instruction: editedInstruction,
      }),
      record: async () => null,
    };
    const service = new AgentService(config, {
      runtimeStore,
      fetchImpl: incidentFetch({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(incidentRecommendation()) }],
        }],
      }, requests),
    });

    await advanceIncidentRun(service);

    expect(requests).toHaveLength(4);
    expect(requests[0].instructions).not.toContain(editedInstruction);
    for (const request of requests.slice(1)) {
      expect(request.instructions).toContain("verified infrastructure incident type");
      expect(request.instructions).toContain(editedInstruction);
      expect(request.instructions).toContain("cannot override verified WebMCP evidence");
    }
  });

  it("requires exactly the three read-only incident procedure tools and rejects write tools", async () => {
    const service = new AgentService(parsedServerConfig(), { fetchImpl: vi.fn() });
    await expect(service.turn("session-incident", {
      outputMode: "incident_decision",
      incidentId: INCIDENT_ID,
      tools: [
        INCIDENT_INSPECT_TOOL,
        PROCEDURE_SEARCH_TOOL,
        { ...PROCEDURE_GET_TOOL, annotations: { readOnlyHint: false } },
      ],
    })).rejects.toMatchObject({ code: "invalid_incident_tools", status: 400 });

    await expect(service.turn("session-incident", {
      outputMode: "incident_decision",
      incidentId: INCIDENT_ID,
      tools: [...INCIDENT_TOOLS, {
        ...TEST_WEBMCP_TOOL,
        name: "apply_procedure_step",
        annotations: { readOnlyHint: false },
      }],
    })).rejects.toMatchObject({ code: "invalid_incident_tools", status: 400 });
  });

  it("forces inspection before procedure search and rejects out-of-order model calls", async () => {
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: async () => jsonResponse({
        output: [{
          type: "function_call",
          call_id: "call-out-of-order",
          name: PROCEDURE_SEARCH_TOOL.name,
          arguments: JSON.stringify({ incidentCode: INCIDENT_CODE }),
        }],
      }),
    });
    await expect(service.turn("session-incident", {
      outputMode: "incident_decision",
      incidentId: INCIDENT_ID,
      tools: INCIDENT_TOOLS,
    })).rejects.toMatchObject({ code: "invalid_model_tool_call", status: 502 });
  });

  it("fails cleanly when the procedure search has no verified match", async () => {
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: incidentFetch({ output: [] }),
    });
    const first = await service.turn("session-incident", {
      outputMode: "incident_decision",
      incidentId: INCIDENT_ID,
      tools: INCIDENT_TOOLS,
    });
    const second = await service.turn("session-incident", {
      runId: first.runId,
      toolOutputs: [{ callId: "call-incident-context", output: INCIDENT_CONTEXT }],
    });

    await expect(service.turn("session-incident", {
      runId: second.runId,
      toolOutputs: [{
        callId: "call-procedure-search",
        output: {
          status: "no_match",
          incidentCode: INCIDENT_CODE,
          matches: [],
        },
      }],
    })).rejects.toMatchObject({
      code: "incident_procedure_unavailable",
      status: 409,
    });
  });

  it("rejects a retrieved procedure that was not returned by the verified search", async () => {
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: incidentFetch({ output: [] }),
    });
    const first = await service.turn("session-incident", {
      outputMode: "incident_decision",
      incidentId: INCIDENT_ID,
      tools: INCIDENT_TOOLS,
    });
    const second = await service.turn("session-incident", {
      runId: first.runId,
      toolOutputs: [{ callId: "call-incident-context", output: INCIDENT_CONTEXT }],
    });
    const third = await service.turn("session-incident", {
      runId: second.runId,
      toolOutputs: [{ callId: "call-procedure-search", output: PROCEDURE_SEARCH_RESULT }],
    });

    await expect(service.turn("session-incident", {
      runId: third.runId,
      toolOutputs: [{
        callId: "call-procedure-get",
        output: {
          ...PROCEDURE_RESULT,
          procedure: {
            ...PROCEDURE_RESULT.procedure,
            procedureId: "PROC-INVENTED",
          },
        },
      }],
    })).rejects.toMatchObject({
      code: "incident_procedure_unavailable",
      status: 409,
    });
  });

  it.each([
    ["incident code", { incidentCode: "SIG-INVENTED" }],
    ["procedure ID", { procedureId: "PROC-INVENTED" }],
    ["procedure revision", { procedureRevision: "99" }],
    ["procedure hash", { procedureContentHash: "b".repeat(64) }],
    ["empty actions", { actions: [] }],
    ["non-operational narrative", {
      executiveSummary: "Current deterministic local-simulation impact.",
    }],
    ["unknown step", {
      actions: [{
        stepId: "PROC-INVENTED-S01",
        priority: 1,
        rationale: "Invented.",
        operatorChecks: ["Check."],
      }],
    }],
    ["duplicate steps", {
      actions: [
        {
          stepId: PROTECT_STEP_ID,
          priority: 1,
          rationale: "First.",
          operatorChecks: ["Check first."],
        },
        {
          stepId: PROTECT_STEP_ID,
          priority: 2,
          rationale: "Duplicate.",
          operatorChecks: ["Check duplicate."],
        },
      ],
    }],
  ])("rejects a structured recommendation with mismatched %s evidence", async (_label, overrides) => {
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: incidentFetch({
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: JSON.stringify(incidentRecommendation(overrides)),
          }],
        }],
      }),
    });
    await expect(advanceIncidentRun(service)).rejects.toMatchObject({
      code: "invalid_incident_decision_response",
      status: 502,
    });
  });

  it.each([
    ["executive summary", { executiveSummary: "Protect the simulated affected segment." }],
    ["risk", { risks: ["Synthetic passenger-delay evidence may change."] }],
    ["rationale", {
      actions: incidentRecommendation().actions.map((action, index) => index === 0
        ? { ...action, rationale: "This simulated restriction requires protection." }
        : action),
    }],
    ["operator check", {
      actions: incidentRecommendation().actions.map((action, index) => index === 0
        ? { ...action, operatorChecks: ["Confirm the deterministic scenario state."] }
        : action),
    }],
  ])("rejects simulation provenance in model-authored %s", async (_label, overrides) => {
    const service = new AgentService(parsedServerConfig(), {
      fetchImpl: incidentFetch({
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: JSON.stringify(incidentRecommendation(overrides)),
          }],
        }],
      }),
    });

    await expect(advanceIncidentRun(service)).rejects.toMatchObject({
      code: "invalid_incident_decision_response",
      status: 502,
    });
  });

  it("fails safely when structured output is malformed or refused", async () => {
    const malformed = new AgentService(parsedServerConfig(), {
      fetchImpl: incidentFetch({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "not-json" }],
        }],
      }),
    });
    await expect(advanceIncidentRun(malformed)).rejects.toMatchObject({
      code: "invalid_incident_decision_response",
      status: 502,
    });

    const refused = new AgentService(parsedServerConfig(), {
      fetchImpl: incidentFetch({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "Unable to comply." }],
        }],
      }),
    });
    await expect(advanceIncidentRun(refused)).rejects.toMatchObject({
      code: "incident_decision_refused",
      status: 502,
    });
  });

});
