import { describe, expect, it, vi } from "vitest";
import { createNativeSimulationSnapshot } from "../rail/nativeSimulation";
import { createOperationalResponseState } from "../operations/operationalResponse";
import { createSimulationState } from "../rail/simulation";
import { createSampleSchedulePlan } from "../schedules/sample";
import { ScheduleWorkspaceStore } from "../schedules/store";
import {
  OperationsClientError,
  OperationsConflictError,
  createOperationsClient,
  type OperationsEventSource,
  type OperationsFetch,
} from "./operationsClient";
import {
  OPERATIONS_SNAPSHOT_SCHEMA,
  type OperationsCommandRequest,
  type OperationsServerSnapshot,
} from "./types";

function serverSnapshot(
  stateRevision: number,
  runId = "run-operator-01",
  streamRevision = stateRevision,
): OperationsServerSnapshot {
  return {
    schema: OPERATIONS_SNAPSHOT_SCHEMA,
    runId,
    stateRevision,
    streamRevision,
    native: createNativeSimulationSnapshot({ speed: 0 }),
    detailed: createSimulationState(),
    operationalResponse: createOperationalResponseState(1_788_000_000_000),
    procedureExecutions: [],
    shift: {
      shiftId: "shift-test",
      startedAt: 1_788_000_000_000,
      startedOperationalTime: 1_788_000_000_000,
      nextLogSequence: 1,
      logs: [],
      report: {
        reportId: "report-test",
        status: "draft",
        title: "End-of-shift report",
        contentHtml: "<p>Draft</p>",
        createdAt: 1_788_000_000_000,
        updatedAt: 1_788_000_000_000,
        frozenAt: null,
        generatedAt: null,
        sourceLogSequence: 0,
      },
    },
    schedules: (() => {
      const store = new ScheduleWorkspaceStore();
      store.loadPlan(createSampleSchedulePlan());
      return store.getSnapshot();
    })(),
    updatedAt: new Date(1_788_000_000_000 + stateRevision).toISOString(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class FakeEventSource implements OperationsEventSource {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn();
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitOpen(): void {
    this.onopen?.({} as Event);
  }

  emitError(): void {
    this.onerror?.({} as Event);
  }

  emitSnapshot(snapshot: OperationsServerSnapshot, customEvent = false): void {
    const event = {
      data: JSON.stringify(customEvent ? { type: "snapshot", snapshot } : snapshot),
    } as MessageEvent<string>;
    if (!customEvent) {
      this.onmessage?.(event);
      return;
    }
    this.listeners.get("snapshot")?.forEach((listener) => {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    });
  }
}

describe("OperationsClientStore", () => {
  it("bootstraps once, subscribes to SSE, and accepts only newer snapshots from the same run", async () => {
    const initial = serverSnapshot(7);
    const fetchImpl = vi.fn<OperationsFetch>(async () => jsonResponse(initial));
    const sources: FakeEventSource[] = [];
    const createEventSource = vi.fn((url: string) => {
      expect(url).toBe("/api/operations/events");
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    });
    const client = createOperationsClient({ fetch: fetchImpl, createEventSource });
    const listener = vi.fn();
    client.subscribe(listener);

    expect(client.getSnapshot()).toMatchObject({
      status: "loading",
      serverSnapshot: null,
      streamStatus: "idle",
    });

    const [left, right] = await Promise.all([client.bootstrap(), client.start()]);

    expect(left).toStrictEqual(initial);
    expect(right).toStrictEqual(initial);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/operations/snapshot", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
    expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      serverSnapshot: initial,
      streamStatus: "connecting",
    });
    expect(sources).toHaveLength(1);

    sources[0].emitOpen();
    expect(client.getSnapshot().streamStatus).toBe("open");

    const telemetryUpdate = {
      ...initial,
      streamRevision: initial.streamRevision + 1,
      native: {
        ...initial.native,
        telemetryRevision: initial.native.telemetryRevision + 1,
        timestamp: initial.native.timestamp + 5_000,
      },
    };
    sources[0].emitSnapshot(telemetryUpdate);
    expect(client.getServerSnapshot()).toStrictEqual(telemetryUpdate);

    const outOfOrderStream = {
      ...telemetryUpdate,
      streamRevision: initial.streamRevision,
      native: {
        ...telemetryUpdate.native,
        telemetryRevision: telemetryUpdate.native.telemetryRevision + 1,
      },
    };
    sources[0].emitSnapshot(outOfOrderStream);
    expect(client.getServerSnapshot()).toStrictEqual(telemetryUpdate);

    sources[0].emitSnapshot(serverSnapshot(6));
    sources[0].emitSnapshot(serverSnapshot(8, "another-run"));
    expect(client.getServerSnapshot()?.stateRevision).toBe(7);

    const revisionEight = serverSnapshot(8);
    sources[0].emitSnapshot(revisionEight, true);
    expect(client.getServerSnapshot()).toStrictEqual(revisionEight);
    expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      streamStatus: "open",
    });
    expect(listener).toHaveBeenCalled();

    sources[0].emitError();
    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      serverSnapshot: revisionEight,
      streamStatus: "reconnecting",
    });

    const revisionNine = serverSnapshot(9);
    sources[0].emitSnapshot(revisionNine);
    expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      serverSnapshot: revisionNine,
      streamStatus: "open",
    });

    client.close();
    expect(sources[0].close).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().streamStatus).toBe("closed");
  });

  it("publishes a typed error when bootstrap returns an invalid envelope", async () => {
    const client = createOperationsClient({
      fetch: async () => jsonResponse({ runId: "missing-domain-state" }),
      createEventSource: () => new FakeEventSource(),
    });

    await expect(client.bootstrap()).rejects.toMatchObject({
      code: "invalid_snapshot",
    });
    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      serverSnapshot: null,
      error: { code: "invalid_snapshot" },
    });
  });

  it("posts an exact revision-bound command and deduplicates it in flight and after completion", async () => {
    const initial = serverSnapshot(3);
    const after = serverSnapshot(4);
    let completePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      completePost = resolve;
    });
    const fetchImpl = vi.fn<OperationsFetch>(async (_input, init) => {
      if (init?.method === "POST") return postResponse;
      return jsonResponse(initial);
    });
    const client = createOperationsClient({
      fetch: fetchImpl,
      createEventSource: () => new FakeEventSource(),
    });
    await client.bootstrap();
    const request: OperationsCommandRequest<{ speed: number }> = {
      commandId: "cmd-speed-0001",
      type: "set_speed",
      expectedStateRevision: 3,
      payload: { speed: 2 },
    };

    const first = client.executeCommand<{ speed: number }, { speed: number }>(request);
    const duplicate = client.executeCommand<{ speed: number }, { speed: number }>(request);
    expect(first).toBe(duplicate);
    completePost(jsonResponse({
      status: "applied",
      commandId: request.commandId,
      stateRevision: 4,
      receipt: { speed: 2 },
      snapshot: after,
    }));
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    expect(firstResult).toBe(duplicateResult);
    expect(firstResult).toMatchObject({
      status: "applied",
      commandId: "cmd-speed-0001",
      stateRevision: 4,
      receipt: { speed: 2 },
    });
    expect(client.getServerSnapshot()).toStrictEqual(after);
    const postCalls = fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toEqual([
      "/api/operations/commands",
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: undefined,
      },
    ]);

    const cached = await client.executeCommand(request);
    expect(cached).toBe(firstResult);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(() => client.executeCommand({
      ...request,
      payload: { speed: 4 },
    })).toThrowError(OperationsClientError);
  });

  it("refreshes after a 409 and exposes the current revision in a conflict error", async () => {
    const initial = serverSnapshot(11);
    const current = serverSnapshot(12);
    let snapshotReads = 0;
    const fetchImpl = vi.fn<OperationsFetch>(async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse({
          error: "state_revision_conflict",
          message: "The operational state changed.",
          currentStateRevision: 12,
        }, 409);
      }
      snapshotReads += 1;
      return jsonResponse(snapshotReads === 1 ? initial : current);
    });
    const client = createOperationsClient({
      fetch: fetchImpl,
      createEventSource: () => new FakeEventSource(),
    });
    await client.bootstrap();

    const failure = await client.command(
      "create_native_incident",
      { targetId: "interstation-RER_A-01" },
      { commandId: "cmd-incident-stale", expectedStateRevision: 11 },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OperationsConflictError);
    expect(failure).toMatchObject({
      code: "state_revision_conflict",
      status: 409,
      commandId: "cmd-incident-stale",
      expectedStateRevision: 11,
      currentStateRevision: 12,
    });
    expect(snapshotReads).toBe(2);
    expect(client.getServerSnapshot()).toStrictEqual(current);
  });

  it("allows retry with the exact commandId when the first response is lost", async () => {
    const initial = serverSnapshot(20);
    let postAttempts = 0;
    const fetchImpl = vi.fn<OperationsFetch>(async (_input, init) => {
      if (init?.method !== "POST") return jsonResponse(initial);
      postAttempts += 1;
      if (postAttempts === 1) throw new TypeError("connection reset");
      return jsonResponse({
        status: "applied",
        commandId: "cmd-retry-0001",
        stateRevision: 20,
        idempotent: true,
        receipt: { receiptId: "receipt-stored-server-side" },
      });
    });
    const client = createOperationsClient({
      fetch: fetchImpl,
      createEventSource: () => new FakeEventSource(),
    });
    await client.bootstrap();
    const options = {
      commandId: "cmd-retry-0001",
      expectedStateRevision: 20,
    };

    const firstFailure = await client.command(
      "reset_all",
      {},
      options,
    ).catch((error: unknown) => error);
    expect(firstFailure).toMatchObject({
      code: "command_unavailable",
      commandId: "cmd-retry-0001",
    });

    const retried = await client.command("reset_all", {}, options);
    expect(retried).toMatchObject({
      status: "applied",
      commandId: "cmd-retry-0001",
      idempotent: true,
      receipt: { receiptId: "receipt-stored-server-side" },
    });
    const commandBodies = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => init?.body);
    expect(commandBodies).toEqual([
      JSON.stringify({
        commandId: "cmd-retry-0001",
        type: "reset_all",
        expectedStateRevision: 20,
        payload: {},
      }),
      JSON.stringify({
        commandId: "cmd-retry-0001",
        type: "reset_all",
        expectedStateRevision: 20,
        payload: {},
      }),
    ]);
  });
});
