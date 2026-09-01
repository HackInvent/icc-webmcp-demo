export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
}

export type WebMcpTransport = "native" | "in-page";

export interface NativeWebMcpCatalog {
  definitions: AgentToolDefinition[];
  registeredByName: Map<string, WebMcpRegisteredTool>;
  inPageByName: Map<string, WebMcpToolDefinition>;
  transport: WebMcpTransport;
}

export class NativeWebMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeWebMcpError";
  }
}

function normalizeSchema(
  schema: WebMcpRegisteredTool["inputSchema"],
  toolName: string,
): Record<string, unknown> {
  if (typeof schema === "string") {
    try {
      const parsed = JSON.parse(schema) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new NativeWebMcpError(`Native WebMCP returned an invalid schema for ${toolName}.`);
    }
  }
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema;
  }
  throw new NativeWebMcpError(`Native WebMCP returned no input schema for ${toolName}.`);
}

function verifyExpectedNames(
  definitions: readonly AgentToolDefinition[],
  expectedNames: readonly string[],
): void {
  if (expectedNames.length === 0) return;
  const observed = new Set(definitions.map((tool) => tool.name));
  const missing = expectedNames.filter((name) => !observed.has(name));
  if (missing.length > 0) {
    throw new NativeWebMcpError(
      `WebMCP discovery is incomplete (${missing.length} page tools missing). Retry after the page finishes loading.`,
    );
  }
}

export function createInPageWebMcpCatalog(
  tools: readonly WebMcpToolDefinition[],
  expectedNames: readonly string[] = [],
): NativeWebMcpCatalog {
  const expected = new Set(expectedNames);
  const selected = tools.filter((tool) => expected.size === 0 || expected.has(tool.name));
  const definitions = selected.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
  verifyExpectedNames(definitions, expectedNames);
  return {
    definitions,
    registeredByName: new Map(),
    inPageByName: new Map(selected.map((tool) => [tool.name, tool])),
    transport: "in-page",
  };
}

export async function discoverNativeWebMcpTools(
  expectedNames: readonly string[],
): Promise<NativeWebMcpCatalog> {
  const context = document.modelContext;
  if (
    !context ||
    typeof context.getTools !== "function" ||
    typeof context.executeTool !== "function"
  ) {
    throw new NativeWebMcpError(
      "This browser does not expose native WebMCP tool discovery and execution.",
    );
  }
  const discovered = await context.getTools();
  const expected = new Set(expectedNames);
  const pageTools = discovered.filter((tool) => {
    if (expected.size > 0 && !expected.has(tool.name)) return false;
    return !tool.origin || tool.origin === window.location.origin;
  });
  if (pageTools.length === 0) {
    throw new NativeWebMcpError(
      "The page has not published its WebMCP tools yet. Wait a moment and retry.",
    );
  }
  const registeredByName = new Map<string, WebMcpRegisteredTool>();
  const definitions = pageTools.map((tool) => {
    registeredByName.set(tool.name, tool);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: normalizeSchema(tool.inputSchema, tool.name),
      annotations: tool.annotations,
    };
  });
  verifyExpectedNames(definitions, expectedNames);
  return {
    definitions,
    registeredByName,
    inPageByName: new Map(),
    transport: "native",
  };
}

export async function discoverPageWebMcpTools(
  expectedNames: readonly string[],
  inPageTools: readonly WebMcpToolDefinition[] = [],
): Promise<NativeWebMcpCatalog> {
  const context = document.modelContext;
  if (
    context &&
    typeof context.getTools === "function" &&
    typeof context.executeTool === "function"
  ) {
    return discoverNativeWebMcpTools(expectedNames);
  }
  if (inPageTools.length > 0) {
    return createInPageWebMcpCatalog(inPageTools, expectedNames);
  }
  throw new NativeWebMcpError(
    "The page exposes neither native WebMCP discovery nor its in-page compatibility catalog.",
  );
}

export async function executeNativeWebMcpTool(
  catalog: NativeWebMcpCatalog,
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  if (catalog.transport === "in-page") {
    const tool = catalog.inPageByName.get(name);
    if (!tool) throw new NativeWebMcpError(`WebMCP tool ${name} is no longer available.`);
    const output = await tool.execute(input, { signal });
    return typeof output === "string" ? output : JSON.stringify(output);
  }

  const context = document.modelContext;
  const tool = catalog.registeredByName.get(name);
  if (!context?.executeTool || !tool) {
    throw new NativeWebMcpError(`Native WebMCP tool ${name} is no longer available.`);
  }
  // The native WebMCP contract takes a JSON string here. Passing the parsed
  // object works with some test shims but Chromium rejects it before the
  // registered tool runs with "Failed to parse input arguments".
  const inputArguments = JSON.stringify(input);
  const output = await context.executeTool(tool, inputArguments, { signal });
  return typeof output === "string" ? output : JSON.stringify(output);
}
