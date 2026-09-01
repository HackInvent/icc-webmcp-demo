import { describe, expect, it, vi } from "vitest";
import type { RailSnapshot } from "../rail/domain";
import { createInitialSnapshot } from "../rail/scenario";
import { advanceSnapshot, setPowerStatus } from "../rail/simulation";
import { loadPassengerFeed } from "../rail/prim/feed";
import { createSampleSchedulePlan } from "../schedules/sample";
import { ScheduleWorkspaceStore } from "../schedules/store";
import {
  createIccTools,
  type CircuitClosureCommand,
  type CircuitClosureDependencyResult,
} from "./tools";

describe("ICC WebMCP tools", () => {
  function setup(snapshot: RailSnapshot = createInitialSnapshot()) {
    const schedules = new ScheduleWorkspaceStore(createSampleSchedulePlan());
    const regulate = vi.fn();
    const setCircuitClosure = vi.fn(
      (
        circuitId: string,
        action: CircuitClosureCommand,
      ): CircuitClosureDependencyResult => ({
        ok: true,
        outcome: action.kind === "close" ? "closed" : "reopened",
        circuitId,
        message: `${circuitId} ${action.kind === "close" ? "closed" : "reopened"} in simulation.`,
      }),
    );
    const tools = createIccTools(
      () => snapshot,
      { regulate, schedules, setCircuitClosure },
    );
    return { schedules, regulate, setCircuitClosure, snapshot, tools };
  }

  function namedTool(tools: WebMcpToolDefinition[], name: string): WebMcpToolDefinition {
    const tool = tools.find((candidate) => candidate.name === name);
    expect(tool, `Missing tool ${name}`).toBeDefined();
    return tool!;
  }

  it("lists an explicit occurrence time for every simulated incident", async () => {
    const { tools } = setup();
    const result = await namedTool(tools, "list_operational_incidents").execute({}) as {
      incidents: Array<Record<string, unknown>>;
    };
    expect(result.incidents.length).toBeGreaterThan(0);
    expect(result.incidents.every((incident) =>
      typeof incident.occurrenceTime === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(String(incident.occurrenceTime)),
    )).toBe(true);
  });

  it("returns aggregate driver capacity without exposing driver records", async () => {
    const { tools } = setup();
    const tool = namedTool(tools, "inspect_j1_capacity");
    const result = await tool.execute({ line: "RER_B" }) as Record<string, unknown>;
    expect(result.line).toBe("RER_B");
    expect(result).not.toHaveProperty("drivers");
    expect(String(result.privacy)).toContain("No names");
  });

  it("prepares a ranked, versioned cross-domain shift brief", async () => {
    const { tools } = setup();
    const tool = namedTool(tools, "prepare_shift_brief");
    const result = await tool.execute({}) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: "brief_ready",
      evidence: expect.objectContaining({
        source: "simulation",
        revision: 1,
        scopeLine: "ALL",
      }),
      operationalPicture: expect.objectContaining({
        trainsInScope: 12,
        delayedOverFiveMinutes: 2,
        operationalIncidents: 2,
        plannedWorksOrEvents: 1,
        passengersOnAffectedTrains: 1665,
        blockedTrackCircuits: 1,
        degradedOrIsolatedPowerSections: 1,
        driverReliefRisks: 2,
      }),
      guardrails: expect.objectContaining({
        readOnly: true,
        humanApprovalRequiredForWrites: true,
        liveSignallingAvailable: false,
      }),
    }));

    const priorities = result.priorities as Array<Record<string, unknown>>;
    expect(priorities[0]).toEqual(expect.objectContaining({
      rank: 1,
      category: "incident",
      reference: "INC-2407",
      suggestedTool: "list_operational_incidents",
    }));

    const schedule = result.schedule as Record<string, unknown>;
    expect(schedule.status).toBe("loaded");
    expect(String(schedule.planHash)).toMatch(/^schedule-[a-f0-9]{64}$/);
    expect(schedule.humanAuthorizationActive).toBe(false);

    const workflow = result.recommendedWorkflow as Array<Record<string, unknown>>;
    expect(workflow.map((step) => step.tool)).toEqual(expect.arrayContaining([
      "inspect_network_state",
      "preview_schedule_change",
      "evaluate_schedule_impact",
      "apply_reviewed_schedule_change",
    ]));
    expect(JSON.stringify(result)).not.toContain("ADC-RB-");
    expect(tool.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  });

  it("exposes bounded PRIM contract evidence without confusing it with ICC telemetry", async () => {
    const base = createInitialSnapshot();
    const passengerFeed = await loadPassengerFeed({ mode: "prim-replay", snapshot: base });
    const { tools } = setup({ ...base, passengerFeed });
    const tool = namedTool(tools, "inspect_prim_feed");
    const result = await tool.execute({ line: "RER_A" }) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: "ready",
      mode: "prim-replay",
      provenance: "synthetic_values_in_authentic_siri_lite_contract",
      provider: "Île-de-France Mobilités PRIM",
      contract: "SIRI Lite Estimated Timetable",
      scopeLine: "RER_A",
      safety: expect.stringContaining("not a train-position"),
    }));
    expect(result.coverage).toEqual([
      expect.objectContaining({ lineId: "RER_A", lineRef: "STIF:Line::C01742:" }),
    ]);
    expect(tool.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  });

  it("accepts RER A and rejects the retired RER D identifier", async () => {
    const { tools } = setup();
    const inspect = namedTool(tools, "inspect_network_state");
    const result = await inspect.execute({ line: "RER_A" }) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: "ok",
      line: "RER_A",
      trains: 3,
      powerSections: 2,
      degradedPowerSections: 0,
      isolatedPowerSections: 0,
    }));
    expect(() => inspect.execute({ line: "RER_D" })).toThrow(
      "line must be one of RER_A, RER_B, M13, M14",
    );

    const schema = inspect.inputSchema as {
      properties: { line: { enum: string[] } };
    };
    expect(schema.properties.line.enum).toEqual(["RER_A", "RER_B", "M13", "M14"]);
    expect(schema.properties.line.enum).not.toContain("RER_D");
  });

  it("blocks a regulation action against a stale snapshot", async () => {
    const { regulate, tools } = setup();
    const tool = namedTool(tools, "simulate_regulation_action");
    const result = await tool.execute({
      trainId: "MI79-205",
      action: "priority",
      expectedRevision: 99,
      confirmSimulation: true,
    }) as Record<string, unknown>;
    expect(result.reason).toBe("stale_snapshot");
    expect(regulate).not.toHaveBeenCalled();
  });

  it("keeps both write guards valid across telemetry ticks and stale after a decision", async () => {
    let snapshot = createInitialSnapshot();
    const schedules = new ScheduleWorkspaceStore(createSampleSchedulePlan());
    const regulate = vi.fn();
    const setCircuitClosure = vi.fn((circuitId: string) => ({
      ok: true as const,
      outcome: "closed" as const,
      circuitId,
      message: `${circuitId} closed in simulation.`,
    }));
    const tools = createIccTools(
      () => snapshot,
      { regulate, schedules, setCircuitClosure },
    );
    const context = await namedTool(tools, "inspect_network_state").execute({}) as {
      revision: number;
      decisionRevision: number;
      writeGuard: {
        expectedRevision: number;
        basis: string;
        stableAcrossTelemetryTicks: boolean;
      };
    };
    expect(context.writeGuard).toEqual({
      expectedRevision: context.decisionRevision,
      basis: "decision_revision",
      stableAcrossTelemetryTicks: true,
    });

    snapshot = advanceSnapshot(snapshot);
    expect(snapshot.revision).toBe(context.revision + 1);
    expect(snapshot.decisionRevision).toBe(context.decisionRevision);

    const regulation = await namedTool(tools, "simulate_regulation_action").execute({
      trainId: "MI79-205",
      action: "priority",
      expectedRevision: context.decisionRevision,
      confirmSimulation: true,
    });
    const closure = await namedTool(tools, "simulate_track_circuit_closure").execute({
      circuitId: "RB-02-A",
      action: "close",
      reason: "works",
      expectedRevision: context.decisionRevision,
      confirmSimulation: true,
    });
    expect(regulation).toEqual(expect.objectContaining({
      status: "applied_to_simulation",
      basedOnDecisionRevision: context.decisionRevision,
      telemetryRevision: snapshot.revision,
    }));
    expect(closure).toEqual(expect.objectContaining({
      status: "applied_to_simulation",
      basedOnDecisionRevision: context.decisionRevision,
      telemetryRevision: snapshot.revision,
    }));
    expect(regulate).toHaveBeenCalledOnce();
    expect(setCircuitClosure).toHaveBeenCalledOnce();

    snapshot = setPowerStatus(
      { snapshot, speed: 1 },
      "PWR-M14-NORD",
      "isolated",
    ).snapshot;
    expect(snapshot.decisionRevision).toBe(context.decisionRevision + 1);

    const staleRegulation = await namedTool(tools, "simulate_regulation_action").execute({
      trainId: "MI79-205",
      action: "priority",
      expectedRevision: context.decisionRevision,
      confirmSimulation: true,
    });
    const staleClosure = await namedTool(tools, "simulate_track_circuit_closure").execute({
      circuitId: "RB-02-A",
      action: "close",
      reason: "works",
      expectedRevision: context.decisionRevision,
      confirmSimulation: true,
    });
    for (const result of [staleRegulation, staleClosure]) {
      expect(result).toEqual(expect.objectContaining({
        status: "blocked",
        reason: "stale_snapshot",
        expectedRevision: context.decisionRevision,
        currentDecisionRevision: snapshot.decisionRevision,
        telemetryRevision: snapshot.revision,
      }));
    }
    expect(regulate).toHaveBeenCalledOnce();
    expect(setCircuitClosure).toHaveBeenCalledOnce();
  });

  it("does not mutate an already-aborted regulation request", async () => {
    const { regulate, snapshot, tools } = setup();
    const tool = namedTool(tools, "simulate_regulation_action");
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute({
      trainId: "MI79-205",
      action: "priority",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    }, { signal: controller.signal });
    expect(result).toEqual(expect.objectContaining({ status: "blocked", reason: "request_aborted" }));
    expect(regulate).not.toHaveBeenCalled();
  });

  it("surfaces a regulation rejection returned by the simulation", async () => {
    const { regulate, snapshot, tools } = setup();
    regulate.mockReturnValue({ ok: false, message: "No modelled delay remains." });
    const tool = namedTool(tools, "simulate_regulation_action");
    const result = await tool.execute({
      trainId: "MI79-205",
      action: "priority",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    }) as Record<string, unknown>;
    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "action_rejected",
      message: "No modelled delay remains.",
    }));
    expect(regulate).toHaveBeenCalledWith("MI79-205", "priority");
  });

  it("blocks a turnback away from a modelled corridor turnback point", async () => {
    const { regulate, snapshot, tools } = setup();
    const tool = namedTool(tools, "simulate_regulation_action");
    const result = await tool.execute({
      trainId: "MI79-101",
      action: "turnback",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    }) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "not_at_turnback_point",
      simulationOnly: true,
    }));
    expect(regulate).not.toHaveBeenCalled();
  });

  it("closes then reopens a free circuit in the local simulation only", async () => {
    let snapshot = createInitialSnapshot();
    const schedules = new ScheduleWorkspaceStore(createSampleSchedulePlan());
    const circuitId = snapshot.circuits.find((circuit) => circuit.state === "free")!.id;
    const setCircuitClosure = vi.fn(
      (
        requestedCircuitId: string,
        command: CircuitClosureCommand,
      ): CircuitClosureDependencyResult => {
        snapshot = {
          ...snapshot,
          decisionRevision: snapshot.decisionRevision + 1,
          revision: snapshot.revision + 1,
          circuits: snapshot.circuits.map((circuit) =>
            circuit.id === requestedCircuitId
              ? {
                  ...circuit,
                  state: command.kind === "close" ? "blocked" as const : "free" as const,
                }
              : circuit,
          ),
        };
        return {
          ok: true,
          outcome: command.kind === "close" ? "closed" : "reopened",
          circuitId: requestedCircuitId,
          message: `${requestedCircuitId} updated in the local simulation.`,
        };
      },
    );
    const tools = createIccTools(
      () => snapshot,
      { regulate: vi.fn(), schedules, setCircuitClosure },
    );
    const closure = namedTool(tools, "simulate_track_circuit_closure");
    const note = "Overnight renewal window";
    const closed = await closure.execute({
      circuitId,
      action: "close",
      reason: "works",
      note,
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    });

    expect(closed).toEqual(expect.objectContaining({
      status: "applied_to_simulation",
      circuitId,
      action: "close",
      outcome: "closed",
      basedOnRevision: 1,
      closureReason: "works",
      noteAccepted: true,
      simulationOnly: true,
    }));
    expect(JSON.stringify(closed)).not.toContain(note);
    expect(setCircuitClosure).toHaveBeenLastCalledWith(circuitId, {
      kind: "close",
      reason: "works",
      note,
    });
    expect(snapshot.circuits.find((circuit) => circuit.id === circuitId)?.state).toBe("blocked");

    const reopened = await closure.execute({
      circuitId,
      action: "reopen",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    });
    expect(reopened).toEqual(expect.objectContaining({
      status: "applied_to_simulation",
      circuitId,
      action: "reopen",
      outcome: "reopened",
      basedOnRevision: 2,
      simulationOnly: true,
    }));
    expect(setCircuitClosure).toHaveBeenLastCalledWith(circuitId, { kind: "reopen" });
    expect(snapshot.circuits.find((circuit) => circuit.id === circuitId)?.state).toBe("free");
  });

  it("blocks closure of an occupied circuit before invoking the simulation callback", async () => {
    const { setCircuitClosure, snapshot, tools } = setup();
    const occupied = snapshot.circuits.find((circuit) => circuit.state === "occupied")!;
    const result = await namedTool(tools, "simulate_track_circuit_closure").execute({
      circuitId: occupied.id,
      action: "close",
      reason: "incident",
      note: "Inspection requested",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    });

    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "occupied",
      circuitId: occupied.id,
      currentState: "occupied",
      simulationOnly: true,
    }));
    expect(setCircuitClosure).not.toHaveBeenCalled();
  });

  it("blocks stale and live circuit commands before invoking the simulation callback", async () => {
    const staleSetup = setup();
    const freeCircuit = staleSetup.snapshot.circuits.find((circuit) => circuit.state === "free")!;
    const stale = await namedTool(
      staleSetup.tools,
      "simulate_track_circuit_closure",
    ).execute({
      circuitId: freeCircuit.id,
      action: "close",
      reason: "works",
      expectedRevision: staleSetup.snapshot.decisionRevision + 1,
      confirmSimulation: true,
    });
    expect(stale).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "stale_snapshot",
      expectedRevision: staleSetup.snapshot.decisionRevision + 1,
      currentRevision: staleSetup.snapshot.decisionRevision,
    }));
    expect(staleSetup.setCircuitClosure).not.toHaveBeenCalled();

    const liveSetup = setup({ ...createInitialSnapshot(), source: "live" });
    const liveCircuit = liveSetup.snapshot.circuits.find((circuit) => circuit.state === "free")!;
    const live = await namedTool(
      liveSetup.tools,
      "simulate_track_circuit_closure",
    ).execute({
      circuitId: liveCircuit.id,
      action: "close",
      reason: "incident",
      expectedRevision: liveSetup.snapshot.decisionRevision,
      confirmSimulation: true,
    });
    expect(live).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "live_forbidden",
      simulationOnly: true,
    }));
    expect(liveSetup.setCircuitClosure).not.toHaveBeenCalled();
  });

  it("rejects redundant actions and incompatible closure inputs", async () => {
    const { setCircuitClosure, snapshot, tools } = setup();
    const closure = namedTool(tools, "simulate_track_circuit_closure");
    const freeCircuit = snapshot.circuits.find((circuit) => circuit.state === "free")!;
    const reopen = await closure.execute({
      circuitId: freeCircuit.id,
      action: "reopen",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    });
    expect(reopen).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "already_open",
    }));
    expect(setCircuitClosure).not.toHaveBeenCalled();

    const blockedCircuit = snapshot.circuits.find((circuit) => circuit.state === "blocked")!;
    setCircuitClosure.mockReturnValueOnce({
      ok: false,
      reason: "already_closed",
      circuitId: blockedCircuit.id,
      message: "m".repeat(400),
    });
    const close = await closure.execute({
      circuitId: blockedCircuit.id,
      action: "close",
      reason: "incident",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    });
    expect(close).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "already_closed",
    }));
    expect((close as { message: string }).message).toHaveLength(240);

    expect(() => closure.execute({
      circuitId: freeCircuit.id,
      action: "close",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    })).toThrow("reason must be");
    expect(() => closure.execute({
      circuitId: freeCircuit.id,
      action: "reopen",
      reason: "works",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    })).toThrow("Unexpected input property");
    expect(() => closure.execute({
      circuitId: freeCircuit.id,
      action: "close",
      reason: "works",
      note: "x".repeat(181),
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    })).toThrow("note must be");
  });

  it("normalizes a whitespace-only circuit note without claiming it was accepted", async () => {
    const { setCircuitClosure, snapshot, tools } = setup();
    const closure = namedTool(tools, "simulate_track_circuit_closure");
    const freeCircuit = snapshot.circuits.find((circuit) => circuit.state === "free")!;
    const result = await closure.execute({
      circuitId: freeCircuit.id,
      action: "close",
      reason: "works",
      note: "   ",
      expectedRevision: snapshot.decisionRevision,
      confirmSimulation: true,
    }) as { noteAccepted: boolean };

    expect(result.noteAccepted).toBe(false);
    expect(setCircuitClosure).toHaveBeenCalledWith(freeCircuit.id, {
      kind: "close",
      reason: "works",
      note: "",
    });
  });

  it("exposes schedule and circuit write tools with explicit schemas and annotations", () => {
    const { tools } = setup();
    expect(tools).toHaveLength(12);
    expect(namedTool(tools, "inspect_schedule_plan").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(namedTool(tools, "preview_schedule_change").annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    expect(namedTool(tools, "evaluate_schedule_impact").annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    expect(namedTool(tools, "apply_reviewed_schedule_change").annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });

    for (const readToolName of [
      "inspect_prim_feed",
      "prepare_shift_brief",
      "inspect_network_state",
      "list_operational_incidents",
    ]) {
      expect(namedTool(tools, readToolName).annotations).toEqual({
        readOnlyHint: true,
        untrustedContentHint: true,
      });
    }
    expect(namedTool(tools, "simulate_regulation_action").annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    });

    const previewSchema = namedTool(tools, "preview_schedule_change").inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(previewSchema.properties.track).toEqual({
      type: "string", maxLength: 20, pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$",
    });

    const applySchema = namedTool(tools, "apply_reviewed_schedule_change").inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(applySchema.properties)).toEqual(["expectedHash", "previewId", "impactId"]);
    expect(applySchema.required).toEqual(["expectedHash", "previewId", "impactId"]);
    expect(applySchema.additionalProperties).toBe(false);

    const closure = namedTool(tools, "simulate_track_circuit_closure");
    expect(closure.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    });
    const closureSchema = closure.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
      oneOf: unknown[];
    };
    expect(Object.keys(closureSchema.properties)).toEqual([
      "circuitId",
      "action",
      "reason",
      "note",
      "expectedRevision",
      "confirmSimulation",
    ]);
    expect(closureSchema.required).toEqual([
      "circuitId",
      "action",
      "expectedRevision",
      "confirmSimulation",
    ]);
    expect(closureSchema.additionalProperties).toBe(false);
    expect(closureSchema.oneOf).toHaveLength(2);
    expect(closureSchema.properties.action).toEqual({
      type: "string",
      enum: ["close", "reopen"],
    });
    expect(closureSchema.properties.reason).toEqual({
      type: "string",
      enum: ["works", "incident"],
    });
    expect(closureSchema.properties.note).toEqual({
      type: "string",
      maxLength: 180,
    });
    expect(closureSchema.properties.expectedRevision).toEqual({
      type: "integer",
      minimum: 1,
      description: "Exact decisionRevision returned by the current read context.",
    });
    expect(closureSchema.properties.confirmSimulation).toEqual({
      type: "boolean",
      const: true,
    });
  });

  it("inspects a bounded plan page without returning driver, train or route values", async () => {
    const { schedules, tools } = setup();
    const inspect = namedTool(tools, "inspect_schedule_plan");
    const result = await inspect.execute({ limit: 4 }) as {
      planHash: string;
      returned: number;
      nextOffset: number | null;
      resourceTokensRedacted: boolean;
      services: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(result);

    expect(result.planHash).toBe(schedules.currentHash());
    expect(result.returned).toBe(4);
    expect(result.nextOffset).toBe(4);
    expect(result.resourceTokensRedacted).toBe(true);
    expect(result.services[0]).toEqual(expect.objectContaining({
      serviceId: "SVC-RB-101",
      departureMinutes: 330,
      driverAssigned: true,
    }));
    expect(serialized).not.toContain("ADC-RB-041");
    expect(serialized).not.toContain("MI79-101");
    expect(serialized).not.toContain("Denfert");
    expect(serialized).not.toContain("Aulnay");
    expect(() => inspect.execute({ limit: 13 })).toThrow("limit must be an integer");
  });

  it("redacts even a one-character driver resource token", async () => {
    const { schedules, tools } = setup();
    const result = await namedTool(tools, "preview_schedule_change").execute({
      expectedHash: schedules.currentHash(),
      kind: "reassign_driver",
      serviceId: "SVC-RB-101",
      driverToken: "X",
    }) as { summary: string };

    expect(result.summary).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("driver token X");
  });

  it("enforces inspect, preview, impact, one-use human authorization, then exact commit", async () => {
    const { schedules, snapshot, tools } = setup();
    const inspect = namedTool(tools, "inspect_schedule_plan");
    const previewTool = namedTool(tools, "preview_schedule_change");
    const impactTool = namedTool(tools, "evaluate_schedule_impact");
    const applyTool = namedTool(tools, "apply_reviewed_schedule_change");
    const inspected = await inspect.execute({ line: "RER_B", limit: 1 }) as {
      planHash: string;
      services: Array<{ serviceId: string }>;
    };
    const expectedHash = inspected.planHash;
    const serviceId = inspected.services[0].serviceId;
    const preview = await previewTool.execute({
      expectedHash,
      kind: "shift_service",
      serviceId,
      deltaMinutes: 5,
    }) as {
      status: string;
      previewId: string;
      valuesRedacted: boolean;
      sampleChangeLocations: Array<Record<string, unknown>>;
    };

    expect(preview.status).toBe("preview_ready");
    expect(preview.previewId).toMatch(/^preview-/);
    expect(preview.valuesRedacted).toBe(true);
    expect(preview.sampleChangeLocations).toHaveLength(2);
    expect(preview.sampleChangeLocations[0]).not.toHaveProperty("before");
    expect(preview.sampleChangeLocations[0]).not.toHaveProperty("after");
    expect(schedules.currentHash()).toBe(expectedHash);

    const impact = await impactTool.execute({
      expectedHash,
      previewId: preview.previewId,
    }) as {
      status: string;
      impactId: string;
      hardBlockCount: number;
      humanApprovalRequired: boolean;
    };
    expect(impact).toEqual(expect.objectContaining({
      status: "impact_evaluated",
      hardBlockCount: 0,
      humanApprovalRequired: true,
    }));
    expect(impact.impactId).toMatch(/^impact-[a-f0-9]{64}$/);

    const beforeApproval = await applyTool.execute({
      expectedHash,
      previewId: preview.previewId,
      impactId: impact.impactId,
    });
    expect(beforeApproval).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "human_approval_required",
    }));
    expect(schedules.currentHash()).toBe(expectedHash);

    schedules.authorizePreview(preview.previewId, impact.impactId, snapshot);
    const committed = await applyTool.execute({
      expectedHash,
      previewId: preview.previewId,
      impactId: impact.impactId,
    }) as { status: string; planHash: string; authorizationConsumed: boolean };
    expect(committed).toEqual(expect.objectContaining({
      status: "committed_to_simulation",
      authorizationConsumed: true,
    }));
    expect(committed.planHash).not.toBe(expectedHash);
    expect(schedules.currentPlan().services[0].departureMinutes).toBe(335);
    expect(schedules.getSnapshot()).toEqual(expect.objectContaining({
      pendingPreview: null,
      pendingImpact: null,
      authorizedPreviewId: null,
      authorizedImpactId: null,
    }));

    const replay = await applyTool.execute({
      expectedHash,
      previewId: preview.previewId,
      impactId: impact.impactId,
    });
    expect(replay).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "stale_schedule",
    }));
  });

  it("rejects stale schedule hashes and never stages their operation", async () => {
    const { schedules, tools } = setup();
    const preview = namedTool(tools, "preview_schedule_change");
    const staleHash = "schedule-" + "0".repeat(64);
    const result = await preview.execute({
      expectedHash: staleHash,
      kind: "shift_service",
      serviceId: "SVC-RB-101",
      deltaMinutes: 5,
    });

    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "stale_schedule",
      expectedHash: staleHash,
      currentHash: schedules.currentHash(),
    }));
    expect(schedules.getSnapshot().pendingPreview).toBeNull();

    const apply = namedTool(tools, "apply_reviewed_schedule_change");
    expect(() => apply.execute({
      expectedHash: schedules.currentHash(),
      previewId: "preview-a-1",
      impactId: "impact-" + "0".repeat(64),
      kind: "cancel_service",
      serviceId: "SVC-RB-101",
    })).toThrow("Unexpected input property");
  });

  it("reports and enforces a new hard impact block without leaking resource tokens", async () => {
    const { schedules, snapshot, tools } = setup();
    const expectedHash = schedules.currentHash();
    const preview = await namedTool(tools, "preview_schedule_change").execute({
      expectedHash,
      kind: "reassign_driver",
      serviceId: "SVC-RB-101",
      driverToken: null,
    }) as { previewId: string };
    const impact = await namedTool(tools, "evaluate_schedule_impact").execute({
      expectedHash,
      previewId: preview.previewId,
    }) as { impactId: string; assessment: string; hardBlockCount: number };

    expect(impact.assessment).toBe("blocked");
    expect(impact.hardBlockCount).toBeGreaterThan(0);
    expect(() => schedules.authorizePreview(preview.previewId, impact.impactId, snapshot)).toThrow(
      "hard blocks",
    );

    const blockedApply = await namedTool(tools, "apply_reviewed_schedule_change").execute({
      expectedHash,
      previewId: preview.previewId,
      impactId: impact.impactId,
    });
    expect(blockedApply).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "impact_hard_block",
    }));
    expect(JSON.stringify(blockedApply)).not.toContain("ADC-RB-041");
    expect(schedules.currentHash()).toBe(expectedHash);
  });

  it("forbids an agent commit when the data source switches to live", async () => {
    let snapshot: RailSnapshot = createInitialSnapshot();
    const schedules = new ScheduleWorkspaceStore(createSampleSchedulePlan());
    const tools = createIccTools(() => snapshot, {
      regulate: vi.fn(),
      schedules,
      setCircuitClosure: vi.fn(),
    });
    const expectedHash = schedules.currentHash();
    const preview = await namedTool(tools, "preview_schedule_change").execute({
      expectedHash,
      kind: "shift_service",
      serviceId: "SVC-RB-101",
      deltaMinutes: 5,
    }) as { previewId: string };
    const impact = await namedTool(tools, "evaluate_schedule_impact").execute({
      expectedHash,
      previewId: preview.previewId,
    }) as { impactId: string };
    schedules.authorizePreview(preview.previewId, impact.impactId, snapshot);
    snapshot = { ...snapshot, source: "live" };

    const result = await namedTool(tools, "apply_reviewed_schedule_change").execute({
      expectedHash,
      previewId: preview.previewId,
      impactId: impact.impactId,
    });
    expect(result).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "live_forbidden",
    }));
    expect(schedules.currentHash()).toBe(expectedHash);
  });
});
