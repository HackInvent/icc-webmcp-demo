interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

interface WebMcpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown> | unknown;
}

interface WebMcpRegisteredTool {
  name: string;
  title?: string;
  description: string;
  /**
   * Chromium prototypes have exposed this as both a parsed object and a
   * serialized JSON schema. Consumers normalize both representations.
   */
  inputSchema?: Record<string, unknown> | string;
  annotations?: WebMcpToolAnnotations;
  origin?: string;
  window?: Window;
}

interface WebMcpGetToolsOptions {
  fromOrigins?: string[];
}

interface WebMcpExecuteToolOptions {
  signal?: AbortSignal;
}

interface WebMcpModelContext extends EventTarget {
  registerTool(
    tool: WebMcpToolDefinition,
    options?: { signal?: AbortSignal; exposedTo?: string[] },
  ): Promise<void>;
  getTools?(options?: WebMcpGetToolsOptions): Promise<WebMcpRegisteredTool[]>;
  executeTool?(
    tool: WebMcpRegisteredTool,
    /** Chromium's native WebMCP API accepts serialized JSON arguments. */
    inputArguments?: string,
    options?: WebMcpExecuteToolOptions,
  ): Promise<string>;
  ontoolchange?: ((this: WebMcpModelContext, event: Event) => unknown) | null;
}

interface Document {
  modelContext?: WebMcpModelContext;
}
