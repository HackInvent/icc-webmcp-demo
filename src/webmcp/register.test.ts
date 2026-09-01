import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeNetworkController } from "../rail/nativeSimulation";
import { createInitialSnapshot } from "../rail/scenario";
import { scheduleWorkspace } from "../schedules/workspace";
import type { IccToolDependencies } from "./tools";
import {
  createIccToolCatalog,
  MUTATING_WEBMCP_TOOL_NAMES,
  registerIccTools,
  webMcpActivityKind,
  type WebMcpActivity,
  type WebMcpApprovalHandler,
} from "./register";

function setup() {
  const snapshot = createInitialSnapshot();
  const nativeNetwork = createNativeNetworkController({ speed: 0 });
  const regulate = vi.fn((
    trainId: string,
    action: "priority" | "hold" | "turnback",
  ) => ({
    ok: true,
    message: `${trainId} ${action}`,
  }));
  const dependencies: IccToolDependencies = {
    regulate,
    schedules: scheduleWorkspace,
    setCircuitClosure: (circuitId, command) => ({
      ok: true,
      outcome: command.kind === "close" ? "closed" : "reopened",
      circuitId,
      message: "Simulation updated.",
    }),
    nativeNetwork,
  };
  return {
    snapshot,
    nativeNetwork,
    regulate,
    dependencies,
  };
}

function namedTool(
  tools: readonly WebMcpToolDefinition[],
  name: string,
): WebMcpToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing test tool ${name}.`);
  return tool;
}

function regulationInput(snapshot: ReturnType<typeof createInitialSnapshot>) {
  return {
    trainId: snapshot.trains[0].id,
    action: "priority",
    expectedRevision: snapshot.decisionRevision,
    confirmSimulation: true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registered WebMCP execution policy", () => {
  it("marks exactly the six simulation mutations as writes", () => {
    expect([...MUTATING_WEBMCP_TOOL_NAMES].sort()).toEqual([
      "apply_reviewed_procedure_step",
      "apply_reviewed_schedule_change",
      "control_network_simulation",
      "create_simulated_network_incident",
      "simulate_regulation_action",
      "simulate_track_circuit_closure",
    ]);
    expect(webMcpActivityKind("search_operational_procedures")).toBe("read");
    expect(webMcpActivityKind("get_operational_procedure")).toBe("read");
    expect(webMcpActivityKind("preview_schedule_change")).toBe("analysis");
    expect(webMcpActivityKind("simulate_regulation_action")).toBe("write");
    expect(webMcpActivityKind("inspect_network_digital_twin")).toBe("read");
  });

  it("allows read tools without requesting operator approval", async () => {
    const { snapshot, dependencies } = setup();
    const approval = vi.fn<WebMcpApprovalHandler>();
    const activity: WebMcpActivity[] = [];
    const tools = createIccToolCatalog(
      () => snapshot,
      dependencies,
      (event) => activity.push(event),
      approval,
    );

    const result = await namedTool(tools, "inspect_network_state").execute({});

    expect(result).toMatchObject({ status: "ok", revision: snapshot.revision });
    expect(approval).not.toHaveBeenCalled();
    expect(activity.map((event) => event.status)).toEqual(["running", "completed"]);
  });

  it("fails closed when no trusted approval coordinator is installed", async () => {
    const { snapshot, dependencies, regulate } = setup();
    const activity: WebMcpActivity[] = [];
    const tools = createIccToolCatalog(
      () => snapshot,
      dependencies,
      (event) => activity.push(event),
    );

    const result = await namedTool(tools, "simulate_regulation_action")
      .execute(regulationInput(snapshot));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "human_approval_unavailable",
    });
    expect(regulate).not.toHaveBeenCalled();
    expect(activity.map((event) => event.status)).toEqual([
      "awaiting_approval",
      "blocked",
    ]);
  });

  it("does not execute a mutation rejected by the operator", async () => {
    const { snapshot, nativeNetwork, dependencies, regulate } = setup();
    const approval = vi.fn<WebMcpApprovalHandler>((request) => {
      expect(request.toolName).toBe("simulate_regulation_action");
      expect(request.railRevision).toBe(snapshot.revision);
      expect(request.nativeDecisionRevision).toBe(
        nativeNetwork.getSnapshot().decisionRevision,
      );
      expect(request.inputJson).toBe(JSON.stringify(regulationInput(snapshot)));
      expect(Object.isFrozen(request.input)).toBe(true);
      return { approved: false, reason: "Keep the current regulation plan." };
    });
    const tools = createIccToolCatalog(
      () => snapshot,
      dependencies,
      undefined,
      approval,
    );

    const result = await namedTool(tools, "simulate_regulation_action")
      .execute(regulationInput(snapshot));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "human_approval_rejected",
      message: "Keep the current regulation plan.",
    });
    expect(regulate).not.toHaveBeenCalled();
  });

  it("executes exactly the arguments that were presented for approval", async () => {
    const { snapshot, dependencies, regulate } = setup();
    let decide: ((decision: boolean) => void) | undefined;
    const approval = vi.fn<WebMcpApprovalHandler>(() =>
      new Promise<boolean>((resolve) => {
        decide = resolve;
      })
    );
    const tools = createIccToolCatalog(
      () => snapshot,
      dependencies,
      undefined,
      approval,
    );
    const input = regulationInput(snapshot);
    const pending = namedTool(tools, "simulate_regulation_action").execute(input);

    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    input.action = "hold";
    decide?.(true);
    const result = await pending;

    expect(result).toMatchObject({
      status: "applied_to_simulation",
      action: "priority",
    });
    expect(regulate).toHaveBeenCalledWith(snapshot.trains[0].id, "priority");
  });

  it("registers all wrapped tools natively and disposes them", async () => {
    const { snapshot, dependencies } = setup();
    const registered: WebMcpToolDefinition[] = [];
    const registerTool = vi.fn(async (tool: WebMcpToolDefinition) => {
      registered.push(tool);
    });
    vi.stubGlobal("document", {
      modelContext: {
        registerTool,
      },
    });

    const registration = await registerIccTools(
      () => snapshot,
      dependencies,
      undefined,
      () => true,
    );

    expect(registration.supported).toBe(true);
    expect(registration.count).toBe(19);
    expect(registration.names).toHaveLength(19);
    expect(registered).toHaveLength(19);
    expect(registration.names).toEqual(registered.map((tool) => tool.name));
    await registration.dispose();
  });
});
