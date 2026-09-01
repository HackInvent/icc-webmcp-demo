import { readFileSync } from "node:fs";
import path from "node:path";
import {
  configuredOpenAiAgentModels,
  defaultReasoningEffortFor,
  openAiAgentModelProfile,
  supportsReasoningEffort,
} from "./openai-model-catalog.mjs";
import {
  IncidentInstructionValidationError,
  parseConfiguredIncidentInstructions,
} from "./incident-instruction-registry.mjs";
import { hashAccessCode } from "./security.mjs";

const ENV_REFERENCE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function configurationError(pathLabel, message) {
  throw new ConfigurationError(`${pathLabel}: ${message}`);
}

function expandEnvironment(value, environment, pathLabel = "configuration") {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      expandEnvironment(item, environment, `${pathLabel}[${index}]`)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandEnvironment(item, environment, `${pathLabel}.${key}`),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  return value.replace(ENV_REFERENCE, (_match, variableName) => {
    const resolved = environment[variableName];
    if (typeof resolved !== "string" || resolved.length === 0) {
      configurationError(pathLabel, `environment variable ${variableName} is missing`);
    }
    return resolved;
  });
}

function objectAt(value, pathLabel) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    configurationError(pathLabel, "must be a JSON object");
  }
  return value;
}

function stringAt(value, pathLabel, { min = 1, max = 20_000 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    configurationError(pathLabel, `must be a string between ${min} and ${max} characters`);
  }
  return value;
}

function booleanAt(value, pathLabel) {
  if (typeof value !== "boolean") configurationError(pathLabel, "must be a boolean");
  return value;
}

function integerAt(value, pathLabel, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    configurationError(pathLabel, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalString(value, pathLabel, options = {}) {
  if (value === undefined || value === null || value === "") return "";
  return stringAt(value, pathLabel, options);
}

function parsePublicOrigin(value) {
  const origin = stringAt(value, "application.publicOrigin", { max: 300 });
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    configurationError("application.publicOrigin", "must be an absolute URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.origin !== origin) {
    configurationError(
      "application.publicOrigin",
      "must contain only an http(s) origin without a path",
    );
  }
  if (parsed.hostname.includes("_")) {
    configurationError(
      "application.publicOrigin",
      "hostname labels cannot contain underscores; use hyphens so public TLS certificates can be issued",
    );
  }
  return parsed.origin;
}

function parsePresets(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    configurationError("agent.presets", "must contain between 1 and 6 presets");
  }
  const ids = new Set();
  return value.map((raw, index) => {
    const preset = objectAt(raw, `agent.presets[${index}]`);
    const id = stringAt(preset.id, `agent.presets[${index}].id`, { max: 40 });
    if (!/^[a-z0-9-]+$/.test(id)) {
      configurationError(`agent.presets[${index}].id`, "must use lowercase letters, digits or hyphens");
    }
    if (ids.has(id)) configurationError(`agent.presets[${index}].id`, "must be unique");
    ids.add(id);
    return {
      id,
      label: stringAt(preset.label, `agent.presets[${index}].label`, { max: 80 }),
      prompt: stringAt(preset.prompt, `agent.presets[${index}].prompt`, { max: 2_500 }),
    };
  });
}

function parseIncidentInstructions(value) {
  try {
    return parseConfiguredIncidentInstructions(value);
  } catch (error) {
    if (error instanceof IncidentInstructionValidationError) {
      configurationError(error.path, error.message);
    }
    throw error;
  }
}

function parseAllowedModels(value, defaultModel) {
  const source = value ?? [defaultModel];
  if (!Array.isArray(source) || source.length < 1 || source.length > 32) {
    configurationError("openai.allowedModels", "must contain between 1 and 32 model identifiers");
  }
  const models = source.map((item, index) =>
    stringAt(item, `openai.allowedModels[${index}]`, { max: 100 })
  );
  if (new Set(models).size !== models.length) {
    configurationError("openai.allowedModels", "must not contain duplicate model identifiers");
  }
  if (!models.includes(defaultModel)) {
    configurationError("openai.allowedModels", "must include openai.model");
  }
  models.forEach((model, index) => {
    if (!openAiAgentModelProfile(model)) {
      configurationError(
        "openai.allowedModels[" + index + "]",
        "is not a current OpenAI model compatible with this agent workflow",
      );
    }
  });
  return models;
}

export function parseServerConfig(rawConfiguration, options = {}) {
  const configPath = path.resolve(options.configPath ?? "config/server.local.json");
  const environment = options.environment ?? process.env;
  const root = objectAt(
    expandEnvironment(objectAt(rawConfiguration, "configuration"), environment),
    "configuration",
  );
  const application = objectAt(root.application, "application");
  const server = objectAt(root.server, "server");
  const auth = objectAt(root.auth, "auth");
  const openai = objectAt(root.openai, "openai");
  const agent = objectAt(root.agent, "agent");
  const prim = objectAt(root.prim ?? { enabled: false }, "prim");
  const storage = objectAt(root.storage ?? {}, "storage");

  const publicOrigin = parsePublicOrigin(application.publicOrigin);
  const accessCode = optionalString(auth.accessCode, "auth.accessCode", { min: 8, max: 200 });
  const configuredAccessCodeHash = optionalString(
    auth.accessCodeHash,
    "auth.accessCodeHash",
    { max: 300 },
  );
  if (Boolean(accessCode) === Boolean(configuredAccessCodeHash)) {
    configurationError("auth", "must define exactly one of accessCode or accessCodeHash");
  }
  if (
    configuredAccessCodeHash &&
    !/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(configuredAccessCodeHash)
  ) {
    configurationError("auth.accessCodeHash", "must be generated by npm run configure:server");
  }
  const accessCodeHash = configuredAccessCodeHash || hashAccessCode(accessCode);
  const sessionSecret = stringAt(auth.sessionSecret, "auth.sessionSecret", {
    min: 32,
    max: 500,
  });
  const openaiEnabled = booleanAt(openai.enabled, "openai.enabled");
  const openaiApiKey = optionalString(openai.apiKey, "openai.apiKey", { max: 500 });
  if (openaiEnabled && openaiApiKey.length < 20) {
    configurationError("openai.apiKey", "is required when OpenAI is enabled");
  }
  const defaultOpenAiModel = stringAt(openai.model ?? "gpt-5.6-terra", "openai.model", { max: 100 });
  const allowedOpenAiModels = parseAllowedModels(openai.allowedModels, defaultOpenAiModel);
  const modelDefaultReasoningEffort = defaultReasoningEffortFor(defaultOpenAiModel);
  const reasoningEffort = openai.reasoningEffort === undefined || openai.reasoningEffort === null
    ? modelDefaultReasoningEffort
    : stringAt(openai.reasoningEffort, "openai.reasoningEffort", { max: 10 });
  if (
    (reasoningEffort !== null && !supportsReasoningEffort(defaultOpenAiModel, reasoningEffort)) ||
    (reasoningEffort === null && modelDefaultReasoningEffort !== null)
  ) {
    configurationError(
      "openai.reasoningEffort",
      "is not supported by " + defaultOpenAiModel,
    );
  }
  const primEnabled = booleanAt(prim.enabled, "prim.enabled");
  const primApiKey = optionalString(prim.apiKey, "prim.apiKey", { max: 500 });
  if (primEnabled && primApiKey.length < 8) {
    configurationError("prim.apiKey", "is required when PRIM is enabled");
  }

  const configDirectory = path.dirname(configPath);
  const parsed = {
    configPath,
    application: {
      name: stringAt(application.name ?? "Paris ICC", "application.name", { max: 100 }),
      environment: stringAt(application.environment ?? "production", "application.environment", { max: 30 }),
      publicOrigin,
      dataMode: stringAt(application.dataMode ?? "local-simulation", "application.dataMode", { max: 80 }),
    },
    server: {
      host: stringAt(server.host ?? "127.0.0.1", "server.host", { max: 100 }),
      port: integerAt(server.port ?? 8787, "server.port", 1, 65_535),
      trustProxy: booleanAt(server.trustProxy ?? false, "server.trustProxy"),
      distDirectory: path.resolve(
        configDirectory,
        stringAt(server.distDirectory ?? "../dist", "server.distDirectory", { max: 500 }),
      ),
      maxRequestBodyBytes: integerAt(
        server.maxRequestBodyBytes ?? 262_144,
        "server.maxRequestBodyBytes",
        16_384,
        1_048_576,
      ),
    },
    auth: {
      accessCodeHash,
      sessionSecret,
      cookieName: stringAt(auth.cookieName ?? "paris_icc_session", "auth.cookieName", { max: 80 }),
      sessionTtlMinutes: integerAt(auth.sessionTtlMinutes ?? 480, "auth.sessionTtlMinutes", 15, 10_080),
      secureCookies: booleanAt(auth.secureCookies ?? publicOrigin.startsWith("https://"), "auth.secureCookies"),
      maxFailedAttempts: integerAt(auth.maxFailedAttempts ?? 5, "auth.maxFailedAttempts", 2, 30),
      failureWindowSeconds: integerAt(auth.failureWindowSeconds ?? 600, "auth.failureWindowSeconds", 30, 86_400),
    },
    openai: {
      enabled: openaiEnabled,
      apiKey: openaiApiKey,
      model: defaultOpenAiModel,
      allowedModels: allowedOpenAiModels,
      modelProfiles: configuredOpenAiAgentModels(allowedOpenAiModels),
      reasoningEffort,
      maxOutputTokens: integerAt(openai.maxOutputTokens ?? 1_800, "openai.maxOutputTokens", 256, 16_000),
      timeoutMs: integerAt(openai.timeoutMs ?? 45_000, "openai.timeoutMs", 5_000, 120_000),
      baseUrl: stringAt(openai.baseUrl ?? "https://api.openai.com/v1", "openai.baseUrl", { max: 500 }).replace(/\/$/, ""),
    },
    agent: {
      instructions: stringAt(agent.instructions, "agent.instructions", { min: 100, max: 20_000 }),
      presets: parsePresets(agent.presets),
      incidentInstructions: parseIncidentInstructions(agent.incidentInstructions),
      maxPromptCharacters: integerAt(agent.maxPromptCharacters ?? 3_000, "agent.maxPromptCharacters", 200, 12_000),
      maxToolOutputCharacters: integerAt(agent.maxToolOutputCharacters ?? 60_000, "agent.maxToolOutputCharacters", 2_000, 200_000),
      maxToolRounds: integerAt(agent.maxToolRounds ?? 8, "agent.maxToolRounds", 1, 16),
      runTtlMinutes: integerAt(agent.runTtlMinutes ?? 30, "agent.runTtlMinutes", 5, 240),
      maxRunsPerSession: integerAt(agent.maxRunsPerSession ?? 4, "agent.maxRunsPerSession", 1, 20),
      requestsPerMinute: integerAt(agent.requestsPerMinute ?? 20, "agent.requestsPerMinute", 2, 120),
      logMaxEntries: integerAt(agent.logMaxEntries ?? 1_000, "agent.logMaxEntries", 50, 10_000),
    },
    storage: {
      databasePath: path.resolve(
        configDirectory,
        stringAt(storage.databasePath ?? "../state/paris-icc.sqlite", "storage.databasePath", { max: 500 }),
      ),
      agentRuntimePath: path.resolve(
        configDirectory,
        stringAt(storage.agentRuntimePath ?? "../state/agent-runtime.json", "storage.agentRuntimePath", { max: 500 }),
      ),
      tickIntervalMs: integerAt(storage.tickIntervalMs ?? 1_000, "storage.tickIntervalMs", 250, 5_000),
    },
    prim: {
      enabled: primEnabled,
      apiKey: primApiKey,
      apiUrl: stringAt(
        prim.apiUrl ?? "https://prim.iledefrance-mobilites.fr/marketplace/requete-ligne",
        "prim.apiUrl",
        { max: 500 },
      ),
      timeoutMs: integerAt(prim.timeoutMs ?? 8_000, "prim.timeoutMs", 1_000, 30_000),
    },
  };

  if (parsed.auth.secureCookies && !publicOrigin.startsWith("https://")) {
    configurationError("auth.secureCookies", "requires an https publicOrigin");
  }
  return parsed;
}

export function loadServerConfig(configPath, options = {}) {
  const resolvedPath = path.resolve(configPath);
  let source;
  try {
    source = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new ConfigurationError(
      `Cannot read server configuration ${resolvedPath}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ConfigurationError(
      `Invalid JSON in ${resolvedPath}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return parseServerConfig(parsed, {
    configPath: resolvedPath,
    environment: options.environment ?? process.env,
  });
}

export function resolveConfigPath(argv = process.argv.slice(2), environment = process.env) {
  const flagIndex = argv.indexOf("--config");
  if (flagIndex >= 0) {
    const candidate = argv[flagIndex + 1];
    if (!candidate || candidate.startsWith("--")) {
      throw new ConfigurationError("--config requires a JSON file path");
    }
    return path.resolve(candidate);
  }
  return path.resolve(environment.PARIS_ICC_CONFIG ?? "config/server.local.json");
}

export function publicRuntimeConfiguration(config, authenticated, options = {}) {
  const effectiveModel = options.model ?? config.openai.model;
  const effectiveReasoningEffort = options.reasoningEffort !== undefined
    ? options.reasoningEffort
    : config.openai.reasoningEffort;
  return {
    authenticated,
    application: {
      name: config.application.name,
      environment: config.application.environment,
      dataMode: config.application.dataMode,
    },
    agent: {
      enabled: config.openai.enabled,
      model: config.openai.enabled ? effectiveModel : null,
      reasoningEffort: config.openai.enabled ? effectiveReasoningEffort : null,
      maxToolRounds: config.agent.maxToolRounds,
      presets: config.agent.presets,
    },
    prim: {
      enabled: config.prim.enabled,
    },
  };
}
