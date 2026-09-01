import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPageWebMcpTools,
  executeNativeWebMcpTool,
  type NativeWebMcpCatalog,
} from "./nativeWebMcp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native WebMCP execution", () => {
  it.each([
    ["arguments", { incidentStatus: "active", limit: 12 }],
    ["empty arguments", {}],
  ])("serializes %s as JSON for Chromium", async (_label, input) => {
    const tool: WebMcpRegisteredTool = {
      name: "inspect_network_digital_twin",
      description: "Inspect the network.",
      inputSchema: { type: "object" },
    };
    const executeTool = vi.fn(async () => '{"status":"ok"}');
    vi.stubGlobal("document", { modelContext: { executeTool } });
    const catalog: NativeWebMcpCatalog = {
      definitions: [],
      registeredByName: new Map([[tool.name, tool]]),
      inPageByName: new Map(),
      transport: "native",
    };
    const controller = new AbortController();

    const output = await executeNativeWebMcpTool(
      catalog,
      tool.name,
      input,
      controller.signal,
    );

    expect(output).toBe('{"status":"ok"}');
    expect(executeTool).toHaveBeenCalledWith(
      tool,
      JSON.stringify(input),
      { signal: controller.signal },
    );
  });

  it("uses the in-page WebMCP catalog when native browser discovery is unavailable", async () => {
    vi.stubGlobal("document", {});
    const execute = vi.fn(async (
      input: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => ({
      status: "context_ready",
      input,
      aborted: options?.signal?.aborted ?? false,
    }));
    const tool: WebMcpToolDefinition = {
      name: "inspect_incident_decision_context",
      description: "Inspect one incident.",
      inputSchema: {
        type: "object",
        properties: { incidentId: { type: "string" } },
        required: ["incidentId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute,
    };
    const controller = new AbortController();

    const catalog = await discoverPageWebMcpTools([tool.name], [tool]);
    const output = await executeNativeWebMcpTool(
      catalog,
      tool.name,
      { incidentId: "INC-RER-A-01" },
      controller.signal,
    );

    expect(catalog.transport).toBe("in-page");
    expect(catalog.definitions.map((definition) => definition.name)).toEqual([tool.name]);
    expect(output).toBe(JSON.stringify({
      status: "context_ready",
      input: { incidentId: "INC-RER-A-01" },
      aborted: false,
    }));
    expect(execute).toHaveBeenCalledWith(
      { incidentId: "INC-RER-A-01" },
      { signal: controller.signal },
    );
  });
});
