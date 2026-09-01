import {
  OPERATIONS_SNAPSHOT_SCHEMA,
  type OperationsClientFailure,
  type OperationsClientSnapshot,
  type OperationsCommandOptions,
  type OperationsCommandRequest,
  type OperationsCommandResult,
  type OperationsConflictBody,
  type OperationsServerSnapshot,
  type OperationsSnapshotEvent,
} from "./types";

const DEFAULT_SNAPSHOT_URL = "/api/operations/snapshot";
const DEFAULT_EVENTS_URL = "/api/operations/events";
const DEFAULT_COMMANDS_URL = "/api/operations/commands";
const COMPLETED_COMMAND_CACHE_LIMIT = 128;

export type OperationsFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OperationsEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  close(): void;
}

export interface OperationsClientDependencies {
  fetch?: OperationsFetch;
  createEventSource?: (url: string) => OperationsEventSource;
  createCommandId?: () => string;
  snapshotUrl?: string;
  eventsUrl?: string;
  commandsUrl?: string;
}

interface CachedCommand {
  fingerprint: string;
  result: OperationsCommandResult<unknown>;
}

interface InFlightCommand {
  fingerprint: string;
  promise: Promise<OperationsCommandResult<unknown>>;
}

type Listener = () => void;

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function defaultEventSource(url: string): OperationsEventSource {
  return new EventSource(url);
}

function defaultCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isOperationsServerSnapshot(
  value: unknown,
): value is OperationsServerSnapshot {
  const candidate = record(value);
  if (!candidate) return false;
  return candidate.schema === OPERATIONS_SNAPSHOT_SCHEMA &&
    typeof candidate.runId === "string" && candidate.runId.length > 0 &&
    isNonNegativeInteger(candidate.stateRevision) &&
    isNonNegativeInteger(candidate.streamRevision) &&
    candidate.streamRevision >= candidate.stateRevision &&
    record(candidate.native) !== null &&
    record(candidate.detailed) !== null &&
    record(candidate.schedules) !== null &&
    record(candidate.operationalResponse) !== null &&
    record(candidate.shift) !== null &&
    Array.isArray(candidate.procedureExecutions);
}

function normalizeSnapshot(value: unknown): OperationsServerSnapshot | null {
  const candidate = record(value);
  if (!candidate) return null;
  const normalized = candidate.streamRevision === undefined &&
      isNonNegativeInteger(candidate.stateRevision)
    ? { ...candidate, streamRevision: candidate.stateRevision }
    : candidate;
  return isOperationsServerSnapshot(normalized) ? normalized : null;
}

function snapshotFromPayload(value: unknown): OperationsServerSnapshot | null {
  const direct = normalizeSnapshot(value);
  if (direct) return direct;
  const candidate = record(value);
  return candidate ? normalizeSnapshot(candidate.snapshot) : null;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(body: unknown, fallback: string): string {
  const candidate = record(body);
  return candidate && typeof candidate.message === "string" && candidate.message.trim()
    ? candidate.message.trim()
    : fallback;
}

function errorCode(body: unknown, fallback: string): string {
  const candidate = record(body);
  const value = candidate?.code ?? candidate?.error;
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function commandFingerprint(request: OperationsCommandRequest): string {
  return JSON.stringify({
    type: request.type,
    expectedStateRevision: request.expectedStateRevision,
    payload: request.payload,
  });
}

function assertCommandId(commandId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(commandId)) {
    throw new OperationsClientError(
      "invalid_command_id",
      "commandId must be a bounded identifier.",
      { commandId },
    );
  }
}

export class OperationsClientError extends Error implements OperationsClientFailure {
  readonly code: string;
  readonly status?: number;
  readonly commandId?: string;

  constructor(
    code: string,
    message: string,
    options: { status?: number; commandId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OperationsClientError";
    this.code = code;
    this.status = options.status;
    this.commandId = options.commandId;
  }
}

export class OperationsConflictError extends OperationsClientError {
  readonly expectedStateRevision: number;
  readonly currentStateRevision: number | null;

  constructor(options: {
    code: string;
    message: string;
    commandId: string;
    expectedStateRevision: number;
    currentStateRevision: number | null;
  }) {
    super(options.code, options.message, {
      status: 409,
      commandId: options.commandId,
    });
    this.name = "OperationsConflictError";
    this.expectedStateRevision = options.expectedStateRevision;
    this.currentStateRevision = options.currentStateRevision;
  }
}

export class OperationsClientStore {
  private readonly fetchImpl: OperationsFetch;
  private readonly eventSourceFactory: (url: string) => OperationsEventSource;
  private readonly commandIdFactory: () => string;
  private readonly snapshotUrl: string;
  private readonly eventsUrl: string;
  private readonly commandsUrl: string;
  private readonly listeners = new Set<Listener>();
  private readonly inFlightCommands = new Map<string, InFlightCommand>();
  private readonly completedCommands = new Map<string, CachedCommand>();
  private state: OperationsClientSnapshot = {
    status: "loading",
    serverSnapshot: null,
    error: null,
    streamStatus: "idle",
  };
  private eventSource: OperationsEventSource | null = null;
  private bootstrapPromise: Promise<OperationsServerSnapshot> | null = null;
  private bootstrapController: AbortController | null = null;
  private closed = false;
  private readonly snapshotEventListener = (event: Event): void => {
    this.handleEventMessage(event as MessageEvent<string>);
  };

  constructor(dependencies: OperationsClientDependencies = {}) {
    this.fetchImpl = dependencies.fetch ?? defaultFetch;
    this.eventSourceFactory = dependencies.createEventSource ?? defaultEventSource;
    this.commandIdFactory = dependencies.createCommandId ?? defaultCommandId;
    this.snapshotUrl = dependencies.snapshotUrl ?? DEFAULT_SNAPSHOT_URL;
    this.eventsUrl = dependencies.eventsUrl ?? DEFAULT_EVENTS_URL;
    this.commandsUrl = dependencies.commandsUrl ?? DEFAULT_COMMANDS_URL;
  }

  getSnapshot = (): OperationsClientSnapshot => this.state;

  getServerSnapshot = (): OperationsServerSnapshot | null =>
    this.state.serverSnapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: OperationsClientSnapshot): void {
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  private ready(
    snapshot: OperationsServerSnapshot,
    streamStatus: OperationsClientSnapshot["streamStatus"] = "connecting",
  ): void {
    this.publish({
      status: "ready",
      serverSnapshot: snapshot,
      error: null,
      streamStatus,
    });
  }

  private failure(
    error: OperationsClientFailure,
    streamStatus: "idle" | "reconnecting" | "closed",
  ): void {
    this.publish({
      status: "error",
      serverSnapshot: this.state.serverSnapshot,
      error,
      streamStatus,
    });
  }

  private acceptSnapshot(snapshot: OperationsServerSnapshot): boolean {
    const current = this.state.serverSnapshot;
    if (current && snapshot.runId !== current.runId) return false;
    if (current && snapshot.stateRevision < current.stateRevision) return false;
    if (current && snapshot.streamRevision < current.streamRevision) return false;
    if (
      current &&
      snapshot.stateRevision === current.stateRevision &&
      snapshot.streamRevision === current.streamRevision
    ) {
      const nativeTelemetryAdvanced =
        snapshot.native.telemetryRevision > current.native.telemetryRevision;
      const detailedTelemetryAdvanced =
        snapshot.detailed.snapshot.revision > current.detailed.snapshot.revision ||
        snapshot.detailed.snapshot.timestamp > current.detailed.snapshot.timestamp;
      if (
        !nativeTelemetryAdvanced &&
        !detailedTelemetryAdvanced &&
        this.state.status !== "error"
      ) {
        return false;
      }
    }
    this.ready(snapshot, this.eventSource ? "open" : "connecting");
    return true;
  }

  private installSnapshot(snapshot: OperationsServerSnapshot): void {
    const current = this.state.serverSnapshot;
    if (
      current &&
      snapshot.runId === current.runId &&
      (snapshot.stateRevision < current.stateRevision ||
        snapshot.streamRevision < current.streamRevision)
    ) {
      return;
    }
    this.ready(snapshot, this.eventSource ? "open" : "connecting");
  }

  private async fetchSnapshot(signal?: AbortSignal): Promise<OperationsServerSnapshot> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.snapshotUrl, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
    } catch (cause) {
      throw new OperationsClientError(
        "snapshot_unavailable",
        "The operational state could not be loaded.",
        { cause },
      );
    }
    const body = await responseBody(response);
    if (!response.ok) {
      throw new OperationsClientError(
        errorCode(body, "snapshot_rejected"),
        errorMessage(body, "The server rejected the operational snapshot request."),
        { status: response.status },
      );
    }
    const snapshot = snapshotFromPayload(body);
    if (!snapshot) {
      throw new OperationsClientError(
        "invalid_snapshot",
        "The server returned an invalid operational snapshot.",
        { status: response.status },
      );
    }
    return snapshot;
  }

  async bootstrap(): Promise<OperationsServerSnapshot> {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    if (this.state.serverSnapshot && !this.closed) {
      this.openEventStream();
      return this.state.serverSnapshot;
    }
    this.closed = false;
    const controller = new AbortController();
    this.bootstrapController = controller;
    if (!this.state.serverSnapshot) {
      this.publish({
        status: "loading",
        serverSnapshot: null,
        error: null,
        streamStatus: "idle",
      });
    }
    const operation = this.fetchSnapshot(controller.signal)
      .then((snapshot) => {
        if (controller.signal.aborted) {
          throw new OperationsClientError(
            "snapshot_aborted",
            "The operational state request was cancelled.",
          );
        }
        this.installSnapshot(snapshot);
        this.openEventStream();
        return snapshot;
      })
      .catch((caught: unknown) => {
        const error = caught instanceof OperationsClientError
          ? caught
          : new OperationsClientError(
              "snapshot_unavailable",
              "The operational state could not be loaded.",
              { cause: caught },
            );
        if (!controller.signal.aborted || error.code !== "snapshot_aborted") {
          this.failure(error, this.closed ? "closed" : "idle");
        }
        throw error;
      })
      .finally(() => {
        if (this.bootstrapController === controller) this.bootstrapController = null;
        if (this.bootstrapPromise === operation) this.bootstrapPromise = null;
      });
    this.bootstrapPromise = operation;
    return operation;
  }

  start(): Promise<OperationsServerSnapshot> {
    return this.bootstrap();
  }

  async refresh(): Promise<OperationsServerSnapshot> {
    const snapshot = await this.fetchSnapshot();
    this.installSnapshot(snapshot);
    if (!this.eventSource && !this.closed) this.openEventStream();
    return snapshot;
  }

  private openEventStream(): void {
    if (this.closed || this.eventSource) return;
    const snapshot = this.state.serverSnapshot;
    if (!snapshot) return;
    this.ready(snapshot, "connecting");
    let source: OperationsEventSource;
    try {
      source = this.eventSourceFactory(this.eventsUrl);
    } catch (cause) {
      this.failure(new OperationsClientError(
        "event_stream_unavailable",
        "The operational event stream could not be opened.",
        { cause },
      ), "reconnecting");
      return;
    }
    this.eventSource = source;
    source.onopen = () => {
      const current = this.state.serverSnapshot;
      if (current) this.ready(current, "open");
    };
    source.onmessage = (event) => this.handleEventMessage(event);
    source.onerror = () => {
      this.failure(new OperationsClientError(
        "event_stream_interrupted",
        "Live operational updates were interrupted; the browser is reconnecting.",
      ), "reconnecting");
    };
    source.addEventListener?.("snapshot", this.snapshotEventListener);
  }

  private handleEventMessage(event: MessageEvent<string>): void {
    let body: unknown;
    try {
      body = JSON.parse(event.data) as unknown;
    } catch {
      return;
    }
    const snapshot = snapshotFromPayload(body);
    if (snapshot) this.acceptSnapshot(snapshot);
  }

  private cacheCompletedCommand(
    commandId: string,
    fingerprint: string,
    result: OperationsCommandResult<unknown>,
  ): void {
    this.completedCommands.delete(commandId);
    this.completedCommands.set(commandId, { fingerprint, result });
    while (this.completedCommands.size > COMPLETED_COMMAND_CACHE_LIMIT) {
      const oldest = this.completedCommands.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completedCommands.delete(oldest);
    }
  }

  private assertCommandReuse(
    commandId: string,
    fingerprint: string,
    existingFingerprint: string,
  ): void {
    if (fingerprint === existingFingerprint) return;
    throw new OperationsClientError(
      "command_id_reused",
      "The same commandId cannot be reused for different arguments.",
      { commandId },
    );
  }

  async command<
    TPayload extends Record<string, unknown>,
    TReceipt = unknown,
  >(
    type: string,
    payload: TPayload,
    options: OperationsCommandOptions = {},
  ): Promise<OperationsCommandResult<TReceipt>> {
    if (!type.trim() || type.length > 96) {
      throw new OperationsClientError(
        "invalid_command_type",
        "Command type must be a short non-empty string.",
      );
    }
    const current = this.state.serverSnapshot ?? await this.bootstrap();
    const commandId = options.commandId ?? this.commandIdFactory();
    assertCommandId(commandId);
    const request: OperationsCommandRequest<TPayload> = {
      commandId,
      type: type.trim(),
      expectedStateRevision:
        options.expectedStateRevision ?? current.stateRevision,
      payload,
    };
    return this.executeCommand<TPayload, TReceipt>(request, options.signal);
  }

  executeCommand<
    TPayload extends Record<string, unknown>,
    TReceipt = unknown,
  >(
    request: OperationsCommandRequest<TPayload>,
    signal?: AbortSignal,
  ): Promise<OperationsCommandResult<TReceipt>> {
    assertCommandId(request.commandId);
    if (!request.type.trim() || request.type.length > 96) {
      return Promise.reject(new OperationsClientError(
        "invalid_command_type",
        "Command type must be a short non-empty string.",
        { commandId: request.commandId },
      ));
    }
    if (!isNonNegativeInteger(request.expectedStateRevision)) {
      return Promise.reject(new OperationsClientError(
        "invalid_state_revision",
        "expectedStateRevision must be a non-negative integer.",
        { commandId: request.commandId },
      ));
    }
    const normalized: OperationsCommandRequest<TPayload> = {
      ...request,
      type: request.type.trim(),
    };
    const fingerprint = commandFingerprint(normalized);
    const completed = this.completedCommands.get(normalized.commandId);
    if (completed) {
      this.assertCommandReuse(normalized.commandId, fingerprint, completed.fingerprint);
      return Promise.resolve(completed.result as OperationsCommandResult<TReceipt>);
    }
    const running = this.inFlightCommands.get(normalized.commandId);
    if (running) {
      this.assertCommandReuse(normalized.commandId, fingerprint, running.fingerprint);
      return running.promise as Promise<OperationsCommandResult<TReceipt>>;
    }
    const operation = this.postCommand<TPayload, TReceipt>(normalized, signal)
      .then((result) => {
        this.cacheCompletedCommand(
          normalized.commandId,
          fingerprint,
          result as OperationsCommandResult<unknown>,
        );
        return result;
      })
      .finally(() => {
        const active = this.inFlightCommands.get(normalized.commandId);
        if (active?.promise === operation) {
          this.inFlightCommands.delete(normalized.commandId);
        }
      });
    this.inFlightCommands.set(normalized.commandId, {
      fingerprint,
      promise: operation as Promise<OperationsCommandResult<unknown>>,
    });
    return operation;
  }

  private async postCommand<
    TPayload extends Record<string, unknown>,
    TReceipt,
  >(
    request: OperationsCommandRequest<TPayload>,
    signal?: AbortSignal,
  ): Promise<OperationsCommandResult<TReceipt>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.commandsUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch (cause) {
      throw new OperationsClientError(
        "command_unavailable",
        "The command result was not received. Retry with the same commandId.",
        { commandId: request.commandId, cause },
      );
    }
    const body = await responseBody(response);
    if (response.status === 409) {
      const conflict = (record(body) ?? {}) as OperationsConflictBody;
      const conflictSnapshot = snapshotFromPayload(conflict.snapshot);
      if (conflictSnapshot) {
        this.installSnapshot(conflictSnapshot);
      } else {
        try {
          await this.refresh();
        } catch {
          // The conflict remains authoritative even when re-synchronization fails.
        }
      }
      throw new OperationsConflictError({
        code: errorCode(body, "state_revision_conflict"),
        message: errorMessage(
          body,
          "The operational state changed. Review the refreshed state before retrying.",
        ),
        commandId: request.commandId,
        expectedStateRevision: request.expectedStateRevision,
        currentStateRevision: isNonNegativeInteger(conflict.currentStateRevision)
          ? conflict.currentStateRevision
          : this.state.serverSnapshot?.stateRevision ?? null,
      });
    }
    if (!response.ok) {
      throw new OperationsClientError(
        errorCode(body, "command_rejected"),
        errorMessage(body, "The server rejected the operational command."),
        { status: response.status, commandId: request.commandId },
      );
    }
    const result = record(body);
    if (
      !result ||
      typeof result.status !== "string" ||
      typeof result.commandId !== "string" ||
      result.commandId !== request.commandId ||
      !isNonNegativeInteger(result.stateRevision)
    ) {
      throw new OperationsClientError(
        "invalid_command_result",
        "The server returned an invalid command result.",
        { status: response.status, commandId: request.commandId },
      );
    }
    const embeddedSnapshot = snapshotFromPayload(result.snapshot);
    if (embeddedSnapshot) {
      this.installSnapshot(embeddedSnapshot);
    } else if (
      !this.state.serverSnapshot ||
      result.stateRevision > this.state.serverSnapshot.stateRevision
    ) {
      try {
        await this.refresh();
      } catch {
        // SSE can still deliver the new revision; the command receipt remains valid.
      }
    }
    return body as OperationsCommandResult<TReceipt>;
  }

  close(): void {
    this.closed = true;
    this.bootstrapController?.abort();
    this.bootstrapController = null;
    if (this.eventSource) {
      this.eventSource.removeEventListener?.("snapshot", this.snapshotEventListener);
      this.eventSource.close();
      this.eventSource = null;
    }
    const current = this.state.serverSnapshot;
    if (current) this.ready(current, "closed");
    else if (this.state.status === "error") {
      this.failure(this.state.error, "closed");
    }
  }
}

export function createOperationsClient(
  dependencies: OperationsClientDependencies = {},
): OperationsClientStore {
  return new OperationsClientStore(dependencies);
}

export const operationsClient = createOperationsClient();

export type {
  OperationsClientSnapshot,
  OperationsCommandOptions,
  OperationsCommandRequest,
  OperationsCommandResult,
  OperationsServerSnapshot,
  OperationsSnapshotEvent,
};
