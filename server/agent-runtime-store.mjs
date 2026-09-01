import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "paris-icc-agent-runtime.v1";
const CATEGORIES = new Set(["generic", "incident", "report"]);
const OUTCOMES = new Set(["completed", "tool_calls", "failed"]);

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
    this.allowedModels = Object.freeze([...config.openai.allowedModels]);
    this.maximumEntries = config.agent.logMaxEntries;
    this.now = options.now ?? (() => Date.now());
    this.model = this.defaultModel;
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
      if (parsed?.schemaVersion !== SCHEMA_VERSION) return;
      if (this.allowedModels.includes(parsed.model)) this.model = parsed.model;
      if (typeof parsed.updatedAt === "string") this.updatedAt = parsed.updatedAt;
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

  configuration() {
    return {
      enabled: this.enabled,
      model: this.model,
      defaultModel: this.defaultModel,
      allowedModels: [...this.allowedModels],
      updatedAt: this.updatedAt,
    };
  }

  async updateModel(model) {
    if (!this.allowedModels.includes(model)) {
      const error = new Error("The requested agent model is not allowed by server configuration.");
      error.code = "model_not_allowed";
      throw error;
    }
    return this.#mutate(async () => {
      const previousModel = this.model;
      const previousUpdatedAt = this.updatedAt;
      this.model = model;
      this.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.#persist();
      } catch (error) {
        this.model = previousModel;
        this.updatedAt = previousUpdatedAt;
        throw error;
      }
      return this.configuration();
    });
  }

  async record(raw) {
    const timestamp = new Date(this.now()).toISOString();
    const entry = safePersistedEntry({
      id: randomUUID(),
      timestamp,
      category: raw?.category,
      model: raw?.model,
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
    const payload = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      model: this.model,
      updatedAt: this.updatedAt,
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
