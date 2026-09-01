import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INCIDENT_INSTRUCTION_SCHEMA_VERSION,
  incidentInstructionTransfer,
  parseIncidentInstructionOverrides,
  parseIncidentInstructionTransfer,
} from "./incident-instruction-registry.mjs";

const SCHEMA_VERSION = "paris-icc-agent-runtime.v4";
const READABLE_SCHEMA_VERSIONS = new Set([
  "paris-icc-agent-runtime.v1",
  "paris-icc-agent-runtime.v2",
  "paris-icc-agent-runtime.v3",
  SCHEMA_VERSION,
]);
const CATEGORIES = new Set(["generic", "incident", "report"]);
const OUTCOMES = new Set(["completed", "tool_calls", "failed"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function boundedString(value, maximum = 160) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maximum)
    : undefined;
}

function boundedInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? Math.min(number, maximum)
    : undefined;
}

function safePersistedEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const category = CATEGORIES.has(raw.category) ? raw.category : null;
  const outcome = OUTCOMES.has(raw.outcome) ? raw.outcome : null;
  const timestamp = boundedString(raw.timestamp, 40);
  const model = boundedString(raw.model, 100);
  const reasoningEffort = REASONING_EFFORTS.has(raw.reasoningEffort)
    ? raw.reasoningEffort
    : undefined;
  if (!category || !outcome || !timestamp || !model) return null;
  const toolNames = Array.isArray(raw.toolNames)
    ? [...new Set(raw.toolNames
        .map((item) => boundedString(item, 100))
        .filter(Boolean))].slice(0, 16)
    : [];
  return {
    id: boundedString(raw.id, 100) ?? randomUUID(),
    timestamp,
    category,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    outcome,
    durationMs: boundedInteger(raw.durationMs, 86_400_000) ?? 0,
    ...(boundedString(raw.runId, 100) ? { runId: boundedString(raw.runId, 100) } : {}),
    ...(boundedString(raw.entityId, 160) ? { entityId: boundedString(raw.entityId, 160) } : {}),
    ...(boundedInteger(raw.toolRound, 64) !== undefined
      ? { toolRound: boundedInteger(raw.toolRound, 64) }
      : {}),
    ...(boundedInteger(raw.inputTokens, 100_000_000) !== undefined
      ? { inputTokens: boundedInteger(raw.inputTokens, 100_000_000) }
      : {}),
    ...(boundedInteger(raw.outputTokens, 100_000_000) !== undefined
      ? { outputTokens: boundedInteger(raw.outputTokens, 100_000_000) }
      : {}),
    ...(boundedString(raw.errorCode, 100) ? { errorCode: boundedString(raw.errorCode, 100) } : {}),
    ...(toolNames.length > 0 ? { toolNames } : {}),
  };
}

export class AgentRuntimeStore {
  constructor(config, options = {}) {
    this.path = config.storage.agentRuntimePath;
    this.enabled = config.openai.enabled;
    this.defaultModel = config.openai.model;
    this.defaultReasoningEffort = config.openai.reasoningEffort;
    this.allowedModels = Object.freeze([...config.openai.allowedModels]);
    this.models = Object.freeze(config.openai.modelProfiles.map((profile) => Object.freeze({
      ...profile,
      reasoningEfforts: Object.freeze([...profile.reasoningEfforts]),
    })));
    this.modelById = new Map(this.models.map((profile) => [profile.id, profile]));
    this.defaultIncidentInstructions = Object.freeze(config.agent.incidentInstructions.map((entry) => Object.freeze({
      ...entry,
    })));
    this.incidentInstructions = this.defaultIncidentInstructions.map((entry) => ({ ...entry }));
    this.maximumEntries = config.agent.logMaxEntries;
    this.now = options.now ?? (() => Date.now());
    this.model = this.defaultModel;
    this.reasoningEffort = this.defaultReasoningEffort;
    this.updatedAt = new Date(this.now()).toISOString();
    this.entries = [];
    this.mutationQueue = Promise.resolve();
    this.persistQueue = Promise.resolve();
    this.rename = options.rename ?? rename;
    this.unlink = options.unlink ?? unlink;
    this.writeFile = options.writeFile ?? writeFile;
    this.#load();
  }

  #load() {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (!READABLE_SCHEMA_VERSIONS.has(parsed?.schemaVersion)) return;
      if (this.allowedModels.includes(parsed.model)) this.model = parsed.model;
      const profile = this.modelById.get(this.model);
      const persistedEffort = parsed.reasoningEffort === null ? null : boundedString(parsed.reasoningEffort, 10);
      if (this.#supportsEffort(profile, persistedEffort)) {
        this.reasoningEffort = persistedEffort;
      } else if (profile?.reasoningEfforts.includes(this.defaultReasoningEffort)) {
        this.reasoningEffort = this.defaultReasoningEffort;
      } else {
        this.reasoningEffort = profile?.defaultReasoningEffort ?? null;
      }
      if (typeof parsed.updatedAt === "string") this.updatedAt = parsed.updatedAt;
      const hasLegacyCompleteInstructions = parsed.schemaVersion === "paris-icc-agent-runtime.v3" &&
        Array.isArray(parsed.incidentInstructions);
      const hasInstructionOverrides = parsed.schemaVersion === SCHEMA_VERSION &&
        Array.isArray(parsed.incidentInstructionOverrides);
      if (hasLegacyCompleteInstructions || hasInstructionOverrides) {
        try {
          const restored = hasLegacyCompleteInstructions
            ? parseIncidentInstructionTransfer({
                schemaVersion: INCIDENT_INSTRUCTION_SCHEMA_VERSION,
                instructions: parsed.incidentInstructions,
              })
            : parseIncidentInstructionOverrides(parsed.incidentInstructionOverrides);
          const restoredByType = new Map(restored.map((entry) => [entry.type, entry.instruction]));
          this.incidentInstructions = this.defaultIncidentInstructions.map((entry) => ({
            ...entry,
            instruction: restoredByType.get(entry.type) ?? entry.instruction,
          }));
        } catch (error) {
          console.warn(`[agent-runtime] Ignoring invalid incident instructions at ${this.path}: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      if (Array.isArray(parsed.entries)) {
        this.entries = parsed.entries
          .map(safePersistedEntry)
          .filter(Boolean)
          .slice(0, this.maximumEntries);
      }
    } catch (error) {
      console.warn(`[agent-runtime] Ignoring unreadable state at ${this.path}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  currentModel() {
    return this.model;
  }

  currentReasoningEffort() {
    return this.reasoningEffort;
  }

  currentSelection() {
    return { model: this.model, reasoningEffort: this.reasoningEffort };
  }

  configuration() {
    return {
      enabled: this.enabled,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      defaultModel: this.defaultModel,
      defaultReasoningEffort: this.defaultReasoningEffort,
      allowedModels: [...this.allowedModels],
      models: this.models.map((profile) => ({
        ...profile,
        reasoningEfforts: [...profile.reasoningEfforts],
      })),
      updatedAt: this.updatedAt,
    };
  }

  incidentInstructionConfiguration() {
    const defaults = new Map(this.defaultIncidentInstructions.map((entry) => [entry.type, entry.instruction]));
    return {
      schemaVersion: INCIDENT_INSTRUCTION_SCHEMA_VERSION,
      updatedAt: this.updatedAt,
      instructions: this.incidentInstructions.map((entry) => ({
        ...entry,
        defaultInstruction: defaults.get(entry.type),
        modified: entry.instruction !== defaults.get(entry.type),
      })),
    };
  }

  currentIncidentInstruction(type) {
    const entry = this.incidentInstructions.find((candidate) => candidate.type === type);
    return entry ? { type: entry.type, label: entry.label, instruction: entry.instruction } : null;
  }

  exportIncidentInstructions() {
    return incidentInstructionTransfer(this.incidentInstructions);
  }

  #supportsEffort(profile, reasoningEffort) {
    if (!profile) return false;
    return profile.reasoningEfforts.length === 0
      ? reasoningEffort === null
      : typeof reasoningEffort === "string" && profile.reasoningEfforts.includes(reasoningEffort);
  }

  async updateConfiguration(model, requestedReasoningEffort) {
    if (!this.allowedModels.includes(model)) {
      const error = new Error("The requested agent model is not allowed by server configuration.");
      error.code = "model_not_allowed";
      throw error;
    }
    const profile = this.modelById.get(model);
    const reasoningEffort = requestedReasoningEffort === undefined
      ? (this.#supportsEffort(profile, this.reasoningEffort)
          ? this.reasoningEffort
          : profile.defaultReasoningEffort)
      : requestedReasoningEffort;
    if (!this.#supportsEffort(profile, reasoningEffort)) {
      const error = new Error("The requested reasoning effort is not supported by the selected model.");
      error.code = "reasoning_effort_not_supported";
      throw error;
    }
    return this.#mutate(async () => {
      const previousModel = this.model;
      const previousReasoningEffort = this.reasoningEffort;
      const previousUpdatedAt = this.updatedAt;
      this.model = model;
      this.reasoningEffort = reasoningEffort;
      this.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.#persist();
      } catch (error) {
        this.model = previousModel;
        this.reasoningEffort = previousReasoningEffort;
        this.updatedAt = previousUpdatedAt;
        throw error;
      }
      return this.configuration();
    });
  }

  async updateModel(model) {
    return this.updateConfiguration(model, undefined);
  }

  async replaceIncidentInstructions(rawConfiguration) {
    const validated = parseIncidentInstructionTransfer(rawConfiguration);
    const instructionsByType = new Map(validated.map((entry) => [entry.type, entry.instruction]));
    return this.#mutate(async () => {
      const previousInstructions = this.incidentInstructions;
      const previousUpdatedAt = this.updatedAt;
      this.incidentInstructions = this.defaultIncidentInstructions.map((entry) => ({
        ...entry,
        instruction: instructionsByType.get(entry.type),
      }));
      this.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.#persist();
      } catch (error) {
        this.incidentInstructions = previousInstructions;
        this.updatedAt = previousUpdatedAt;
        throw error;
      }
      return this.incidentInstructionConfiguration();
    });
  }

  async record(raw) {
    const timestamp = new Date(this.now()).toISOString();
    const entry = safePersistedEntry({
      id: randomUUID(),
      timestamp,
      category: raw?.category,
      model: raw?.model,
      reasoningEffort: raw?.reasoningEffort,
      outcome: raw?.outcome,
      durationMs: raw?.durationMs,
      runId: raw?.runId,
      entityId: raw?.entityId,
      toolRound: raw?.toolRound,
      inputTokens: raw?.inputTokens,
      outputTokens: raw?.outputTokens,
      errorCode: raw?.errorCode,
      toolNames: raw?.toolNames,
    });
    if (!entry) return null;
    return this.#mutate(async () => {
      const previousEntries = this.entries;
      this.entries = [entry, ...this.entries].slice(0, this.maximumEntries);
      try {
        await this.#persist();
      } catch (error) {
        this.entries = previousEntries;
        throw error;
      }
      return entry;
    });
  }

  list(limit = 200) {
    const boundedLimit = Math.max(1, Math.min(this.maximumEntries, Number(limit) || 200));
    return this.entries.slice(0, boundedLimit).map((entry) => ({ ...entry }));
  }

  entryCount() {
    return this.entries.length;
  }

  export() {
    return {
      schemaVersion: "paris-icc-agent-log.v1",
      exportedAt: new Date(this.now()).toISOString(),
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      entries: this.list(this.maximumEntries),
    };
  }

  #mutate(task) {
    const operation = this.mutationQueue
      .catch(() => undefined)
      .then(task);
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async #persist() {
    const defaults = new Map(this.defaultIncidentInstructions.map((entry) => [entry.type, entry.instruction]));
    const payload = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      updatedAt: this.updatedAt,
      incidentInstructionOverrides: this.incidentInstructions
        .filter((entry) => entry.instruction !== defaults.get(entry.type))
        .map(({ type, instruction }) => ({ type, instruction })),
      entries: this.entries,
    }, null, 2) + "\n";
    const directory = path.dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const operation = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
          await this.rename(temporaryPath, this.path);
        } catch (error) {
          await this.unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
      });
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }

  async close() {
    await this.mutationQueue;
    await this.persistQueue;
  }
}
