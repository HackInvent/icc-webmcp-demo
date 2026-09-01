import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperationsRepository,
  OperationsRepositoryClosedError,
  OperationsRepositoryConflictError,
  OperationsRepositoryError,
} from "../server/operations-repository.mjs";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-repository-"));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    databasePath: path.join(directory, "operations.sqlite"),
  };
}

async function openRepository(databasePath, options = {}) {
  const repository = await createOperationsRepository({
    databasePath,
    ...options,
  });
  cleanups.push(async () => repository.close());
  return repository;
}

describe("portable SQLite operations repository", () => {
  it("migrates an empty database and durably restores runtime state and events", async () => {
    const { directory, databasePath } = temporaryDatabase();
    let clock = 1_777_000_000_000;
    const repository = await openRepository(databasePath, { now: () => clock });

    expect(await repository.loadRuntime("test")).toBeNull();
    expect(readFileSync(databasePath).subarray(0, 16).toString("utf8"))
      .toBe("SQLite format 3\u0000");
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);

    const state = {
      schema: "paris-icc-operational-state.v1",
      native: { telemetryRevision: 87, decisionRevision: 19, speed: 1 },
      procedureExecutions: [{ incidentId: "INC-M13-WORKS", completedStepIds: ["S01"] }],
    };
    const saved = await repository.saveRuntime("test", state, {
      stateSchemaVersion: 1,
      stateRevision: 12,
      event: {
        eventId: "EVT-BOOT-001",
        type: "runtime.restored",
        payload: { source: "initial-configuration" },
      },
    });
    expect(saved.runtimeState).toMatchObject({
      workspaceId: "test",
      stateSchemaVersion: 1,
      stateRevision: 12,
      state,
      createdAt: clock,
      updatedAt: clock,
    });
    expect(saved.event).toMatchObject({
      sequence: 1,
      eventId: "EVT-BOOT-001",
      eventType: "runtime.restored",
      stateRevision: 12,
      payload: { source: "initial-configuration" },
    });

    state.native.speed = 4;
    expect((await repository.loadRuntime("test")).state.native.speed).toBe(1);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await repository.close();
    const reopened = await openRepository(databasePath, { now: () => clock });
    expect(await reopened.loadRuntime("test")).toMatchObject({
      stateRevision: 12,
      state: {
        native: { telemetryRevision: 87, decisionRevision: 19, speed: 1 },
        procedureExecutions: [{ incidentId: "INC-M13-WORKS", completedStepIds: ["S01"] }],
      },
    });
    expect(await reopened.listEvents({ workspaceId: "test" })).toEqual([
      expect.objectContaining({
        sequence: 1,
        eventId: "EVT-BOOT-001",
        eventType: "runtime.restored",
      }),
    ]);
  });

  it("atomically saves a command receipt and replays the same command id once", async () => {
    const { databasePath } = temporaryDatabase();
    const repository = await openRepository(databasePath, { now: () => 1_777_000_000_500 });
    await repository.saveRuntime("default", { speed: 1 }, { stateRevision: 7 });

    const committed = await repository.saveCommandResult(
      "default",
      "CMD-PAUSE-001",
      { status: "applied", speed: 0 },
      { speed: 0 },
      {
        commandType: "simulation.pause",
        commandPayload: { speed: 0 },
        expectedStateRevision: 7,
        actorSessionId: "test-session",
        event: {
          eventId: "EVT-PAUSE-001",
          type: "simulation.paused",
          payload: { previousSpeed: 1, speed: 0 },
        },
      },
    );
    expect(committed).toEqual({
      status: "committed",
      commandId: "CMD-PAUSE-001",
      commandType: "simulation.pause",
      stateRevision: 8,
      result: { status: "applied", speed: 0 },
      eventSequence: 1,
    });
    expect(await repository.getCommandResult("default", "CMD-PAUSE-001"))
      .toMatchObject({
        commandType: "simulation.pause",
        stateRevision: 8,
        result: { status: "applied", speed: 0 },
        eventSequence: 1,
      });

    const replayed = await repository.saveCommandResult(
      "default",
      "CMD-PAUSE-001",
      { status: "must-not-replace" },
      { speed: 4 },
      {
        commandType: "simulation.pause",
        commandPayload: { speed: 0 },
        expectedStateRevision: 7,
        event: { type: "must.not.append", payload: { duplicate: true } },
      },
    );
    expect(replayed).toEqual({ ...committed, status: "replayed" });
    await expect(repository.saveCommandResult(
      "default",
      "CMD-PAUSE-001",
      { status: "must-not-replace" },
      { speed: 4 },
      {
        commandType: "simulation.pause",
        commandPayload: { speed: 4 },
        expectedStateRevision: 7,
        event: { type: "must.not.append", payload: { duplicate: true } },
      },
    )).rejects.toMatchObject({
      name: OperationsRepositoryError.name,
      code: "command_id_reused",
    });
    expect(await repository.loadRuntime("default")).toMatchObject({
      stateRevision: 8,
      state: { speed: 0 },
    });
    expect(await repository.listEvents({ workspaceId: "default" })).toEqual([
      expect.objectContaining({
        eventId: "EVT-PAUSE-001",
        commandId: "CMD-PAUSE-001",
        actorSessionId: "test-session",
        payload: { previousSpeed: 1, speed: 0 },
      }),
    ]);
  });

  it("rejects stale writes without changing state, events, or command results", async () => {
    const { databasePath } = temporaryDatabase();
    const repository = await openRepository(databasePath);
    await repository.saveRuntime("default", { incidents: ["INC-001"] }, { stateRevision: 21 });

    await expect(repository.executeCommandTransaction({
      workspaceId: "default",
      commandId: "CMD-STALE-001",
      commandType: "incident.close",
      expectedStateRevision: 20,
      nextState: { incidents: [] },
      result: { status: "closed" },
      eventType: "incident.closed",
    })).rejects.toBeInstanceOf(OperationsRepositoryConflictError);

    expect(await repository.loadRuntime("default")).toMatchObject({
      stateRevision: 21,
      state: { incidents: ["INC-001"] },
    });
    expect(await repository.getCommandResult("default", "CMD-STALE-001")).toBeNull();
    expect(await repository.listEvents({ workspaceId: "default" })).toEqual([]);
  });

  it("paginates independent workspace journals and refuses use after close", async () => {
    const { databasePath } = temporaryDatabase();
    const repository = await openRepository(databasePath);
    await repository.saveRuntime("left", { value: 1 }, {
      stateRevision: 1,
      event: { eventId: "EVT-L1", type: "left.one", payload: { value: 1 } },
    });
    await repository.saveRuntime("right", { value: 9 }, {
      stateRevision: 1,
      event: { eventId: "EVT-R1", type: "right.one", payload: { value: 9 } },
    });
    await repository.saveRuntime("left", { value: 2 }, {
      expectedStateRevision: 1,
      stateRevision: 2,
      event: { eventId: "EVT-L2", type: "left.two", payload: { value: 2 } },
    });

    const first = await repository.listEvents({ workspaceId: "left", limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0].eventId).toBe("EVT-L1");
    expect(await repository.listEvents({
      workspaceId: "left",
      afterSequence: first[0].sequence,
      limit: 10,
    })).toEqual([expect.objectContaining({ eventId: "EVT-L2" })]);
    expect(await repository.listEvents({ workspaceId: "right" }))
      .toEqual([expect.objectContaining({ eventId: "EVT-R1" })]);

    await repository.close();
    await expect(repository.loadRuntime("left"))
      .rejects.toBeInstanceOf(OperationsRepositoryClosedError);
  });
});
