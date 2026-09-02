import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsService } from "../server/operations-service.ts";
import { getOperationalProcedure } from "../src/procedures/index.ts";
import { NATIVE_INTERSTATIONS, NATIVE_STATIONS } from "../src/rail/nativeNetwork.ts";
import { nativeOperatorTrainInsertionOptions } from "../src/rail/nativeSimulation.ts";

function copy(value) {
  return structuredClone(value);
}

class MemoryRepository {
  runtime = new Map();
  commands = new Map();
  databasePath = "/memory/operational-response.sqlite";

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
    return { runtimeState: copy(record), event: options.event ?? null };
  }

  async getCommandResult(workspaceId, commandId) {
    return copy(this.commands.get(`${workspaceId}:${commandId}`) ?? null);
  }

  async saveCommandResult(workspaceId, commandId, result, state, options = {}) {
    await this.saveRuntime(workspaceId, state, { stateRevision: state.stateRevision });
    this.commands.set(`${workspaceId}:${commandId}`, {
      commandType: options.commandType,
      requestFingerprint: options.requestFingerprint,
      result: copy(result),
    });
    return { result: copy(result) };
  }

  async listEvents() { return []; }
  async close() {}
}

afterEach(() => vi.useRealTimers());

async function applyMandatoryBefore({
  service, workspaceId, actor, state, incident, procedure, order, commandPrefix,
}) {
  let current = state;
  let sequence = 0;
  for (const step of procedure.steps.filter((candidate) => candidate.mandatory && candidate.order < order)) {
    sequence += 1;
    const applied = await service.command(workspaceId, actor, {
      commandId: `${commandPrefix}-${String(sequence).padStart(2, "0")}`,
      type: "apply_procedure_step",
      expectedStateRevision: current.stateRevision,
      payload: {
        incidentId: incident.id,
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        procedureContentHash: procedure.contentHash,
        stepId: step.stepId,
        expectedDecisionRevision: current.native.decisionRevision,
      },
    });
    current = applied.snapshot;
  }
  return current;
}

describe("server operational-response persistence", () => {
  it("requires and records police clearance for abandoned baggage after split-service protection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:15:00.000Z"));
    const repository = new MemoryRepository();
    const workspaceId = "baggage-police-clearance-jury";
    const actor = "security-clearance-operator";
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 60_000,
    });
    let state = await service.getSnapshot(workspaceId);
    const station = NATIVE_STATIONS.find((candidate) =>
      candidate.lines.includes("RER_A") &&
      NATIVE_INTERSTATIONS.filter((interstation) =>
        interstation.lineCode === "RER_A" &&
        (interstation.fromStationCode === candidate.code || interstation.toStationCode === candidate.code)
      ).length === 2
    );
    expect(station).toBeDefined();
    const created = await service.command(workspaceId, actor, {
      commandId: "CMD-BAGGAGE-CREATE",
      type: "create_native_incident",
      expectedStateRevision: state.stateRevision,
      payload: {
        lineCode: "RER_A",
        target: { type: "station", id: station.code },
        effect: "abandoned-baggage",
        title: "Abandoned baggage",
        summary: "Exclude every call and traversal pending explicit police clearance.",
        type: "security",
        severity: "high",
      },
    });
    state = created.snapshot;
    const incident = created.result.incident;
    const procedure = getOperationalProcedure("ICC-PROC-ABANDONED-BAGGAGE-001");
    const clearance = procedure.steps.find((step) => step.title === "Record the applicable clearance");
    state = await applyMandatoryBefore({
      service,
      workspaceId,
      actor,
      state,
      incident,
      procedure,
      order: clearance.order,
      commandPrefix: "CMD-BAGGAGE-PREQ",
    });
    expect(state.operationalResponse.continuityMeasures.filter((measure) =>
      measure.incidentId === incident.id &&
      (measure.kind === "turnback" || measure.kind === "provisional-service")
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "turnback", status: "active" }),
      expect.objectContaining({ kind: "provisional-service", status: "active" }),
    ]));

    const basePayload = {
      incidentId: incident.id,
      procedureId: procedure.procedureId,
      procedureRevision: procedure.revision,
      procedureContentHash: procedure.contentHash,
      stepId: clearance.stepId,
      expectedDecisionRevision: state.native.decisionRevision,
    };
    await expect(service.command(workspaceId, actor, {
      commandId: "CMD-BAGGAGE-CLEARANCE-MISSING",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: basePayload,
    })).rejects.toMatchObject({
      code: "operator_evidence_reference_required",
      details: { evidenceKind: "police-clearance", stepId: clearance.stepId },
    });

    const reference = "POL-RERA-20260830-117";
    const applied = await service.command(workspaceId, actor, {
      commandId: "CMD-BAGGAGE-CLEARANCE-RECORDED",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: { ...basePayload, operatorEvidenceReference: reference },
    });
    expect(applied.result.stepRecord).toMatchObject({
      stepId: clearance.stepId,
      operatorEvidenceReference: reference,
      evidenceKind: "police-clearance",
    });
    expect(applied.snapshot.shift.logs.some((entry) => entry.summary.includes(reference))).toBe(true);
    await service.close();
  });

  it("rejects an empty works handback reference and restores the audited reference after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:00:00.000Z"));
    const repository = new MemoryRepository();
    const workspaceId = "works-handback-evidence-jury";
    const actor = "works-handback-operator";
    let service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 60_000,
    });
    let state = await service.getSnapshot(workspaceId);
    const activated = await service.command(workspaceId, actor, {
      commandId: "CMD-HANDBACK-SCENARIO",
      type: "activate_native_scenario",
      expectedStateRevision: state.stateRevision,
      payload: { scenarioId: "m13-works" },
    });
    state = activated.snapshot;
    const incident = state.native.incidents.find((item) => item.status === "active");
    const procedure = getOperationalProcedure("ICC-PROC-WORKS-HANDBACK-001");
    const clearance = procedure.steps.find((step) => step.title === "Record the applicable clearance");
    expect(incident).toBeTruthy();
    expect(clearance).toMatchObject({ order: 40, mandatory: true });

    state = await applyMandatoryBefore({
      service,
      workspaceId,
      actor,
      state,
      incident,
      procedure,
      order: clearance.order,
      commandPrefix: "CMD-HANDBACK-PREQ",
    });
    const stateRevisionBeforeRejectedEvidence = state.stateRevision;
    const clearancePayload = {
      incidentId: incident.id,
      procedureId: procedure.procedureId,
      procedureRevision: procedure.revision,
      procedureContentHash: procedure.contentHash,
      stepId: clearance.stepId,
      expectedDecisionRevision: state.native.decisionRevision,
    };
    await expect(service.command(workspaceId, actor, {
      commandId: "CMD-HANDBACK-MISSING-REF",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: clearancePayload,
    })).rejects.toMatchObject({
      code: "operator_evidence_reference_required",
      details: { stepId: clearance.stepId, evidenceKind: "works-handback" },
    });
    expect((await service.getSnapshot(workspaceId)).stateRevision)
      .toBe(stateRevisionBeforeRejectedEvidence);

    const reference = "HAND-M13-20260830-042";
    const applied = await service.command(workspaceId, actor, {
      commandId: "CMD-HANDBACK-WITH-REF",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: { ...clearancePayload, operatorEvidenceReference: `  ${reference}  ` },
    });
    expect(applied.result.stepRecord).toEqual({
      stepId: clearance.stepId,
      receiptId: `PROC-ACK-${incident.id}-${clearance.stepId}`,
      operatorId: actor,
      recordedAt: applied.snapshot.native.timestamp,
      operatorEvidenceReference: reference,
      evidenceKind: "works-handback",
    });
    expect(applied.snapshot.procedureExecutions.find((execution) =>
      execution.incidentId === incident.id
    )?.stepRecords).toContainEqual(applied.result.stepRecord);
    expect(applied.snapshot.shift.logs.find((entry) =>
      entry.eventType === "procedure-step-recorded" && entry.entityIds.includes(clearance.stepId)
    )?.summary).toContain(`authority reference ${reference}`);

    await service.close();
    service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 60_000,
    });
    const restored = await service.getSnapshot(workspaceId);
    expect(restored.procedureExecutions.find((execution) =>
      execution.incidentId === incident.id
    )?.stepRecords).toContainEqual(applied.result.stepRecord);
    expect(restored.shift.logs.some((entry) => entry.summary.includes(reference))).toBe(true);
    await service.close();
  });

  it("atomically persists a procedure resolution while paused and restores no active response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:00:00.000Z"));
    const repository = new MemoryRepository();
    const workspaceId = "paused-procedure-resolution-jury";
    const actor = "resolution-operator";
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 1_000,
      telemetryCheckpointIntervalMs: 60_000,
    });
    let state = await service.getSnapshot(workspaceId);
    const interstation = NATIVE_INTERSTATIONS.find((candidate) => candidate.lineCode === "RER_A");
    expect(interstation).toBeDefined();

    const created = await service.command(workspaceId, actor, {
      commandId: "CMD-PAUSED-RESOLUTION-CREATE",
      type: "create_native_incident",
      expectedStateRevision: state.stateRevision,
      payload: {
        lineCode: "RER_A",
        target: { type: "interstation", id: interstation.id },
        effect: "block-interstation",
        title: "Detection loss on an interstation",
        summary: "Protect the interstation, recover it under supervision, then close the event.",
        type: "infrastructure",
        severity: "high",
      },
    });
    const incident = created.result.incident;
    state = created.snapshot;
    expect(state.operationalResponse.incidentCases.find((item) => item.incidentId === incident.id))
      .toMatchObject({ status: "active", resolvedAt: null });
    expect(state.operationalResponse.continuityMeasures.some((item) =>
      item.incidentId === incident.id && item.status === "proposed"
    )).toBe(true);

    const procedure = getOperationalProcedure("ICC-PROC-INTERSTATION-BLOCK-001");
    const recoveryStep = procedure.steps.find((step) => step.phase === "recover" && step.mandatory);
    const verifyStep = procedure.steps.find((step) => step.phase === "verify" && step.mandatory);
    const closeStep = procedure.steps.find((step) => step.phase === "close" && step.mandatory);
    expect(recoveryStep).toBeDefined();
    expect(verifyStep).toBeDefined();
    expect(closeStep).toMatchObject({ capability: "resolve-simulation" });

    let sequence = 0;
    for (const step of procedure.steps.filter((candidate) =>
      candidate.mandatory && candidate.order <= recoveryStep.order
    )) {
      sequence += 1;
      const applied = await service.command(workspaceId, actor, {
        commandId: `CMD-PAUSED-RESOLUTION-STEP-${String(sequence).padStart(2, "0")}`,
        type: "apply_procedure_step",
        expectedStateRevision: state.stateRevision,
        payload: {
          incidentId: incident.id,
          procedureId: procedure.procedureId,
          procedureRevision: procedure.revision,
          procedureContentHash: procedure.contentHash,
          stepId: step.stepId,
          expectedDecisionRevision: state.native.decisionRevision,
        },
      });
      state = applied.snapshot;
    }

    await vi.advanceTimersByTimeAsync(procedure.returnToNormal.observationWindowSeconds * 1_000);
    state = await service.getSnapshot(workspaceId);
    const paused = await service.command(workspaceId, actor, {
      commandId: "CMD-PAUSED-RESOLUTION-SPEED-0",
      type: "set_speed",
      expectedStateRevision: state.stateRevision,
      payload: { speed: 0 },
    });
    state = paused.snapshot;
    expect(state.native.speed).toBe(0);

    const verified = await service.command(workspaceId, actor, {
      commandId: "CMD-PAUSED-RESOLUTION-VERIFY",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: incident.id,
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        procedureContentHash: procedure.contentHash,
        stepId: verifyStep.stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    state = verified.snapshot;
    const closeEnvelope = {
      commandId: "CMD-PAUSED-RESOLUTION-CLOSE",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: incident.id,
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        procedureContentHash: procedure.contentHash,
        stepId: closeStep.stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    };
    const closed = await service.command(workspaceId, actor, closeEnvelope);
    const closedCase = closed.snapshot.operationalResponse.incidentCases.find(
      (item) => item.incidentId === incident.id,
    );
    const closedMeasures = closed.snapshot.operationalResponse.continuityMeasures.filter(
      (item) => item.incidentId === incident.id,
    );
    expect(closed.snapshot.native).toMatchObject({ speed: 0 });
    expect(closed.snapshot.native.incidents.find((item) => item.id === incident.id))
      .toMatchObject({ status: "resolved", restrictionMode: "none" });
    expect(closedCase).toMatchObject({ status: "resolved", resolvedAt: closed.snapshot.native.timestamp });
    expect(closedMeasures.length).toBeGreaterThan(0);
    expect(closedMeasures.every((item) => item.status === "completed")).toBe(true);
    expect(closed.snapshot.operationalResponse.dispatches.filter((item) => item.incidentId === incident.id))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "completed" })]));
    expect(closed.result).toMatchObject({
      capability: "resolve-simulation",
      decisionRevision: closed.snapshot.native.decisionRevision,
      normalStateVerification: { status: "passed", incidentResolved: true },
    });
    await service.close();

    const restarted = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 60_000,
    });
    const restored = await restarted.getSnapshot(workspaceId);
    expect(restored.stateRevision).toBe(closed.snapshot.stateRevision);
    expect(restored.operationalResponse.revision).toBe(closed.snapshot.operationalResponse.revision);
    expect(restored.operationalResponse.incidentCases.find((item) => item.incidentId === incident.id))
      .toEqual(closedCase);
    expect(restored.operationalResponse.continuityMeasures.filter((item) => item.incidentId === incident.id))
      .toEqual(closedMeasures);
    expect(restored.operationalResponse.continuityMeasures.some((item) =>
      item.incidentId === incident.id && item.status === "active"
    )).toBe(false);

    const replayed = await restarted.command(workspaceId, actor, closeEnvelope);
    expect(replayed).toEqual(closed);
    expect((await restarted.getSnapshot(workspaceId)).stateRevision).toBe(restored.stateRevision);
    await restarted.close();
  }, 20_000);

  it("applies and restores the mandatory split service for a station works closure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T06:30:00.000Z"));
    const repository = new MemoryRepository();
    const workspaceId = "station-works-split-service-jury";
    const actor = "station-works-operator";
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 1_000,
    });
    let state = await service.getSnapshot(workspaceId);
    const station = NATIVE_STATIONS.find((candidate) =>
      candidate.lines.includes("RER_A") &&
      NATIVE_INTERSTATIONS.filter((interstation) =>
        interstation.lineCode === "RER_A" &&
        (interstation.fromStationCode === candidate.code || interstation.toStationCode === candidate.code)
      ).length === 2
    );
    expect(station).toBeDefined();

    const created = await service.command(workspaceId, actor, {
      commandId: "CMD-STATION-WORKS-CREATE",
      type: "create_native_incident",
      expectedStateRevision: state.stateRevision,
      payload: {
        lineCode: "RER_A",
        target: { type: "station", id: station.code },
        effect: "station-closure",
        title: "Station closure for engineering works",
        summary: "Exclude the station and operate a split provisional service on both open flanks.",
        type: "works",
        severity: "high",
      },
    });
    const incident = created.result.incident;
    expect(incident.incidentCode).toBe("ICC-INC-WRK-STA-CLS-001");
    expect(incident.affectedInterstationIds).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    state = await service.getSnapshot(workspaceId);
    const procedure = getOperationalProcedure("ICC-PROC-STATION-WORKS-CLOSURE-001");
    const turnbackStep = procedure.steps.find((step) => step.capability === "activate-turnbacks");
    const provisionalStep = procedure.steps.find((step) => step.capability === "activate-provisional-service");
    expect(turnbackStep).toMatchObject({ order: 32, mandatory: true });
    expect(provisionalStep).toMatchObject({ order: 33, mandatory: true });
    const responseCase = state.operationalResponse.incidentCases.find((item) => item.incidentId === incident.id);
    expect(responseCase).toMatchObject({
      protectedStationIds: [station.code],
      continuityBoundaryStationIds: [expect.any(String), expect.any(String)],
    });
    expect(state.operationalResponse.continuityMeasures.filter((measure) =>
      measure.incidentId === incident.id && ["turnback", "provisional-service"].includes(measure.kind)
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "turnback", status: "proposed" }),
      expect.objectContaining({ kind: "provisional-service", status: "proposed" }),
    ]));

    state = await applyMandatoryBefore({
      service,
      workspaceId,
      actor,
      state,
      incident,
      procedure,
      order: turnbackStep.order,
      commandPrefix: "CMD-STATION-WORKS-PREQ",
    });
    const turnbacks = await service.command(workspaceId, actor, {
      commandId: "CMD-STATION-WORKS-TURNBACKS",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: incident.id,
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        procedureContentHash: procedure.contentHash,
        stepId: turnbackStep.stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    state = turnbacks.snapshot;
    expect(turnbacks.result.operationalReceipt).toMatchObject({
      capability: "activate-turnbacks",
      operatorId: actor,
      affectedEntityIds: expect.arrayContaining(responseCase.continuityBoundaryStationIds),
    });
    const provisional = await service.command(workspaceId, actor, {
      commandId: "CMD-STATION-WORKS-PROVISIONAL",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: incident.id,
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        procedureContentHash: procedure.contentHash,
        stepId: provisionalStep.stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    expect(provisional.result.operationalReceipt).toMatchObject({
      capability: "activate-provisional-service",
      operatorId: actor,
      affectedEntityIds: expect.any(Array),
    });
    const activeMeasures = provisional.snapshot.operationalResponse.continuityMeasures.filter((measure) =>
      measure.incidentId === incident.id && ["turnback", "provisional-service"].includes(measure.kind)
    );
    expect(activeMeasures).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "turnback", status: "active", receiptId: expect.any(String) }),
      expect.objectContaining({
        kind: "provisional-service",
        status: "active",
        receiptId: expect.any(String),
        plan: expect.objectContaining({ serviceSegments: [expect.any(Object), expect.any(Object)] }),
      }),
    ]));
    await service.close();

    const restarted = await createOperationsService({ repository, tickIntervalMs: 60_000 });
    const restored = await restarted.getSnapshot(workspaceId);
    expect(restored.operationalResponse.continuityMeasures.filter((measure) =>
      measure.incidentId === incident.id && ["turnback", "provisional-service"].includes(measure.kind)
    )).toEqual(activeMeasures);
    expect(restored.procedureExecutions.find((execution) => execution.incidentId === incident.id))
      .toMatchObject({
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        completedStepIds: expect.arrayContaining([turnbackStep.stepId, provisionalStep.stepId]),
      });
    await restarted.close();
  }, 15_000);

  it("persists and audits a direct operator train insertion selected by line, station, and direction", async () => {
    const repository = new MemoryRepository();
    const workspaceId = "manual-train-insertion-jury";
    const service = await createOperationsService({ repository, tickIntervalMs: 60_000 });
    const initial = await service.getSnapshot(workspaceId);
    const manualOptions = nativeOperatorTrainInsertionOptions("RER_A");
    const interiorOption = manualOptions.find((option) =>
      manualOptions.some((candidate) =>
        candidate.stationId === option.stationId && candidate.direction === -option.direction
      )
    );
    expect(interiorOption).toBeDefined();

    const inserted = await service.command(workspaceId, "jury-operator", {
      commandId: "CMD-MANUAL-INSERT-001",
      type: "insert_native_train",
      expectedStateRevision: initial.stateRevision,
      payload: {
        lineCode: "RER_A",
        stationId: interiorOption.stationId,
        direction: interiorOption.direction,
      },
    });

    expect(inserted.result.insertion).toMatchObject({
      stationId: interiorOption.stationId,
      direction: interiorOption.direction,
      capacityDeltaPassengers: 1_600,
      train: {
        lineCode: "RER_A",
        originStationCode: interiorOption.stationId,
        destinationStationCode: interiorOption.destinationStationId,
        location: { type: "station", id: interiorOption.stationId },
        status: "dwelling",
      },
    });
    expect(inserted.snapshot.native.trains).toHaveLength(initial.native.trains.length + 1);
    expect(inserted.snapshot.shift.logs.at(-1)).toMatchObject({
      category: "operator-action",
      eventType: "train-inserted",
      actor: "operator",
      entityIds: expect.arrayContaining([
        inserted.result.insertion.train.id,
        interiorOption.stationId,
      ]),
    });

    await service.close();
    const restarted = await createOperationsService({ repository, tickIntervalMs: 60_000 });
    const restored = await restarted.getSnapshot(workspaceId);
    expect(restored.native.trains).toContainEqual(expect.objectContaining({
      id: inserted.result.insertion.train.id,
      lineCode: "RER_A",
      location: { type: "station", id: interiorOption.stationId },
    }));
    expect(restored.shift.logs).toContainEqual(expect.objectContaining({
      eventType: "train-inserted",
      entityIds: expect.arrayContaining([inserted.result.insertion.train.id]),
    }));
    await restarted.close();
  });

  it("persists and audits a manual same-line shuttle with fixed speed and capacity", async () => {
    const repository = new MemoryRepository();
    const workspaceId = "manual-shuttle-jury";
    const service = await createOperationsService({ repository, tickIntervalMs: 60_000 });
    const initial = await service.getSnapshot(workspaceId);
    const edge = NATIVE_INTERSTATIONS.find((candidate) => candidate.lineCode === "M4");
    expect(edge).toBeDefined();

    const ordered = await service.command(workspaceId, "jury-operator", {
      commandId: "CMD-MANUAL-SHUTTLE-001",
      type: "insert_native_shuttle",
      expectedStateRevision: initial.stateRevision,
      payload: {
        lineCode: "M4",
        departureStationId: edge.fromStationCode,
        arrivalStationId: edge.toStationCode,
      },
    });

    expect(ordered.result.insertion).toMatchObject({
      capacityDeltaPassengers: 100,
      shuttle: {
        lineCode: "M4",
        departureStationId: edge.fromStationCode,
        arrivalStationId: edge.toStationCode,
        nominalSpeedKmh: 15,
        capacityPassengers: 100,
        location: { type: "station", id: edge.fromStationCode },
        status: "dwelling",
      },
    });
    expect(ordered.snapshot.native.shuttles).toHaveLength(1);
    expect(ordered.snapshot.shift.logs.at(-1)).toMatchObject({
      category: "operator-action",
      eventType: "shuttle-ordered",
      actor: "operator",
      title: expect.stringContaining(ordered.result.insertion.shuttle.id),
    });

    await service.close();
    const restarted = await createOperationsService({ repository, tickIntervalMs: 60_000 });
    const restored = await restarted.getSnapshot(workspaceId);
    expect(restored.native.shuttles).toContainEqual(expect.objectContaining({
      id: ordered.result.insertion.shuttle.id,
      nominalSpeedKmh: 15,
      capacityPassengers: 100,
      location: { type: "station", id: edge.fromStationCode },
    }));
    expect(restored.shift.logs).toContainEqual(expect.objectContaining({
      eventType: "shuttle-ordered",
      title: expect.stringContaining(ordered.result.insertion.shuttle.id),
    }));
    await restarted.close();
  });

  it("projects a native line-communication incident into SCADA and maintenance dispatch state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T07:00:00.000Z"));
    const repository = new MemoryRepository();
    const service = await createOperationsService({ repository, now: () => Date.now(), tickIntervalMs: 1_000 });
    const workspaceId = "scada-response-jury";
    const initial = await service.getSnapshot(workspaceId);
    const created = await service.command(workspaceId, "jury-session", {
      commandId: "CMD-OPRESP-SCADA-001",
      type: "create_native_incident",
      expectedStateRevision: initial.stateRevision,
      payload: {
        lineCode: "RER_A",
        target: { type: "line", id: "RER_A" },
        effect: "communication-loss",
        title: "SCADA communication loss",
        summary: "The line has no fresh supervisory heartbeat.",
        type: "communications",
        severity: "critical",
      },
    });
    expect(created.result.incident.incidentCode).toBe("ICC-INC-COM-LIN-LOS-001");
    await vi.advanceTimersByTimeAsync(1_000);
    const projected = await service.getSnapshot(workspaceId);
    expect(projected.operationalResponse.lineScada.find((item) => item.lineCode === "RER_A"))
      .toMatchObject({ status: "unavailable", communicationIncidentId: created.result.incident.id });
    expect(projected.operationalResponse.dispatches).toContainEqual(expect.objectContaining({
      incidentId: created.result.incident.id,
      lineCode: "RER_A",
      targetType: "line",
      targetId: "RER_A",
      status: "proposed",
      plan: expect.objectContaining({
        team: "communications",
        estimatedDuration: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
        eta: expect.objectContaining({ expectedAt: expect.any(Number) }),
        basisProcedureId: "ICC-PROC-SCADA-COMMUNICATION-001",
      }),
    }));
    expect(projected.operationalResponse.incidentCases.find((item) =>
      item.incidentId === created.result.incident.id
    )).toMatchObject({
      predictedDuration: {
        basis: "mandatory-procedure-steps",
        nominalSeconds: 1_260,
        procedureId: "ICC-PROC-SCADA-COMMUNICATION-001",
      },
      milestones: expect.arrayContaining([
        expect.objectContaining({
          code: "passenger-information",
          status: "due",
          dueBasis: "predicted-duration",
        }),
      ]),
    });
    await service.close();
  });

  it("records a non-blocking sequence advisory and executes reviewed maintenance dispatch steps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T07:30:00.000Z"));
    const repository = new MemoryRepository();
    const service = await createOperationsService({ repository, now: () => Date.now(), tickIntervalMs: 60_000 });

    const infrastructureWorkspace = "maintenance-infrastructure-jury";
    let infrastructureState = await service.getSnapshot(infrastructureWorkspace);
    const infrastructureScenario = await service.command(infrastructureWorkspace, "operator-infrastructure", {
      commandId: "CMD-MAINT-INFRA-SCENARIO",
      type: "activate_native_scenario",
      expectedStateRevision: infrastructureState.stateRevision,
      payload: { scenarioId: "rer-a-signal" },
    });
    infrastructureState = infrastructureScenario.snapshot;
    const infrastructureIncident = infrastructureState.native.incidents.find((item) => item.status === "active");
    const infrastructureProcedure = getOperationalProcedure("ICC-PROC-INTERSTATION-BLOCK-001");
    const infrastructureDispatchStep = infrastructureProcedure.steps.find((step) => step.capability === "dispatch-maintenance");
    expect(infrastructureDispatchStep).toMatchObject({
      order: 35,
      mandatory: false,
      durationRangeSeconds: { minSeconds: 600, nominalSeconds: 1_200, maxSeconds: 3_600 },
    });
    const infrastructureDispatched = await service.command(infrastructureWorkspace, "operator-infrastructure", {
      commandId: "CMD-MAINT-INFRA-EARLY",
      type: "apply_procedure_step",
      expectedStateRevision: infrastructureState.stateRevision,
      payload: {
        incidentId: infrastructureIncident.id,
        procedureId: infrastructureProcedure.procedureId,
        procedureRevision: infrastructureProcedure.revision,
        procedureContentHash: infrastructureProcedure.contentHash,
        stepId: infrastructureDispatchStep.stepId,
        expectedDecisionRevision: infrastructureState.native.decisionRevision,
      },
    });
    expect(infrastructureDispatched.result).toMatchObject({
      status: "applied_to_simulation",
      capability: "dispatch-maintenance",
      sequenceAdvisory: {
        outOfSequence: true,
        missingPreviousStepIds: expect.any(Array),
        operatorOverrideRecorded: true,
      },
      operationalReceipt: {
        incidentId: infrastructureIncident.id,
        capability: "dispatch-maintenance",
        operatorId: "operator-infrastructure",
      },
    });
    expect(infrastructureDispatched.snapshot.operationalResponse.dispatches.find((item) =>
      item.incidentId === infrastructureIncident.id
    )).toMatchObject({
      status: "dispatched",
      plan: {
        team: "infrastructure",
        estimatedDuration: { minSeconds: 600, nominalSeconds: 1_200, maxSeconds: 3_600 },
      },
    });

    const rollingWorkspace = "maintenance-rolling-jury";
    let rollingState = await service.getSnapshot(rollingWorkspace);
    const nominal = await service.command(rollingWorkspace, "operator-rolling", {
      commandId: "CMD-MAINT-ROLLING-NOMINAL",
      type: "activate_native_scenario",
      expectedStateRevision: rollingState.stateRevision,
      payload: { scenarioId: "nominal" },
    });
    rollingState = nominal.snapshot;
    const train = rollingState.native.trains[0];
    const created = await service.command(rollingWorkspace, "operator-rolling", {
      commandId: "CMD-MAINT-ROLLING-CREATE",
      type: "create_native_incident",
      expectedStateRevision: rollingState.stateRevision,
      payload: {
        lineCode: train.lineCode,
        target: { type: "train", id: train.id },
        effect: "stop-train",
        title: "Rolling-stock failure",
        summary: "The train is immobilised and requires a technical intervention.",
        type: "rolling-stock",
        severity: "high",
      },
    });
    rollingState = created.snapshot;
    const rollingIncident = created.result.incident;
    const rollingProcedure = getOperationalProcedure("ICC-PROC-RST-TRAIN-001");
    const rollingDispatchStep = rollingProcedure.steps.find((step) => step.capability === "dispatch-maintenance");
    rollingState = await applyMandatoryBefore({
      service, workspaceId: rollingWorkspace, actor: "operator-rolling",
      state: rollingState, incident: rollingIncident, procedure: rollingProcedure,
      order: rollingDispatchStep.order, commandPrefix: "CMD-MAINT-ROLLING-PREQ",
    });
    const rollingDispatched = await service.command(rollingWorkspace, "operator-rolling", {
      commandId: "CMD-MAINT-ROLLING-DISPATCH",
      type: "apply_procedure_step",
      expectedStateRevision: rollingState.stateRevision,
      payload: {
        incidentId: rollingIncident.id,
        procedureId: rollingProcedure.procedureId,
        procedureRevision: rollingProcedure.revision,
        procedureContentHash: rollingProcedure.contentHash,
        stepId: rollingDispatchStep.stepId,
        expectedDecisionRevision: rollingState.native.decisionRevision,
      },
    });
    expect(rollingDispatched.result.operationalReceipt).toMatchObject({
      incidentId: rollingIncident.id,
      capability: "dispatch-maintenance",
      operatorId: "operator-rolling",
    });
    expect(rollingDispatched.snapshot.operationalResponse.dispatches.find((item) =>
      item.incidentId === rollingIncident.id
    )).toMatchObject({
      status: "dispatched",
      plan: {
        team: "rolling-stock",
        estimatedDuration: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
      },
    });
    await service.close();
  });

  it("proposes strict-threshold measures and applies them only through an approved procedure step", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T08:00:00.000Z"));
    const repository = new MemoryRepository();
    const workspaceId = "operational-response-jury";
    const service = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 1_000,
      telemetryCheckpointIntervalMs: 60_000,
    });
    let state = await service.getSnapshot(workspaceId);
    expect(state.operationalResponse.lineScada).toHaveLength(21);

    const activated = await service.command(workspaceId, "jury-session", {
      commandId: "CMD-OPRESP-SCENARIO-01",
      type: "activate_native_scenario",
      expectedStateRevision: state.stateRevision,
      payload: { scenarioId: "m13-works" },
    });
    state = activated.snapshot;
    const incident = state.native.incidents.find((item) => item.status === "active");
    expect(incident).toBeTruthy();

    const accelerated = await service.command(workspaceId, "jury-session", {
      commandId: "CMD-OPRESP-SPEED-04",
      type: "set_speed",
      expectedStateRevision: state.stateRevision,
      payload: { speed: 4 },
    });
    state = accelerated.snapshot;
    const thresholdStartedAt = state.native.timestamp;

    await vi.advanceTimersByTimeAsync(225_000);
    state = await service.getSnapshot(workspaceId);
    expect(state.native.timestamp - thresholdStartedAt).toBe(900_000);
    const exactThresholdCase = state.operationalResponse.incidentCases.find(
      (item) => item.incidentId === incident.id,
    );
    expect(exactThresholdCase.milestones.find((item) => item.code === "passenger-information").status)
      .toBe("pending");

    await vi.advanceTimersByTimeAsync(1_000);
    state = await service.getSnapshot(workspaceId);
    expect(state.operationalResponse.incidentCases.find((item) => item.incidentId === incident.id)
      .milestones.find((item) => item.code === "passenger-information").status).toBe("due");
    expect(state.operationalResponse.continuityMeasures.find(
      (item) => item.incidentId === incident.id && item.kind === "passenger-information",
    )).toMatchObject({ status: "proposed" });

    const procedure = getOperationalProcedure("ICC-PROC-WORKS-HANDBACK-001");
    const prerequisiteSteps = procedure.steps.filter((step) => step.mandatory && step.order < 41);
    let commandSequence = 0;
    for (const step of prerequisiteSteps) {
      commandSequence += 1;
      const applied = await service.command(workspaceId, "jury-session", {
        commandId: `CMD-OPRESP-STEP-${String(commandSequence).padStart(3, "0")}`,
        type: "apply_procedure_step",
        expectedStateRevision: state.stateRevision,
        payload: {
          incidentId: incident.id,
          procedureId: procedure.procedureId,
          procedureRevision: procedure.revision,
          procedureContentHash: procedure.contentHash,
          stepId: step.stepId,
          expectedDecisionRevision: state.native.decisionRevision,
          ...(step.title === "Record the applicable clearance"
            ? { operatorEvidenceReference: "HAND-M13-THRESHOLD-041" }
            : {}),
        },
      });
      state = applied.snapshot;
    }
    const informationStep = procedure.steps.find(
      (step) => step.capability === "publish-passenger-information",
    );
    const approved = await service.command(workspaceId, "jury-session", {
      commandId: "CMD-OPRESP-INFO-001",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: incident.id,
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        procedureContentHash: procedure.contentHash,
        stepId: informationStep.stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    expect(approved.result.operationalReceipt).toMatchObject({
      incidentId: incident.id,
      capability: "publish-passenger-information",
      operatorId: "jury-session",
    });
    expect(approved.snapshot.operationalResponse.continuityMeasures.find(
      (item) => item.incidentId === incident.id && item.kind === "passenger-information",
    )).toMatchObject({ status: "active", approvedBy: "jury-session" });

    state = approved.snapshot;
    const insertionStep = procedure.steps.find((step) => step.capability === "insert-train");
    const inserted = await service.command(workspaceId, "jury-session", {
      commandId: "CMD-OPRESP-INSERT-001",
      type: "apply_procedure_step",
      expectedStateRevision: state.stateRevision,
      payload: {
        incidentId: incident.id,
        procedureId: procedure.procedureId,
        procedureRevision: procedure.revision,
        procedureContentHash: procedure.contentHash,
        stepId: insertionStep.stepId,
        expectedDecisionRevision: state.native.decisionRevision,
      },
    });
    expect(inserted.result.nativeCapabilityReceipt).toMatchObject({
      stationId: expect.any(String),
      direction: expect.any(Number),
      capacityDeltaPassengers: 700,
      train: { lineCode: "M13", location: { type: "station" } },
    });
    expect([-1, 1]).toContain(inserted.result.nativeCapabilityReceipt.direction);
    expect(inserted.snapshot.native.trains).toHaveLength(state.native.trains.length + 1);
    const insertedMeasure = inserted.snapshot.operationalResponse.continuityMeasures.find(
      (item) => item.incidentId === incident.id && item.kind === "train-insertion",
    );
    expect(insertedMeasure).toMatchObject({
      status: "active",
      stationIds: [inserted.result.nativeCapabilityReceipt.stationId],
      plan: {
        kind: "train-insertion",
        stationId: inserted.result.nativeCapabilityReceipt.stationId,
        direction: inserted.result.nativeCapabilityReceipt.direction,
        capacityDeltaPassengers: 700,
      },
    });

    await service.close();
    const restarted = await createOperationsService({
      repository,
      now: () => Date.now(),
      tickIntervalMs: 60_000,
    });
    const restored = await restarted.getSnapshot(workspaceId);
    expect(restored.operationalResponse.receipts).toEqual(expect.arrayContaining([
      approved.result.operationalReceipt,
      inserted.result.operationalReceipt,
    ]));
    expect(restored.native.trains).toContainEqual(expect.objectContaining({
      id: inserted.result.nativeCapabilityReceipt.train.id,
      lineCode: "M13",
    }));
    expect(restored.operationalResponse.continuityMeasures.find(
      (item) => item.measureId === insertedMeasure.measureId,
    )?.plan).toEqual(insertedMeasure.plan);
    await restarted.close();
  }, 15_000);

  it("migrates a v1 runtime without the new aggregate to a nominal 21-line state", async () => {
    const repository = new MemoryRepository();
    const workspaceId = "legacy-runtime-jury";
    const first = await createOperationsService({ repository, tickIntervalMs: 60_000 });
    await first.getSnapshot(workspaceId);
    await first.close();
    const legacy = repository.runtime.get(workspaceId);
    delete legacy.state.operationalResponse;
    delete legacy.state.baseline.operationalResponse;

    const migratedService = await createOperationsService({ repository, tickIntervalMs: 60_000 });
    const migrated = await migratedService.getSnapshot(workspaceId);
    expect(migrated.operationalResponse).toMatchObject({
      schema: "paris-icc-operational-response-v1",
      revision: 1,
      incidentCases: [],
    });
    expect(migrated.operationalResponse.lineScada).toHaveLength(21);
    await migratedService.close();
  });
});
