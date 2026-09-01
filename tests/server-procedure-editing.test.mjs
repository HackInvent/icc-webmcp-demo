import { afterEach, describe, expect, it } from "vitest";
import { createOperationsService } from "../server/operations-service.ts";
import { getOperationalProcedure } from "../src/procedures/index.ts";
import { NATIVE_INTERSTATIONS } from "../src/rail/nativeNetwork.ts";

function copy(value) {
  return structuredClone(value);
}

class MemoryRepository {
  runtime = new Map();
  commands = new Map();
  events = [];
  databasePath = "/memory/procedure-editing.sqlite";

  async loadRuntime(workspaceId) {
    return copy(this.runtime.get(workspaceId) ?? null);
  }

  async saveRuntime(workspaceId, state, options = {}) {
    const previous = this.runtime.get(workspaceId);
    const record = {
      workspaceId,
      stateRevision: options.stateRevision ?? state.stateRevision,
      state: copy(state),
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.runtime.set(workspaceId, record);
    if (options.event) this.events.push(copy(options.event));
    return { runtimeState: copy(record), event: options.event ?? null };
  }

  async getCommandResult(workspaceId, commandId) {
    return copy(this.commands.get(`${workspaceId}:${commandId}`) ?? null);
  }

  async saveCommandResult(workspaceId, commandId, result, state, options = {}) {
    await this.saveRuntime(workspaceId, state, {
      stateRevision: state.stateRevision,
      event: options.event,
    });
    this.commands.set(`${workspaceId}:${commandId}`, {
      commandType: options.commandType,
      requestFingerprint: options.requestFingerprint,
      result: copy(result),
    });
    return { result: copy(result) };
  }

  async listEvents({ workspaceId } = {}) {
    return copy(this.events.filter((event) =>
      !workspaceId || event.workspaceId === undefined || event.workspaceId === workspaceId
    ));
  }

  async close() {}
}

const services = [];

afterEach(async () => {
  while (services.length > 0) await services.pop().close();
});

async function openService(repository) {
  const service = await createOperationsService({
    repository,
    now: () => Date.UTC(2026, 7, 30, 18, 0, 0),
    tickIntervalMs: 60_000,
  });
  services.push(service);
  return service;
}

function editEnvelope(state, procedure, step, patch, commandId) {
  return {
    commandId,
    type: "update_procedure_step",
    expectedStateRevision: state.stateRevision,
    payload: {
      procedureId: procedure.procedureId,
      stepId: step.stepId,
      expectedProcedureRevision: procedure.revision,
      expectedProcedureContentHash: procedure.contentHash,
      patch,
    },
  };
}

describe("server procedure editing workspace", () => {
  it("persists editions, pins exact old revisions, survives reset/restart and isolates workspaces", async () => {
    const repository = new MemoryRepository();
    const workspaceId = "test-procedure-editing";
    const actor = "procedure-editor-operator";
    let service = await openService(repository);
    let state = await service.getSnapshot(workspaceId);
    const baseline = getOperationalProcedure("ICC-PROC-WORKS-HANDBACK-001");
    const firstStep = baseline.steps[0];
    expect(state.procedureCatalogue).toMatchObject({
      schemaVersion: "paris-icc.procedure-workspace.v1",
      sequence: 0,
      revision: "ws.000000",
      activeOverrides: {},
      referencedVersions: [],
    });

    const firstEdit = await service.command(
      workspaceId,
      actor,
      editEnvelope(
        state,
        baseline,
        firstStep,
        { title: "Acknowledge the protected engineering possession" },
        "CMD-PROC-EDIT-0001",
      ),
    );
    state = firstEdit.snapshot;
    const revisionOne = firstEdit.result.procedure;
    expect(firstEdit.result).toMatchObject({
      previousRevision: baseline.revision,
      previousContentHash: baseline.contentHash,
      changedFields: ["title"],
    });
    expect(revisionOne.revision).not.toBe(baseline.revision);
    expect(state.procedureCatalogue.activeOverrides[baseline.procedureId])
      .toBe(revisionOne.revision);
    expect(state.shift.logs.at(-1)).toMatchObject({
      eventType: "procedure-step-revision-published",
      actor: "operator",
      entityIds: [baseline.procedureId, firstStep.stepId],
    });
    expect(repository.events.at(-1)).toMatchObject({
      type: "update_procedure_step",
      actorSessionId: actor,
      payload: { commandId: "CMD-PROC-EDIT-0001" },
    });

    const appliedOldRevision = await service.command(workspaceId, actor, {
      commandId: "CMD-PROC-APPLY-0001",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: "INC-M13-WORKS",
        procedureId: revisionOne.procedureId,
        procedureRevision: revisionOne.revision,
        procedureContentHash: revisionOne.contentHash,
        stepId: revisionOne.steps[0].stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    state = appliedOldRevision.snapshot;
    expect(state.procedureExecutions).toContainEqual(expect.objectContaining({
      incidentId: "INC-M13-WORKS",
      procedureRevision: revisionOne.revision,
      procedureContentHash: revisionOne.contentHash,
      completedStepIds: [revisionOne.steps[0].stepId],
    }));

    const secondEdit = await service.command(
      workspaceId,
      actor,
      editEnvelope(
        state,
        revisionOne,
        revisionOne.steps[0],
        { durationRangeSeconds: { minSeconds: 120, nominalSeconds: 240, maxSeconds: 480 } },
        "CMD-PROC-EDIT-0002",
      ),
    );
    state = secondEdit.snapshot;
    const revisionTwo = secondEdit.result.procedure;
    expect(state.procedureCatalogue.referencedVersions.map((item) => item.revision))
      .toEqual(expect.arrayContaining([revisionOne.revision, revisionTwo.revision]));

    const alternateEdge = NATIVE_INTERSTATIONS.find((edge) =>
      edge.lineCode === "M13" &&
      edge.id !== "interstation-M13-71435--71474"
    );
    expect(alternateEdge).toBeDefined();
    const created = await service.command(workspaceId, actor, {
      commandId: "CMD-PROC-INCIDENT-0001",
      type: "create_native_incident",
      expectedStateRevision: state.stateRevision,
      payload: {
        lineCode: "M13",
        interstationId: alternateEdge.id,
        title: "Second engineering possession",
        summary: "A separate protected worksite used to verify the active procedure revision.",
        type: "works",
        severity: "high",
        restrictionMode: "blocked",
        owner: "Infrastructure control",
      },
    });
    state = created.snapshot;
    expect(state.operationalResponse.incidentCases.find((item) =>
      item.incidentId === created.result.incident.id
    )?.predictedDuration).toMatchObject({
      procedureId: baseline.procedureId,
      procedureRevision: revisionTwo.revision,
    });
    expect(state.operationalResponse.incidentCases.find((item) =>
      item.incidentId === "INC-M13-WORKS"
    )?.predictedDuration?.procedureRevision).toBe(baseline.revision);

    const reset = await service.command(workspaceId, actor, {
      commandId: "CMD-PROC-RESET-0001",
      type: "reset_all",
      expectedStateRevision: state.stateRevision,
      payload: {},
    });
    state = reset.snapshot;
    expect(state.procedureExecutions).toEqual([]);
    expect(state.procedureCatalogue.activeOverrides[baseline.procedureId])
      .toBe(revisionTwo.revision);
    expect(state.procedureCatalogue.referencedVersions.map((item) => item.revision))
      .toEqual([revisionTwo.revision]);

    await service.close();
    services.pop();
    service = await openService(repository);
    state = await service.getSnapshot(workspaceId);
    expect(state.procedureCatalogue).toMatchObject({
      sequence: 2,
      activeOverrides: { [baseline.procedureId]: revisionTwo.revision },
    });

    const reappliedHistorical = await service.command(workspaceId, actor, {
      commandId: "CMD-PROC-HISTORY-0001",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: "INC-M13-WORKS",
        procedureId: revisionOne.procedureId,
        procedureRevision: revisionOne.revision,
        procedureContentHash: revisionOne.contentHash,
        stepId: revisionOne.steps[0].stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    expect(reappliedHistorical.snapshot.procedureCatalogue.referencedVersions.map(
      (item) => item.revision,
    )).toEqual(expect.arrayContaining([revisionOne.revision, revisionTwo.revision]));

    const isolated = await service.getSnapshot("test-procedure-isolated");
    expect(isolated.procedureCatalogue).toMatchObject({
      sequence: 0,
      revision: "ws.000000",
      activeOverrides: {},
      referencedVersions: [],
    });
  }, 20_000);

  it("is idempotent and rejects stale, no-op, hash-conflicting and locked patches", async () => {
    const repository = new MemoryRepository();
    const service = await openService(repository);
    const workspaceId = "test-procedure-conflicts";
    const actor = "procedure-editor-operator";
    const baseline = getOperationalProcedure("ICC-PROC-WORKS-HANDBACK-001");
    const step = baseline.steps[0];
    const initial = await service.getSnapshot(workspaceId);
    const envelope = editEnvelope(
      initial,
      baseline,
      step,
      { rationale: `${step.rationale} Verified by the procedure editor.` },
      "CMD-PROC-IDEMPOTENT-0001",
    );
    const applied = await service.command(workspaceId, actor, envelope);
    const replayed = await service.command(workspaceId, actor, envelope);
    expect(replayed).toEqual(applied);
    expect((await service.getSnapshot(workspaceId)).stateRevision)
      .toBe(applied.stateRevision);

    const active = applied.result.procedure;
    await expect(service.command(workspaceId, actor, editEnvelope(
      applied.snapshot,
      active,
      active.steps[0],
      { rationale: active.steps[0].rationale },
      "CMD-PROC-NOCHANGE-0001",
    ))).rejects.toMatchObject({ status: 409, code: "no_change" });

    await expect(service.command(workspaceId, actor, {
      ...editEnvelope(
        applied.snapshot,
        baseline,
        step,
        { title: "Stale title" },
        "CMD-PROC-REVISION-0001",
      ),
      payload: {
        ...editEnvelope(
          applied.snapshot,
          baseline,
          step,
          { title: "Stale title" },
          "CMD-PROC-UNUSED-0001",
        ).payload,
        expectedProcedureContentHash: active.contentHash,
      },
    })).rejects.toMatchObject({ status: 409, code: "revision_conflict" });

    await expect(service.command(workspaceId, actor, {
      commandId: "CMD-PROC-HASH-0001",
      type: "update_procedure_step",
      expectedStateRevision: applied.snapshot.stateRevision,
      payload: {
        procedureId: active.procedureId,
        stepId: active.steps[0].stepId,
        expectedProcedureRevision: active.revision,
        expectedProcedureContentHash: `sha256:${"0".repeat(64)}`,
        patch: { title: "Hash-conflicting title" },
      },
    })).rejects.toMatchObject({ status: 409, code: "hash_conflict" });

    await expect(service.command(workspaceId, actor, {
      commandId: "CMD-PROC-LOCKED-0001",
      type: "update_procedure_step",
      expectedStateRevision: applied.snapshot.stateRevision,
      payload: {
        procedureId: active.procedureId,
        stepId: active.steps[0].stepId,
        expectedProcedureRevision: active.revision,
        expectedProcedureContentHash: active.contentHash,
        patch: { capability: "resolve-simulation" },
      },
    })).rejects.toMatchObject({
      status: 400,
      code: "invalid_input",
      details: { forbiddenFields: ["capability"] },
    });

    await expect(service.command(workspaceId, actor, {
      commandId: "CMD-PROC-STATE-STALE-0001",
      type: "update_procedure_step",
      expectedStateRevision: initial.stateRevision,
      payload: {
        procedureId: active.procedureId,
        stepId: active.steps[0].stepId,
        expectedProcedureRevision: active.revision,
        expectedProcedureContentHash: active.contentHash,
        patch: { title: "State-stale title" },
      },
    })).rejects.toMatchObject({ status: 409, code: "stale_state_revision" });
  });

  it("refuses to continue an execution whose pinned revision hash is inconsistent", async () => {
    const repository = new MemoryRepository();
    const workspaceId = "test-procedure-hash-pin";
    const actor = "procedure-editor-operator";
    let service = await openService(repository);
    let state = await service.getSnapshot(workspaceId);
    const baseline = getOperationalProcedure("ICC-PROC-WORKS-HANDBACK-001");
    const edited = await service.command(
      workspaceId,
      actor,
      editEnvelope(
        state,
        baseline,
        baseline.steps[0],
        { title: "Pinned acknowledgement" },
        "CMD-PROC-PIN-EDIT-0001",
      ),
    );
    const revision = edited.result.procedure;
    state = edited.snapshot;
    const first = await service.command(workspaceId, actor, {
      commandId: "CMD-PROC-PIN-APPLY-0001",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: "INC-M13-WORKS",
        procedureId: revision.procedureId,
        procedureRevision: revision.revision,
        procedureContentHash: revision.contentHash,
        stepId: revision.steps[0].stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    await service.close();
    services.pop();
    repository.runtime.get(workspaceId).state.procedureExecutions[0].procedureContentHash =
      `sha256:${"f".repeat(64)}`;

    service = await openService(repository);
    state = await service.getSnapshot(workspaceId);
    await expect(service.command(workspaceId, actor, {
      commandId: "CMD-PROC-PIN-APPLY-0002",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: "INC-M13-WORKS",
        procedureId: revision.procedureId,
        procedureRevision: revision.revision,
        procedureContentHash: revision.contentHash,
        stepId: revision.steps[1].stepId,
        expectedDecisionRevision: first.snapshot.native.decisionRevision,
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "procedure_execution_hash_mismatch",
      details: {
        executionContentHash: `sha256:${"f".repeat(64)}`,
        procedureContentHash: revision.contentHash,
      },
    });
  });
});
