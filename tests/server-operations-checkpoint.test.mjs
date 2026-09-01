import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsService } from "../server/operations-service.ts";

function copy(value) {
  return structuredClone(value);
}

class RecordingRepository {
  databasePath = "/memory/paris-icc-checkpoint.sqlite";
  runtime = new Map();
  commands = new Map();
  saveRuntimeCalls = [];
  saveCommandResultCalls = [];
  closeCalls = 0;

  async loadRuntime(workspaceId) {
    const record = this.runtime.get(workspaceId);
    return record ? copy(record) : null;
  }

  async saveRuntime(workspaceId, state, options = {}) {
    const stateRevision = options.stateRevision ?? state.stateRevision;
    const previous = this.runtime.get(workspaceId);
    const record = {
      workspaceId,
      stateSchemaVersion: options.stateSchemaVersion ?? 1,
      stateRevision,
      state: copy(state),
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.runtime.set(workspaceId, record);
    this.saveRuntimeCalls.push({ workspaceId, state: copy(state), options: copy(options) });
    return { runtimeState: copy(record), event: null };
  }

  async getCommandResult(workspaceId, commandId) {
    const result = this.commands.get(workspaceId + ":" + commandId);
    return result ? copy(result) : null;
  }

  async saveCommandResult(workspaceId, commandId, result, state, options = {}) {
    const stateRevision = state.stateRevision;
    const record = {
      workspaceId,
      commandId,
      commandType: options.commandType,
      requestFingerprint: options.requestFingerprint,
      stateRevision,
      result: copy(result),
      eventSequence: this.saveCommandResultCalls.length + 1,
      createdAt: Date.now(),
    };
    this.runtime.set(workspaceId, {
      workspaceId,
      stateSchemaVersion: options.stateSchemaVersion ?? 1,
      stateRevision,
      state: copy(state),
      createdAt: this.runtime.get(workspaceId)?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    this.commands.set(workspaceId + ":" + commandId, record);
    this.saveCommandResultCalls.push({
      workspaceId,
      commandId,
      result: copy(result),
      state: copy(state),
      options: copy(options),
    });
    return {
      status: "committed",
      commandId,
      commandType: options.commandType,
      stateRevision,
      result: copy(result),
      eventSequence: record.eventSequence,
    };
  }

  async listEvents() {
    return [];
  }

  async close() {
    this.closeCalls += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

async function advanceAndDrain(service, workspaceId, milliseconds) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  return service.getSnapshot(workspaceId);
}

describe("operations telemetry checkpoint cadence", () => {
  it("maps the default one-second server clock to x1, x2, x4 and pause simulation rates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T11:00:00.000Z"));
    const repository = new RecordingRepository();
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      telemetryCheckpointIntervalMs: 60_000,
    });
    const workspaceId = "realtime-cadence-test";
    const initial = await service.getSnapshot(workspaceId);

    const beforeFirstSecond = await advanceAndDrain(service, workspaceId, 999);
    expect(beforeFirstSecond.native.timestamp).toBe(initial.native.timestamp);
    expect(beforeFirstSecond.detailed.snapshot.timestamp).toBe(initial.detailed.snapshot.timestamp);

    const atX1 = await advanceAndDrain(service, workspaceId, 1);
    expect(atX1.native.timestamp - initial.native.timestamp).toBe(1_000);
    expect(atX1.detailed.snapshot.timestamp - initial.detailed.snapshot.timestamp).toBe(1_000);

    const speed2 = await service.command(workspaceId, "test-session", {
      commandId: "CMD-CADENCE-SPEED-2",
      type: "set_speed",
      expectedStateRevision: atX1.stateRevision,
      payload: { speed: 2 },
    });
    const atX2 = await advanceAndDrain(service, workspaceId, 1_000);
    expect(atX2.native.timestamp - speed2.snapshot.native.timestamp).toBe(2_000);
    expect(atX2.detailed.snapshot.timestamp - speed2.snapshot.detailed.snapshot.timestamp).toBe(2_000);

    const speed4 = await service.command(workspaceId, "test-session", {
      commandId: "CMD-CADENCE-SPEED-4",
      type: "set_speed",
      expectedStateRevision: atX2.stateRevision,
      payload: { speed: 4 },
    });
    const atX4 = await advanceAndDrain(service, workspaceId, 1_000);
    expect(atX4.native.timestamp - speed4.snapshot.native.timestamp).toBe(4_000);
    expect(atX4.detailed.snapshot.timestamp - speed4.snapshot.detailed.snapshot.timestamp).toBe(4_000);

    const paused = await service.command(workspaceId, "test-session", {
      commandId: "CMD-CADENCE-PAUSE",
      type: "set_speed",
      expectedStateRevision: atX4.stateRevision,
      payload: { speed: 0 },
    });
    const afterPause = await advanceAndDrain(service, workspaceId, 1_000);
    expect(afterPause.native.timestamp).toBe(paused.snapshot.native.timestamp);
    expect(afterPause.detailed.snapshot.timestamp).toBe(paused.snapshot.detailed.snapshot.timestamp);

    await service.close();
  });

  it("publishes every telemetry tick, checkpoints periodically, and flushes the latest snapshot on close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    const repository = new RecordingRepository();
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 1_000,
      telemetryCheckpointIntervalMs: 5_000,
    });
    const workspaceId = "checkpoint-test";
    const initial = await service.getSnapshot(workspaceId);
    const published = [];
    await service.subscribe(workspaceId, (snapshot) => published.push(snapshot));

    let current = initial;
    for (let index = 0; index < 4; index += 1) {
      current = await advanceAndDrain(service, workspaceId, 1_000);
    }
    expect(published).toHaveLength(4);
    expect(current.streamRevision).toBe(initial.streamRevision + 4);
    expect(current.stateRevision).toBe(initial.stateRevision);
    expect(repository.saveRuntimeCalls).toHaveLength(1);

    current = await advanceAndDrain(service, workspaceId, 1_000);
    expect(published).toHaveLength(5);
    expect(repository.saveRuntimeCalls).toHaveLength(2);
    expect(repository.runtime.get(workspaceId).state.streamRevision)
      .toBe(current.streamRevision);

    current = await advanceAndDrain(service, workspaceId, 2_000);
    expect(published).toHaveLength(7);
    expect(repository.saveRuntimeCalls).toHaveLength(2);
    expect(repository.runtime.get(workspaceId).state.streamRevision)
      .toBeLessThan(current.streamRevision);

    const firstClose = service.close();
    const repeatedClose = service.close();
    expect(repeatedClose).toBe(firstClose);
    await firstClose;

    expect(repository.saveRuntimeCalls).toHaveLength(3);
    expect(repository.runtime.get(workspaceId).state).toMatchObject({
      stateRevision: current.stateRevision,
      streamRevision: current.streamRevision,
      native: { telemetryRevision: current.native.telemetryRevision },
      detailed: { snapshot: { revision: current.detailed.snapshot.revision } },
    });
    expect(repository.closeCalls).toBe(1);
  });

  it("persists a command immediately together with preceding uncheckpointed telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T13:00:00.000Z"));
    const repository = new RecordingRepository();
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 1_000,
      telemetryCheckpointIntervalMs: 60_000,
    });
    const workspaceId = "command-test";
    const initial = await service.getSnapshot(workspaceId);
    const afterTick = await advanceAndDrain(service, workspaceId, 1_000);
    expect(afterTick.streamRevision).toBe(initial.streamRevision + 1);
    expect(repository.saveRuntimeCalls).toHaveLength(1);

    const applied = await service.command(workspaceId, "test-session", {
      commandId: "CMD-CHECKPOINT-PAUSE-01",
      type: "set_speed",
      expectedStateRevision: afterTick.stateRevision,
      payload: { speed: 0 },
    });

    expect(repository.saveCommandResultCalls).toHaveLength(1);
    expect(repository.runtime.get(workspaceId).state).toMatchObject({
      stateRevision: applied.stateRevision,
      streamRevision: applied.snapshot.streamRevision,
      native: { speed: 0, telemetryRevision: afterTick.native.telemetryRevision },
      detailed: { speed: 0 },
    });
    await service.close();
    expect(repository.saveRuntimeCalls).toHaveLength(1);
  });

  it("persists an automatic decision transition immediately before the checkpoint interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T14:00:00.000Z"));
    const repository = new RecordingRepository();
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 1_000,
      telemetryCheckpointIntervalMs: 60_000,
    });
    const workspaceId = "decision-test";
    const initial = await service.getSnapshot(workspaceId);
    const section = initial.detailed.snapshot.powerSections[0];
    const scheduled = await service.command(workspaceId, "test-session", {
      commandId: "CMD-CHECKPOINT-DECISION-1",
      type: "schedule_power_incident",
      expectedStateRevision: initial.stateRevision,
      payload: {
        targetType: "power",
        targetId: section.id,
        lineCode: section.lineIds[0],
        type: "power",
        severity: "high",
        effect: "isolate-power",
        occurrenceTime: initial.detailed.snapshot.timestamp + 1,
        title: "Immediate decision checkpoint",
        summary: "A due incident must bypass the telemetry checkpoint cadence.",
      },
    });
    expect(repository.saveRuntimeCalls).toHaveLength(1);
    expect(repository.saveCommandResultCalls).toHaveLength(1);

    const activated = await advanceAndDrain(service, workspaceId, 1_000);
    expect(activated.stateRevision).toBe(scheduled.stateRevision + 1);
    expect(repository.saveRuntimeCalls).toHaveLength(2);
    expect(repository.saveRuntimeCalls.at(-1).options.event).toMatchObject({
      type: "scheduled_state_transition",
    });
    expect(repository.runtime.get(workspaceId).state.stateRevision)
      .toBe(activated.stateRevision);
    await service.close();
  });
});
