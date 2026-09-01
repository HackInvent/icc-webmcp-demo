import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOperationsRepository,
  OperationsRepositoryConflictError,
} from "../server/operations-repository.mjs";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-restart-"));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "operations.sqlite");
}

async function openRepository(databasePath) {
  const repository = await createOperationsRepository({ databasePath });
  cleanups.push(async () => repository.close());
  return repository;
}

function operationalState(overrides = {}) {
  return {
    schema: "paris-icc-operational-state.v1",
    runId: "RUN-RESTART-001",
    native: {
      decisionRevision: 19,
      telemetryRevision: 87,
      timestamp: 1_777_000_000_000,
      speed: 1,
      incidents: [{ id: "INC-M13-WORKS", status: "active" }],
    },
    detailed: {
      speed: 1,
      snapshot: {
        decisionRevision: 12,
        revision: 91,
        incidents: [],
      },
    },
    procedureExecutions: [{
      incidentId: "INC-M13-WORKS",
      procedureId: "ICC-PROC-WORKS-HANDBACK-001",
      procedureRevision: "1.0",
      completedStepIds: ["ICC-PROC-WORKS-HANDBACK-001-S01"],
      nextRequiredStepId: "ICC-PROC-WORKS-HANDBACK-001-S02",
    }],
    schedules: {
      currentHash: "sha256:test-schedule",
      committedVersion: 3,
    },
    ...overrides,
  };
}

describe("operations repository process restart", () => {
  it("restores the exact snapshot and replays a committed command after reopening", async () => {
    const databasePath = temporaryDatabase();
    const beforePause = operationalState();
    const afterPause = operationalState({
      native: {
        ...beforePause.native,
        decisionRevision: 20,
        speed: 0,
      },
      detailed: {
        ...beforePause.detailed,
        speed: 0,
        snapshot: {
          ...beforePause.detailed.snapshot,
          decisionRevision: 13,
        },
      },
    });

    const firstProcess = await openRepository(databasePath);
    await firstProcess.save({
      workspaceId: "test-session",
      stateSchemaVersion: 1,
      stateRevision: 41,
      state: beforePause,
    });
    const committed = await firstProcess.executeCommandTransaction({
      workspaceId: "test-session",
      commandId: "CMD-PAUSE-RESTART-001",
      commandType: "simulation.pause",
      commandPayload: { speed: 0 },
      expectedStateRevision: 41,
      nextState: afterPause,
      stateSchemaVersion: 1,
      result: {
        status: "simulation_control_applied",
        speed: 0,
        receiptId: "RECEIPT-PAUSE-001",
      },
      eventType: "simulation.paused",
      eventPayload: { previousSpeed: 1, speed: 0 },
      actorSessionId: "session-restart-test",
      occurredAt: 1_777_000_000_500,
    });
    expect(committed).toMatchObject({
      status: "committed",
      commandId: "CMD-PAUSE-RESTART-001",
      commandType: "simulation.pause",
      stateRevision: 42,
      result: {
        status: "simulation_control_applied",
        receiptId: "RECEIPT-PAUSE-001",
      },
    });
    await firstProcess.close();

    const secondProcess = await openRepository(databasePath);
    const restored = await secondProcess.load("test-session");
    expect(restored).toMatchObject({
      workspaceId: "test-session",
      stateSchemaVersion: 1,
      stateRevision: 42,
      state: afterPause,
    });

    const eventsAfterRestart = await secondProcess.listEvents({
      workspaceId: "test-session",
      afterSequence: 0,
      limit: 10,
    });
    expect(eventsAfterRestart).toHaveLength(1);
    expect(eventsAfterRestart[0]).toMatchObject({
      sequence: committed.eventSequence,
      workspaceId: "test-session",
      eventType: "simulation.paused",
      commandId: "CMD-PAUSE-RESTART-001",
      actorSessionId: "session-restart-test",
      stateRevision: 42,
      payload: { previousSpeed: 1, speed: 0 },
    });

    // Models a client retry after the first HTTP response was lost and the
    // server process restarted. The stale expected revision must not matter for
    // an already committed command ID: the durable receipt is replayed.
    const replayed = await secondProcess.executeCommandTransaction({
      workspaceId: "test-session",
      commandId: "CMD-PAUSE-RESTART-001",
      commandType: "simulation.pause",
      commandPayload: { speed: 0 },
      expectedStateRevision: 41,
      nextState: afterPause,
      stateSchemaVersion: 1,
      result: { status: "should-not-replace-the-durable-result" },
      eventType: "should.not.be.appended",
      eventPayload: { duplicate: true },
    });
    expect(replayed).toEqual({
      ...committed,
      status: "replayed",
    });
    expect(await secondProcess.load("test-session")).toMatchObject({
      stateRevision: 42,
      state: afterPause,
    });
    expect(await secondProcess.listEvents({
      workspaceId: "test-session",
      afterSequence: 0,
      limit: 10,
    })).toHaveLength(1);
  });

  it("keeps durable state unchanged when a stale command arrives after restart", async () => {
    const databasePath = temporaryDatabase();
    const persistedState = operationalState();

    const firstProcess = await openRepository(databasePath);
    await firstProcess.save({
      workspaceId: "test-session",
      stateSchemaVersion: 1,
      stateRevision: 9,
      state: persistedState,
    });
    await firstProcess.close();

    const secondProcess = await openRepository(databasePath);
    await expect(secondProcess.executeCommandTransaction({
      workspaceId: "test-session",
      commandId: "CMD-STALE-AFTER-RESTART",
      commandType: "simulation.pause",
      expectedStateRevision: 8,
      nextState: operationalState({ runId: "MUST-NOT-BE-SAVED" }),
      result: { status: "must-not-be-recorded" },
    })).rejects.toBeInstanceOf(OperationsRepositoryConflictError);

    expect(await secondProcess.load("test-session")).toMatchObject({
      stateRevision: 9,
      state: persistedState,
    });
    expect(await secondProcess.listEvents({
      workspaceId: "test-session",
      afterSequence: 0,
      limit: 10,
    })).toEqual([]);
  });
});
