import { parseServerConfig } from "../server/config.mjs";
import { hashAccessCode } from "../server/security.mjs";

export const TEST_ACCESS_CODE = "jury-code-123";
export const TEST_ACCESS_HASH = hashAccessCode(TEST_ACCESS_CODE, {
  N: 1_024,
  salt: Buffer.from("0123456789abcdef"),
});

export const TEST_INCIDENT_INSTRUCTIONS = [
  ["infrastructure", "Infrastructure"],
  ["passenger", "Passenger event"],
  ["rolling-stock", "Rolling stock"],
  ["staff", "Staff and crew"],
  ["power", "Traction power"],
  ["works", "Engineering works"],
  ["external", "External event"],
  ["communications", "Supervision communications"],
  ["security", "Security"],
].map(([type, label]) => ({
  type,
  label,
  instruction: `Apply the configured ${label.toLowerCase()} focus after verified WebMCP classification and remain bound to the retrieved procedure.`,
}));

export function rawServerConfig(overrides = {}) {
  return {
    application: {
      name: "Paris ICC test",
      environment: "test",
      publicOrigin: "http://localhost:8787",
      dataMode: "local-simulation",
      ...overrides.application,
    },
    server: {
      host: "127.0.0.1",
      port: 8787,
      trustProxy: false,
      distDirectory: "../dist",
      maxRequestBodyBytes: 262_144,
      ...overrides.server,
    },
    auth: {
      accessCodeHash: TEST_ACCESS_HASH,
      sessionSecret: "test-session-secret-with-more-than-thirty-two-characters",
      cookieName: "paris_icc_test",
      sessionTtlMinutes: 60,
      secureCookies: false,
      maxFailedAttempts: 3,
      failureWindowSeconds: 60,
      ...overrides.auth,
    },
    openai: {
      enabled: true,
      apiKey: "sk-test-not-a-real-key-1234567890",
      model: "gpt-5.6-terra",
      allowedModels: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
      reasoningEffort: "low",
      maxOutputTokens: 1_000,
      timeoutMs: 10_000,
      baseUrl: "https://api.openai.test/v1",
      ...overrides.openai,
    },
    agent: {
      instructions: "Use only native WebMCP evidence from the Paris ICC page. Inspect before conclusions, distinguish simulation from live evidence, and never write unless explicitly requested and visibly approved by the operator.",
      maxPromptCharacters: 3_000,
      maxToolOutputCharacters: 60_000,
      maxToolRounds: 6,
      runTtlMinutes: 30,
      maxRunsPerSession: 4,
      requestsPerMinute: 20,
      logMaxEntries: 1_000,
      presets: [{
        id: "brief",
        label: "Prepare brief",
        prompt: "Inspect the current network and prepare a brief.",
      }],
      incidentInstructions: TEST_INCIDENT_INSTRUCTIONS.map((entry) => ({ ...entry })),
      ...overrides.agent,
    },
    storage: {
      databasePath: "../state/paris-icc.sqlite",
      agentRuntimePath: "../state/agent-runtime.json",
      tickIntervalMs: 1_000,
      ...overrides.storage,
    },
    prim: {
      enabled: false,
      apiKey: "",
      apiUrl: "https://prim.example.test/line",
      timeoutMs: 8_000,
      ...overrides.prim,
    },
  };
}

export function parsedServerConfig(overrides = {}) {
  return parseServerConfig(rawServerConfig(overrides), {
    configPath: "/tmp/paris-icc-test/config/server.local.json",
    environment: {},
  });
}

export const TEST_WEBMCP_TOOL = {
  name: "inspect_network_digital_twin",
  description: "Inspect the bounded native network digital twin.",
  inputSchema: {
    type: "object",
    properties: {
      line: { type: "string" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
