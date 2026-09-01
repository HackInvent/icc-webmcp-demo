import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import { acquireExclusiveFileLock } from "./exclusive-file-lock.mjs";

export const OPERATIONS_REPOSITORY_SCHEMA_VERSION = 2;

const DEFAULT_WORKSPACE_ID = "default";
const MAX_ID_LENGTH = 160;
const MAX_EVENT_LIMIT = 1_000;

export class OperationsRepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "OperationsRepositoryError";
    this.code = code;
  }
}

export class OperationsRepositoryConflictError extends OperationsRepositoryError {
  constructor(message, details = {}) {
    super("state_revision_conflict", message);
    this.name = "OperationsRepositoryConflictError";
    this.details = details;
  }
}

export class OperationsRepositoryClosedError extends OperationsRepositoryError {
  constructor() {
    super("repository_closed", "The operations repository is closed.");
    this.name = "OperationsRepositoryClosedError";
  }
}

export class OperationsRepositoryLockedError extends OperationsRepositoryError {
  constructor(message, details = {}, options = {}) {
    super("database_locked", message, options);
    this.name = "OperationsRepositoryLockedError";
    this.details = details;
  }
}

function repositoryError(code, message, cause) {
  return new OperationsRepositoryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function boundedId(value, label, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_ID_LENGTH ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw repositoryError(
      "invalid_identifier",
      `${label} must be a non-empty string of at most ${MAX_ID_LENGTH} characters.`,
    );
  }
  return value.trim();
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError("invalid_integer", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw repositoryError(
      "invalid_integer",
      `${label} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError("invalid_timestamp", `${label} must be a non-negative epoch millisecond.`);
  }
  return value;
}

function encodeJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw repositoryError("invalid_json", `${label} must be JSON serializable.`, error);
  }
  if (encoded === undefined) {
    throw repositoryError("invalid_json", `${label} must be JSON serializable.`);
  }
  return encoded;
}

function decodeJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw repositoryError("corrupt_database", `${label} contains invalid JSON.`, error);
  }
}

function cloneJson(value, label) {
  return decodeJson(encodeJson(value, label), label);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createCommandRequestFingerprint(input = {}) {
  const commandType = boundedId(input.commandType, "commandType");
  const expectedStateRevision = input.expectedStateRevision === undefined
    ? null
    : nonNegativeInteger(input.expectedStateRevision, "expectedStateRevision");
  const payload = cloneJson(input.payload ?? {}, "command payload");
  const digest = createHash("sha256")
    .update(canonicalJson({ commandType, expectedStateRevision, payload }))
    .digest("hex");
  return `sha256:${digest}`;
}

function requestFingerprint(value, fallbackInput) {
  if (value === undefined) return createCommandRequestFingerprint(fallbackInput);
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw repositoryError(
      "invalid_command_fingerprint",
      "requestFingerprint must be a lowercase SHA-256 fingerprint.",
    );
  }
  return value;
}

function queryOne(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function queryAll(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  const rows = [];
  try {
    statement.bind(parameters);
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function runtimeRecord(row) {
  if (!row) return null;
  return {
    workspaceId: String(row.workspace_id),
    stateSchemaVersion: Number(row.state_schema_version),
    stateRevision: Number(row.state_revision),
    state: decodeJson(String(row.state_json), "runtime_state.state_json"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function eventRecord(row) {
  if (!row) return null;
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    workspaceId: String(row.workspace_id),
    eventType: String(row.event_type),
    commandId: row.command_id === null ? null : String(row.command_id),
    actorSessionId: row.actor_session_id === null ? null : String(row.actor_session_id),
    stateRevision: Number(row.state_revision),
    occurredAt: Number(row.occurred_at),
    payload: decodeJson(String(row.payload_json), "operation_events.payload_json"),
  };
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // The rename is already atomic. Some platforms do not permit directory fsync.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteFile(filePath, bytes) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    renamed = true;
    await fsyncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        workspace_id TEXT PRIMARY KEY,
        state_schema_version INTEGER NOT NULL CHECK (state_schema_version >= 1),
        state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operation_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        command_id TEXT,
        actor_session_id TEXT,
        state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
        occurred_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES runtime_state(workspace_id)
      );

      CREATE INDEX IF NOT EXISTS operation_events_workspace_sequence
        ON operation_events(workspace_id, sequence);

      CREATE TABLE IF NOT EXISTS command_results (
        workspace_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
        result_json TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, command_id),
        FOREIGN KEY (workspace_id) REFERENCES runtime_state(workspace_id),
        FOREIGN KEY (event_sequence) REFERENCES operation_events(sequence)
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE command_results ADD COLUMN request_fingerprint TEXT;
    `,
  },
]);

export class OperationsRepository {
  #databasePath;
  #sqlJsFactory;
  #now;
  #SQL = null;
  #database = null;
  #initialized = false;
  #closed = false;
  #fileLock = null;
  #queue = Promise.resolve();

  constructor(options = {}) {
    if (typeof options.databasePath !== "string" || options.databasePath.trim().length === 0) {
      throw repositoryError("invalid_path", "databasePath is required.");
    }
    if (options.sqlJsFactory !== undefined && typeof options.sqlJsFactory !== "function") {
      throw repositoryError("invalid_factory", "sqlJsFactory must be a function.");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw repositoryError("invalid_clock", "now must be a function.");
    }
    this.#databasePath = path.resolve(options.databasePath);
    this.#sqlJsFactory = options.sqlJsFactory ?? initSqlJs;
    this.#now = options.now ?? (() => Date.now());
  }

  get databasePath() {
    return this.#databasePath;
  }

  init() {
    return this.#enqueue(async () => {
      this.#assertOpen();
      if (this.#initialized) return this;
      try {
        this.#fileLock = await acquireExclusiveFileLock({
          targetPath: this.#databasePath,
          now: this.#now,
        });
      } catch (error) {
        if (error?.code === "resource_locked" || error?.code === "resource_locked_unverifiable") {
          throw new OperationsRepositoryLockedError(
            `Operations database ${this.#databasePath} is already in use.`,
            error.details ?? {},
            { cause: error },
          );
        }
        throw repositoryError(
          "database_lock_failed",
          `Cannot lock operations database ${this.#databasePath}.`,
          error,
        );
      }
      let source = null;
      try {
        source = await readFile(this.#databasePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          await this.#releaseFileLock().catch(() => {});
          throw repositoryError(
            "database_read_failed",
            `Cannot read operations database ${this.#databasePath}.`,
            error,
          );
        }
      }

      try {
        this.#SQL = await this.#sqlJsFactory();
        this.#database = source === null
          ? new this.#SQL.Database()
          : new this.#SQL.Database(new Uint8Array(source));
        this.#database.run("PRAGMA foreign_keys = ON;");
        this.#applyMigrations();
        await this.#persist();
        this.#initialized = true;
        return this;
      } catch (error) {
        this.#database?.close();
        this.#database = null;
        this.#SQL = null;
        await this.#releaseFileLock().catch(() => {});
        if (error instanceof OperationsRepositoryError) throw error;
        throw repositoryError(
          "database_initialization_failed",
          `Cannot initialize operations database ${this.#databasePath}.`,
          error,
        );
      }
    });
  }

  load(workspaceId = DEFAULT_WORKSPACE_ID) {
    return this.#enqueue(async () => {
      this.#assertReady();
      const normalizedWorkspaceId = boundedId(workspaceId, "workspaceId");
      return runtimeRecord(queryOne(
        this.#database,
        `SELECT workspace_id, state_schema_version, state_revision, state_json,
                created_at, updated_at
           FROM runtime_state
          WHERE workspace_id = ?`,
        [normalizedWorkspaceId],
      ));
    });
  }

  loadRuntime(workspaceId = DEFAULT_WORKSPACE_ID) {
    return this.load(workspaceId);
  }

  save(input = {}) {
    return this.#enqueue(async () => {
      this.#assertReady();
      const workspaceId = boundedId(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "workspaceId");
      const stateSchemaVersion = positiveInteger(
        input.stateSchemaVersion ?? 1,
        "stateSchemaVersion",
      );
      const stateJson = encodeJson(input.state, "state");
      const existing = queryOne(
        this.#database,
        "SELECT state_revision, created_at FROM runtime_state WHERE workspace_id = ?",
        [workspaceId],
      );
      const currentRevision = existing ? Number(existing.state_revision) : null;
      if (input.expectedStateRevision !== undefined) {
        const expected = nonNegativeInteger(
          input.expectedStateRevision,
          "expectedStateRevision",
        );
        if (currentRevision !== expected) {
          throw new OperationsRepositoryConflictError(
            `Workspace ${workspaceId} is at revision ${currentRevision ?? "missing"}, not ${expected}.`,
            { workspaceId, expectedStateRevision: expected, currentStateRevision: currentRevision },
          );
        }
      }
      const stateRevision = input.stateRevision === undefined
        ? currentRevision === null ? 0 : currentRevision + 1
        : nonNegativeInteger(input.stateRevision, "stateRevision");
      if (currentRevision !== null && stateRevision < currentRevision) {
        throw new OperationsRepositoryConflictError(
          `Workspace ${workspaceId} cannot move backwards from revision ${currentRevision} to ${stateRevision}.`,
          { workspaceId, expectedStateRevision: currentRevision, currentStateRevision: stateRevision },
        );
      }
      const now = this.#currentTime();
      const normalizedEvent = input.event === undefined || input.event === null
        ? null
        : this.#normalizeEvent(input.event, { workspaceId, stateRevision, occurredAt: now });
      let sequence = null;

      await this.#transaction(async () => {
        this.#database.run(
          `INSERT INTO runtime_state (
             workspace_id, state_schema_version, state_revision, state_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             state_schema_version = excluded.state_schema_version,
             state_revision = excluded.state_revision,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
          [
            workspaceId,
            stateSchemaVersion,
            stateRevision,
            stateJson,
            existing ? Number(existing.created_at) : now,
            now,
          ],
        );
        if (normalizedEvent) sequence = this.#insertEvent(normalizedEvent);
      });

      const runtimeState = runtimeRecord(queryOne(
        this.#database,
        `SELECT workspace_id, state_schema_version, state_revision, state_json,
                created_at, updated_at
           FROM runtime_state WHERE workspace_id = ?`,
        [workspaceId],
      ));
      const event = sequence === null ? null : eventRecord(queryOne(
        this.#database,
        `SELECT sequence, event_id, workspace_id, event_type, command_id,
                actor_session_id, state_revision, occurred_at, payload_json
           FROM operation_events WHERE sequence = ?`,
        [sequence],
      ));
      return { runtimeState, event };
    });
  }

  saveRuntime(workspaceId, state, options = {}) {
    return this.save({
      ...options,
      workspaceId,
      state,
    });
  }

  getCommandResult(workspaceId, commandId) {
    return this.#enqueue(async () => {
      this.#assertReady();
      const normalizedWorkspaceId = boundedId(workspaceId, "workspaceId");
      const normalizedCommandId = boundedId(commandId, "commandId");
      const row = queryOne(
        this.#database,
        `SELECT workspace_id, command_id, command_type, request_fingerprint,
                state_revision, result_json, event_sequence, created_at
           FROM command_results
          WHERE workspace_id = ? AND command_id = ?`,
        [normalizedWorkspaceId, normalizedCommandId],
      );
      if (!row) return null;
      return {
        workspaceId: String(row.workspace_id),
        commandId: String(row.command_id),
        commandType: String(row.command_type),
        requestFingerprint: row.request_fingerprint === null
          ? null
          : String(row.request_fingerprint),
        stateRevision: Number(row.state_revision),
        result: decodeJson(String(row.result_json), "command_results.result_json"),
        eventSequence: Number(row.event_sequence),
        createdAt: Number(row.created_at),
      };
    });
  }

  saveCommandResult(workspaceId, commandId, result, state, options = {}) {
    const event = options.event ?? {};
    const commandType = options.commandType ?? event.commandType ?? event.type ?? "runtime_command";
    return this.executeCommandTransaction({
      workspaceId,
      commandId,
      commandType,
      requestFingerprint: options.requestFingerprint,
      commandPayload: options.commandPayload,
      expectedStateRevision: options.expectedStateRevision,
      nextState: state,
      stateSchemaVersion: options.stateSchemaVersion,
      result,
      eventId: event.eventId,
      eventType: event.type ?? event.eventType ?? commandType,
      eventPayload: event.payload ?? result,
      actorSessionId: options.actorSessionId ?? event.actorSessionId,
      occurredAt: event.occurredAt,
    });
  }

  executeCommandTransaction(input = {}) {
    return this.#enqueue(async () => {
      this.#assertReady();
      const workspaceId = boundedId(input.workspaceId ?? DEFAULT_WORKSPACE_ID, "workspaceId");
      const commandId = boundedId(input.commandId, "commandId");
      const commandType = boundedId(input.commandType, "commandType");
      const providedFingerprint = input.requestFingerprint !== undefined;
      const normalizedRequestFingerprint = requestFingerprint(input.requestFingerprint, {
        commandType,
        expectedStateRevision: input.expectedStateRevision,
        payload: input.commandPayload ?? input.eventPayload ?? {},
      });
      const existingResult = queryOne(
        this.#database,
        `SELECT command_type, request_fingerprint, state_revision, result_json, event_sequence
           FROM command_results
          WHERE workspace_id = ? AND command_id = ?`,
        [workspaceId, commandId],
      );
      if (existingResult) {
        if (String(existingResult.command_type) !== commandType) {
          throw repositoryError(
            "command_id_reused",
            `Command ${commandId} was already used for ${existingResult.command_type}.`,
          );
        }
        const storedFingerprint = existingResult.request_fingerprint === null
          ? null
          : String(existingResult.request_fingerprint);
        if (
          (storedFingerprint !== null && storedFingerprint !== normalizedRequestFingerprint) ||
          (storedFingerprint === null && providedFingerprint)
        ) {
          throw repositoryError(
            "command_id_reused",
            `Command ${commandId} was already used with different arguments.`,
          );
        }
        return {
          status: "replayed",
          commandId,
          commandType,
          stateRevision: Number(existingResult.state_revision),
          result: decodeJson(String(existingResult.result_json), "command_results.result_json"),
          eventSequence: Number(existingResult.event_sequence),
        };
      }

      const current = queryOne(
        this.#database,
        "SELECT state_revision FROM runtime_state WHERE workspace_id = ?",
        [workspaceId],
      );
      if (!current) {
        throw repositoryError(
          "runtime_state_missing",
          `Workspace ${workspaceId} must be initialized before a command is executed.`,
        );
      }
      const currentRevision = Number(current.state_revision);
      const expectedStateRevision = input.expectedStateRevision === undefined
        ? currentRevision
        : nonNegativeInteger(input.expectedStateRevision, "expectedStateRevision");
      if (currentRevision !== expectedStateRevision) {
        throw new OperationsRepositoryConflictError(
          `Workspace ${workspaceId} is at revision ${currentRevision}, not ${expectedStateRevision}.`,
          {
            workspaceId,
            expectedStateRevision,
            currentStateRevision: currentRevision,
          },
        );
      }

      const stateRevision = currentRevision + 1;
      const stateSchemaVersion = positiveInteger(
        input.stateSchemaVersion ?? 1,
        "stateSchemaVersion",
      );
      const stateJson = encodeJson(input.nextState, "nextState");
      const resultJson = encodeJson(input.result, "result");
      const occurredAt = input.occurredAt === undefined
        ? this.#currentTime()
        : timestamp(input.occurredAt, "occurredAt");
      const event = this.#normalizeEvent({
        eventId: input.eventId,
        type: input.eventType ?? commandType,
        commandId,
        actorSessionId: input.actorSessionId,
        occurredAt,
        payload: input.eventPayload ?? { commandType, result: cloneJson(input.result, "result") },
      }, { workspaceId, stateRevision, occurredAt });
      let eventSequence;

      await this.#transaction(async () => {
        this.#database.run(
          `UPDATE runtime_state
              SET state_schema_version = ?, state_revision = ?, state_json = ?, updated_at = ?
            WHERE workspace_id = ? AND state_revision = ?`,
          [
            stateSchemaVersion,
            stateRevision,
            stateJson,
            occurredAt,
            workspaceId,
            expectedStateRevision,
          ],
        );
        if (this.#database.getRowsModified() !== 1) {
          throw new OperationsRepositoryConflictError(
            `Workspace ${workspaceId} changed while command ${commandId} was being recorded.`,
            { workspaceId, expectedStateRevision },
          );
        }
        eventSequence = this.#insertEvent(event);
        this.#database.run(
          `INSERT INTO command_results (
             workspace_id, command_id, command_type, request_fingerprint, state_revision,
             result_json, event_sequence, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            workspaceId,
            commandId,
            commandType,
            normalizedRequestFingerprint,
            stateRevision,
            resultJson,
            eventSequence,
            occurredAt,
          ],
        );
      });

      return {
        status: "committed",
        commandId,
        commandType,
        stateRevision,
        result: decodeJson(resultJson, "result"),
        eventSequence,
      };
    });
  }

  listEvents(options = {}) {
    return this.#enqueue(async () => {
      this.#assertReady();
      const workspaceId = boundedId(options.workspaceId ?? DEFAULT_WORKSPACE_ID, "workspaceId");
      const afterSequence = nonNegativeInteger(options.afterSequence ?? 0, "afterSequence");
      const limit = positiveInteger(options.limit ?? 100, "limit", MAX_EVENT_LIMIT);
      return queryAll(
        this.#database,
        `SELECT sequence, event_id, workspace_id, event_type, command_id,
                actor_session_id, state_revision, occurred_at, payload_json
           FROM operation_events
          WHERE workspace_id = ? AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?`,
        [workspaceId, afterSequence, limit],
      ).map(eventRecord);
    });
  }

  close() {
    return this.#enqueue(async () => {
      if (this.#closed) return;
      this.#database?.close();
      this.#database = null;
      this.#SQL = null;
      this.#initialized = false;
      this.#closed = true;
      await this.#releaseFileLock();
    });
  }

  async #releaseFileLock() {
    const lock = this.#fileLock;
    this.#fileLock = null;
    if (lock) await lock.release();
  }

  #enqueue(operation) {
    const pending = this.#queue.then(operation, operation);
    this.#queue = pending.catch(() => {});
    return pending;
  }

  #assertOpen() {
    if (this.#closed) throw new OperationsRepositoryClosedError();
  }

  #assertReady() {
    this.#assertOpen();
    if (!this.#initialized || !this.#database) {
      throw repositoryError("repository_not_initialized", "Call init() before using the repository.");
    }
  }

  #currentTime() {
    return timestamp(this.#now(), "now()");
  }

  #applyMigrations() {
    const rawVersion = queryOne(this.#database, "PRAGMA user_version")?.user_version ?? 0;
    const currentVersion = Number(rawVersion);
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
      throw repositoryError("invalid_schema", "The SQLite user_version is invalid.");
    }
    if (currentVersion > OPERATIONS_REPOSITORY_SCHEMA_VERSION) {
      throw repositoryError(
        "unsupported_schema",
        `Database schema ${currentVersion} is newer than supported schema ${OPERATIONS_REPOSITORY_SCHEMA_VERSION}.`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      this.#database.run("BEGIN IMMEDIATE;");
      try {
        this.#database.run(migration.sql);
        this.#database.run(
          "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          [migration.version, this.#currentTime()],
        );
        this.#database.run(`PRAGMA user_version = ${migration.version};`);
        this.#database.run("COMMIT;");
      } catch (error) {
        try {
          this.#database.run("ROLLBACK;");
        } catch {
          // Preserve the original migration error.
        }
        throw repositoryError(
          "migration_failed",
          `Operations database migration ${migration.version} failed.`,
          error,
        );
      }
    }
  }

  #normalizeEvent(rawEvent, defaults) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
      throw repositoryError("invalid_event", "event must be an object.");
    }
    return {
      eventId: boundedId(rawEvent.eventId ?? randomUUID(), "event.eventId"),
      workspaceId: defaults.workspaceId,
      eventType: boundedId(rawEvent.type ?? rawEvent.eventType, "event.type"),
      commandId: boundedId(rawEvent.commandId, "event.commandId", { nullable: true }),
      actorSessionId: boundedId(
        rawEvent.actorSessionId ?? rawEvent.actor,
        "event.actorSessionId",
        { nullable: true },
      ),
      stateRevision: defaults.stateRevision,
      occurredAt: rawEvent.occurredAt === undefined
        ? defaults.occurredAt
        : timestamp(rawEvent.occurredAt, "event.occurredAt"),
      payloadJson: encodeJson(rawEvent.payload ?? {}, "event.payload"),
    };
  }

  #insertEvent(event) {
    this.#database.run(
      `INSERT INTO operation_events (
         event_id, workspace_id, event_type, command_id, actor_session_id,
         state_revision, occurred_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventId,
        event.workspaceId,
        event.eventType,
        event.commandId,
        event.actorSessionId,
        event.stateRevision,
        event.occurredAt,
        event.payloadJson,
      ],
    );
    return Number(queryOne(this.#database, "SELECT last_insert_rowid() AS sequence").sequence);
  }

  async #transaction(mutation) {
    const before = this.#database.export();
    let committed = false;
    this.#database.run("BEGIN IMMEDIATE;");
    try {
      await mutation();
      this.#database.run("COMMIT;");
      committed = true;
      await this.#persist();
    } catch (error) {
      if (!committed) {
        try {
          this.#database.run("ROLLBACK;");
        } catch {
          // Preserve the original mutation error.
        }
      } else {
        this.#restore(before);
      }
      throw error;
    }
  }

  #restore(bytes) {
    this.#database?.close();
    this.#database = new this.#SQL.Database(bytes);
    this.#database.run("PRAGMA foreign_keys = ON;");
  }

  async #persist() {
    try {
      await atomicWriteFile(this.#databasePath, this.#database.export());
    } catch (error) {
      throw repositoryError(
        "database_write_failed",
        `Cannot persist operations database ${this.#databasePath}.`,
        error,
      );
    }
  }
}

export async function createOperationsRepository(options) {
  const repository = new OperationsRepository(options);
  await repository.init();
  return repository;
}
