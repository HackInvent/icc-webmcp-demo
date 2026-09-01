import { describe, expect, it } from "vitest";
import type { RailSnapshot } from "../rail/domain";
import { createOperationalResponseState } from "../operations/operationalResponse";
import { createNativeNetworkController } from "../rail/nativeSimulation";
import { createSimulationState } from "../rail/simulation";
import type { OperationsClientStore } from "../runtime/operationsClient";
import {
  OPERATIONS_SNAPSHOT_SCHEMA,
  type OperationsCommandResult,
  type OperationsServerSnapshot,
} from "../runtime/types";
import { createSampleSchedulePlan } from "./sample";
import { ScheduleWorkspaceStore } from "./store";
import type { ScheduleChangeRequest, SchedulePreview } from "./types";
import { RuntimeScheduleWorkspace } from "./workspace";

function runtimeSnapshot(
  schedules: ReturnType<ScheduleWorkspaceStore["getSnapshot"]>,
  stateRevision = 1,
): OperationsServerSnapshot {
  return {
    schema: OPERATIONS_SNAPSHOT_SCHEMA,
    runId: "run-schedule-test",
    stateRevision,
    streamRevision: stateRevision,
    native: createNativeNetworkController().getSnapshot(),
    detailed: createSimulationState(),
    operationalResponse: createOperationalResponseState(1_788_000_000_000),
    schedules,
    procedureExecutions: [],
    shift: {
      shiftId: "shift-schedule-test",
      startedAt: 1_788_000_000_000,
      startedOperationalTime: 1_788_000_000_000,
      nextLogSequence: 1,
      logs: [],
      report: {
        reportId: "report-schedule-test",
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
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeOperationsPort {
  readonly calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: OperationsServerSnapshot | null;
  onCommand: (
    type: string,
    payload: Record<string, unknown>,
  ) => Promise<OperationsCommandResult<unknown>> = async () => {
    throw new Error("Unexpected command");
  };

  constructor(snapshot: OperationsServerSnapshot | null) {
    this.snapshot = snapshot;
  }

  getServerSnapshot = (): OperationsServerSnapshot | null => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  command = (async (
    type: string,
    payload: Record<string, unknown>,
  ): Promise<OperationsCommandResult<unknown>> => {
    this.calls.push({ type, payload });
    return this.onCommand(type, payload);
  }) as OperationsClientStore["command"];

  install(snapshot: OperationsServerSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

describe("RuntimeScheduleWorkspace", () => {
  it("reads the server schedule and leaves the local fallback untouched while a command is in flight", async () => {
    const serverStore = new ScheduleWorkspaceStore(createSampleSchedulePlan());
    const initialSnapshot = runtimeSnapshot(serverStore.getSnapshot());
    const port = new FakeOperationsPort(initialSnapshot);
    const localStore = new ScheduleWorkspaceStore({
      ...createSampleSchedulePlan(),
      name: "LOCAL FALLBACK ONLY",
    });
    const workspace = new RuntimeScheduleWorkspace(
      port as unknown as Pick<OperationsClientStore, "getServerSnapshot" | "subscribe" | "command">,
      localStore,
    );
    const pendingResponse = deferred<OperationsCommandResult<unknown>>();
    port.onCommand = () => pendingResponse.promise;
    const railSnapshot: RailSnapshot = initialSnapshot.detailed.snapshot;
    const request: ScheduleChangeRequest = {
      kind: "shift_service",
      serviceId: workspace.currentPlan().services[0].serviceId,
      deltaMinutes: 5,
    };

    const pendingPreview = Promise.resolve(
      workspace.preview(request, railSnapshot, "human"),
    );

    expect(port.calls).toEqual([{
      type: "schedule_preview",
      payload: { request, actor: "human" },
    }]);
    expect(workspace.currentPlan().name).not.toBe("LOCAL FALLBACK ONLY");
    expect(workspace.getSnapshot().pendingPreview).toBeNull();
    expect(localStore.getSnapshot().pendingPreview).toBeNull();

    // An unrelated server refresh remains authoritative and cannot hydrate an
    // optimistic browser draft, because the facade never created one.
    port.install({ ...initialSnapshot, stateRevision: 2 });
    expect(workspace.getSnapshot().pendingPreview).toBeNull();

    const preview = serverStore.preview(request, railSnapshot, "human");
    const appliedSnapshot = runtimeSnapshot(serverStore.getSnapshot(), 3);
    port.install(appliedSnapshot);
    pendingResponse.resolve({
      status: "applied",
      commandId: "cmd-schedule-preview",
      stateRevision: 3,
      result: { preview },
      snapshot: appliedSnapshot,
    });

    await expect(pendingPreview).resolves.toEqual(preview);
    expect(workspace.getSnapshot().pendingPreview?.id).toBe(preview.id);
    expect(localStore.getSnapshot().pendingPreview).toBeNull();
  });

  it("keeps the deterministic store as a no-server development fallback", async () => {
    const port = new FakeOperationsPort(null);
    const localStore = new ScheduleWorkspaceStore(createSampleSchedulePlan());
    const workspace = new RuntimeScheduleWorkspace(
      port as unknown as Pick<OperationsClientStore, "getServerSnapshot" | "subscribe" | "command">,
      localStore,
    );
    const snapshot = createSimulationState().snapshot;
    const request: ScheduleChangeRequest = {
      kind: "shift_service",
      serviceId: workspace.currentPlan().services[0].serviceId,
      deltaMinutes: 5,
    };

    const preview = await workspace.preview(request, snapshot, "human") as SchedulePreview;

    expect(preview.id).toMatch(/^preview-/);
    expect(workspace.getSnapshot().pendingPreview?.id).toBe(preview.id);
    expect(port.calls).toHaveLength(0);
  });
});
