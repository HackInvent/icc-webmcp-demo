import { randomUUID } from "node:crypto";
import { createCommandRequestFingerprint } from "./operations-repository.mjs";
import {
  createNativeNetworkController,
  NativeSimulationError,
  type NativeIncidentInput,
  type NativeNetworkController,
  type NativeSimulationSnapshot,
  type NativeSimulationSpeed,
} from "../src/rail/nativeSimulation.ts";
import type { SimulationState } from "../src/rail/domain.ts";
import type { SimulatorIncidentDraft } from "../src/rail/simulatorIncident.ts";
import {
  addDemoIncident,
  advanceSimulation,
  applyRegulation,
  assertSnapshotInvariants,
  closeCircuit,
  createSimulationState,
  reopenCircuit,
  schedulePowerIncident,
  setPowerStatus,
  setSimulationSpeed,
  updateIncidentStatus,
} from "../src/rail/simulation.ts";
import { createSampleSchedulePlan } from "../src/schedules/sample.ts";
import { ScheduleWorkspaceStore } from "../src/schedules/store.ts";
import { ScheduleCsvError } from "../src/schedules/csv.ts";
import { ScheduleWorkspaceError } from "../src/schedules/types.ts";
import type {
  Actor,
  ScheduleChangeRequest,
  SchedulePlan,
  ScheduleWorkspaceState,
} from "../src/schedules/types.ts";
import {
  OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH,
  operatorEvidenceReferenceRequirement,
} from "../src/procedures/index.ts";
import {
  ProcedureWorkspaceError,
  createProcedureWorkspace,
  getProcedureRevision,
  listActiveProcedures,
  migrateProcedureWorkspace,
  projectProcedureWorkspace,
  publishProcedureStepPatch,
} from "../src/procedures/registry.ts";
import {
  OperationalResponseError,
  advanceOperationalResponse,
  applyOperationalResponseCapability,
  createOperationalResponseState,
  migrateOperationalResponseState,
  type OperationalResponseCapability,
} from "../src/operations/operationalResponse.ts";
import {
  createShiftWorkspace,
  recordCommandInShift,
  recordIncidentTransitions,
  sanitizeShiftReportHtml,
} from "./shift-report.mjs";

export const OPERATIONS_RUNTIME_SCHEMA = "paris-icc-operations-runtime-v1";
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class OperationsError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "OperationsError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return structuredClone(value);
}

function commandObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationsError(400, "invalid_command", "The command must be a JSON object.");
  }
  return value;
}

function requiredString(value, label, maximum = 128) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new OperationsError(400, "invalid_command", label + " must be a short non-empty string.");
  }
  return value.trim();
}

function optionalBoundedString(value, label, maximum) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new OperationsError(
      400,
      "invalid_command",
      `${label} must be a string of at most ${maximum} characters.`,
    );
  }
  return value;
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OperationsError(
      400,
      "invalid_command",
      "expectedStateRevision must be a non-negative integer.",
    );
  }
  return value;
}

function requiredEnum(value, label, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new OperationsError(
      400,
      "invalid_command",
      `${label} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function mapExecutionError(error) {
  if (error instanceof OperationsError) return error;
  if (error instanceof ScheduleWorkspaceError) {
    return new OperationsError(
      error.code === "INVALID_REQUEST" ? 400 : 409,
      error.code,
      error.message,
    );
  }
  if (error instanceof ScheduleCsvError) {
    return new OperationsError(400, "INVALID_SCHEDULE", error.message);
  }
  if (error instanceof OperationalResponseError) {
    return new OperationsError(409, error.code.toLowerCase(), error.message);
  }
  if (error instanceof ProcedureWorkspaceError) {
    const status = error.code === "invalid_input"
      ? 400
      : error.code === "procedure_not_found" || error.code === "step_not_found"
        ? 404
        : 409;
    return new OperationsError(status, error.code, error.message, error.details ?? {});
  }
  if (error instanceof NativeSimulationError) {
    return new OperationsError(
      error.code === "UNKNOWN_INCIDENT" ? 404 : 400,
      error.code.toLowerCase(),
      error.message,
    );
  }
  return error;
}

function procedureCommand(step) {
  const capability = step?.capability;
  const command = typeof capability === "string"
    ? capability
    : capability && typeof capability === "object"
      ? capability.command
      : null;
  return command === "acknowledge" ||
    command === "protect-and-hold" ||
    command === "degraded-operation" ||
    command === "resolve-simulation" ||
    command === "publish-passenger-information" ||
    command === "protect-connections" ||
    command === "dispatch-maintenance" ||
    command === "activate-provisional-service" ||
    command === "activate-turnbacks" ||
    command === "activate-shuttle-bus" ||
    command === "insert-train" ||
    command === "start-towing"
    ? command
    : null;
}

function makeScheduleStore(snapshot) {
  const store = new ScheduleWorkspaceStore();
  if (snapshot) store.restoreSnapshot(snapshot);
  else store.loadPlan(createSampleSchedulePlan());
  return store;
}

function createCurrentShift(nativeSnapshot, detailedState, timestamp) {
  return createShiftWorkspace({
    recordedAt: timestamp,
    operationalTime: nativeSnapshot.timestamp,
    nativeIncidents: nativeSnapshot.incidents,
    detailedIncidents: detailedState.snapshot.incidents,
  });
}

function activeProcedureCatalogue(runtime) {
  return listActiveProcedures(runtime.procedureWorkspace);
}

function freshOperationalResponse(nativeSnapshot, procedureWorkspace = createProcedureWorkspace()) {
  return advanceOperationalResponse(
    createOperationalResponseState(nativeSnapshot.timestamp),
    nativeSnapshot.incidents,
    nativeSnapshot.trains,
    nativeSnapshot.timestamp,
    listActiveProcedures(procedureWorkspace),
  ).state;
}

function synchronizeOperationalResponse(runtime) {
  const snapshot = runtime.nativeController.getSnapshot();
  runtime.operationalResponse = advanceOperationalResponse(
    runtime.operationalResponse,
    snapshot.incidents,
    snapshot.trains,
    snapshot.timestamp,
    activeProcedureCatalogue(runtime),
  ).state;
}

const COMMANDS_REQUIRING_OPERATIONAL_RESPONSE_SYNC = new Set([
  "create_native_incident",
  "insert_native_train",
  "apply_native_response",
  "apply_procedure_step",
]);

function synchronizeOperationalResponseAfterCommand(runtime, type) {
  if (!COMMANDS_REQUIRING_OPERATIONAL_RESPONSE_SYNC.has(type)) return;
  synchronizeOperationalResponse(runtime);
}

function publicState(runtime) {
  const referencedVersions = runtime.procedureExecutions.map((execution) => ({
    procedureId: execution.procedureId,
    revision: execution.procedureRevision,
  }));
  return {
    schema: OPERATIONS_RUNTIME_SCHEMA,
    runId: runtime.state.runId,
    stateRevision: runtime.state.stateRevision,
    streamRevision: runtime.state.streamRevision,
    updatedAt: runtime.state.updatedAt,
    native: clone(runtime.nativeController.getSnapshot()),
    detailed: clone(runtime.detailed),
    schedules: clone(runtime.scheduleStore.getSnapshot()),
    operationalResponse: clone(runtime.operationalResponse),
    procedureExecutions: clone(runtime.procedureExecutions),
    procedureCatalogue: clone(projectProcedureWorkspace(
      runtime.procedureWorkspace,
      referencedVersions,
    )),
    shift: clone(runtime.shift),
  };
}

function persistedState(runtime) {
  return {
    ...publicState(runtime),
    procedureWorkspace: clone(runtime.procedureWorkspace),
    baseline: clone(runtime.baseline),
  };
}

function restoreRuntime(runtime, persisted) {
  runtime.state = {
    runId: persisted.runId,
    stateRevision: persisted.stateRevision,
    streamRevision: persisted.streamRevision ?? persisted.stateRevision,
    updatedAt: persisted.updatedAt,
  };
  runtime.nativeController = createNativeNetworkController({
    restoredSnapshot: persisted.native,
    baselineSnapshot: persisted.baseline?.native ?? persisted.native,
  });
  assertSnapshotInvariants(persisted.detailed.snapshot);
  runtime.detailed = clone(persisted.detailed);
  runtime.scheduleStore = makeScheduleStore(persisted.schedules);
  runtime.operationalResponse = migrateOperationalResponseState(
    persisted.operationalResponse,
    persisted.native.timestamp,
  );
  runtime.procedureExecutions = clone(persisted.procedureExecutions ?? []);
  runtime.procedureWorkspace = migrateProcedureWorkspace(persisted.procedureWorkspace);
  runtime.shift = clone(persisted.shift ?? createCurrentShift(
    persisted.native,
    persisted.detailed,
    Date.parse(persisted.updatedAt) || Date.now(),
  ));
  runtime.baseline = clone(persisted.baseline ?? {
    native: persisted.native,
    detailed: persisted.detailed,
    schedules: persisted.schedules,
    operationalResponse: migrateOperationalResponseState(undefined, persisted.native.timestamp),
  });
  runtime.baseline.operationalResponse = migrateOperationalResponseState(
    runtime.baseline.operationalResponse,
    runtime.baseline.native.timestamp,
  );
}

function hydrateRuntime(workspaceId, persisted, lastCheckpointAt) {
  if (persisted?.schema !== OPERATIONS_RUNTIME_SCHEMA) {
    throw new OperationsError(
      500,
      "unsupported_runtime_schema",
      "The persisted operations runtime schema is not supported.",
    );
  }
  const nativeController = createNativeNetworkController({
    restoredSnapshot: persisted.native,
    baselineSnapshot: persisted.baseline?.native ?? persisted.native,
  });
  assertSnapshotInvariants(persisted.detailed.snapshot);
  const scheduleStore = makeScheduleStore(persisted.schedules);
  const operationalResponse = migrateOperationalResponseState(
    persisted.operationalResponse,
    persisted.native.timestamp,
  );
  const procedureWorkspace = migrateProcedureWorkspace(persisted.procedureWorkspace);
  return {
    workspaceId,
    state: {
      runId: persisted.runId,
      stateRevision: persisted.stateRevision,
      streamRevision: persisted.streamRevision ?? persisted.stateRevision,
      updatedAt: persisted.updatedAt,
    },
    nativeController,
    detailed: clone(persisted.detailed),
    scheduleStore,
    operationalResponse,
    procedureExecutions: clone(persisted.procedureExecutions ?? []),
    procedureWorkspace,
    shift: clone(persisted.shift ?? createCurrentShift(
      persisted.native,
      persisted.detailed,
      Number.isSafeInteger(lastCheckpointAt) ? lastCheckpointAt : Date.now(),
    )),
    baseline: clone({
      ...(persisted.baseline ?? {
        native: persisted.native,
        detailed: persisted.detailed,
        schedules: persisted.schedules,
      }),
      operationalResponse: migrateOperationalResponseState(
        persisted.baseline?.operationalResponse,
        persisted.baseline?.native?.timestamp ?? persisted.native.timestamp,
      ),
    }),
    listeners: new Set(),
    queue: Promise.resolve(),
    telemetryPersistence: {
      dirty: false,
      lastCheckpointAt,
    },
  };
}

export async function createOperationsService(options) {
  const repository = options.repository;
  const now = options.now ?? (() => Date.now());
  const tickIntervalMs = options.tickIntervalMs ?? 1_000;
  const telemetryCheckpointIntervalMs = options.telemetryCheckpointIntervalMs ?? 5_000;
  if (!repository || typeof repository.loadRuntime !== "function") {
    throw new Error("An operations repository is required.");
  }
  if (!Number.isSafeInteger(telemetryCheckpointIntervalMs) || telemetryCheckpointIntervalMs < 1) {
    throw new Error("telemetryCheckpointIntervalMs must be a positive safe integer.");
  }

  const runtimes = new Map();
  const loadingRuntimes = new Map();
  let closed = false;
  let closePromise = null;

  function assertOpen() {
    if (closed) {
      throw new OperationsError(503, "operations_closed", "The operations service is shutting down.");
    }
  }

  function validateWorkspaceId(workspaceId) {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new OperationsError(400, "invalid_workspace", "The operations workspace identifier is invalid.");
    }
  }

  async function initializeRuntime(workspaceId) {
    const persistedRecord = await repository.loadRuntime(workspaceId);
    const persisted = persistedRecord?.state ?? null;
    if (persisted) {
      if (
        !Number.isSafeInteger(persisted.stateRevision) ||
        persisted.stateRevision < 0 ||
        persistedRecord.stateRevision !== persisted.stateRevision ||
        (persisted.streamRevision !== undefined &&
          (!Number.isSafeInteger(persisted.streamRevision) || persisted.streamRevision < 0))
      ) {
        throw new OperationsError(
          500,
          "corrupt_runtime_revision",
          "The persisted operations runtime revision is inconsistent.",
        );
      }
      const lastCheckpointAt = Number.isSafeInteger(persistedRecord.updatedAt)
        ? persistedRecord.updatedAt
        : now();
      return hydrateRuntime(workspaceId, persisted, lastCheckpointAt);
    }

    const nativeController = createNativeNetworkController();
    const detailed = createSimulationState();
    assertSnapshotInvariants(detailed.snapshot);
    const scheduleStore = makeScheduleStore();
    const procedureWorkspace = createProcedureWorkspace();
    const operationalResponse = freshOperationalResponse(
      nativeController.getSnapshot(),
      procedureWorkspace,
    );
    const timestamp = now();
    const runtime = {
      workspaceId,
      state: {
        runId: randomUUID(),
        stateRevision: 1,
        streamRevision: 1,
        updatedAt: new Date(timestamp).toISOString(),
      },
      nativeController,
      detailed,
      scheduleStore,
      operationalResponse,
      procedureExecutions: [],
      procedureWorkspace,
      shift: createCurrentShift(nativeController.getSnapshot(), detailed, timestamp),
      baseline: {
        native: clone(nativeController.getSnapshot()),
        detailed: clone(detailed),
        schedules: clone(scheduleStore.getSnapshot()),
        operationalResponse: clone(operationalResponse),
      },
      listeners: new Set(),
      queue: Promise.resolve(),
      telemetryPersistence: {
        dirty: false,
        lastCheckpointAt: timestamp,
      },
    };
    await repository.saveRuntime(workspaceId, persistedState(runtime), {
      stateRevision: runtime.state.stateRevision,
      event: {
        type: "runtime_created",
        actor: "system",
        occurredAt: timestamp,
        payload: { runId: runtime.state.runId },
      },
    });
    return runtime;
  }

  async function load(workspaceId) {
    assertOpen();
    validateWorkspaceId(workspaceId);
    const existing = runtimes.get(workspaceId);
    if (existing) return existing;
    const pending = loadingRuntimes.get(workspaceId);
    if (pending) return pending;

    const initialization = initializeRuntime(workspaceId).then((runtime) => {
      runtimes.set(workspaceId, runtime);
      return runtime;
    });
    loadingRuntimes.set(workspaceId, initialization);
    try {
      return await initialization;
    } finally {
      if (loadingRuntimes.get(workspaceId) === initialization) {
        loadingRuntimes.delete(workspaceId);
      }
    }
  }

  function publish(runtime) {
    const snapshot = publicState(runtime);
    for (const listener of runtime.listeners) listener(snapshot);
    return snapshot;
  }

  function enqueue(runtime, work) {
    const result = runtime.queue.then(work, work);
    runtime.queue = result.catch(() => undefined);
    return result;
  }

  async function persistMutation(
    runtime,
    commandId,
    actor,
    type,
    requestFingerprintValue,
    payload,
    result,
  ) {
    const previousStateRevision = runtime.state.stateRevision;
    const timestamp = now();
    recordCommandInShift(runtime.shift, {
      type,
      payload,
      result,
      actor,
      recordedAt: timestamp,
      operationalTime: runtime.nativeController.getSnapshot().timestamp,
    });
    runtime.state.stateRevision += 1;
    runtime.state.streamRevision += 1;
    runtime.state.updatedAt = new Date(timestamp).toISOString();
    const snapshot = publicState(runtime);
    const response = {
      status: "applied",
      commandId,
      type,
      stateRevision: runtime.state.stateRevision,
      result: clone(result),
      snapshot,
    };
    await repository.saveCommandResult(
      runtime.workspaceId,
      commandId,
      response,
      persistedState(runtime),
      {
        commandType: type,
        requestFingerprint: requestFingerprintValue,
        commandPayload: payload,
        expectedStateRevision: previousStateRevision,
        actorSessionId: actor,
        event: {
          type,
          actorSessionId: actor,
          occurredAt: timestamp,
          payload: {
            commandId,
            type,
            payload: clone(payload),
            result: clone(result),
          },
        },
      },
    );
    runtime.telemetryPersistence = {
      dirty: false,
      lastCheckpointAt: timestamp,
    };
    publish(runtime);
    return response;
  }

  function stale(runtime, expected) {
    if (expected === runtime.state.stateRevision) return;
    throw new OperationsError(
      409,
      "stale_state_revision",
      "The operational state changed. Inspect the latest revision before retrying.",
      {
        expectedStateRevision: expected,
        currentStateRevision: runtime.state.stateRevision,
      },
    );
  }

  function executionFor(runtime, incidentId, procedureId, procedureRevision) {
    return runtime.procedureExecutions.find((item) =>
      item.incidentId === incidentId &&
      item.procedureId === procedureId &&
      item.procedureRevision === procedureRevision
    );
  }

  function applyProcedureStep(runtime, payload, actor) {
    const incidentId = requiredString(payload.incidentId, "incidentId", 96);
    const procedureId = requiredString(payload.procedureId, "procedureId", 96);
    const procedureRevision = requiredString(payload.procedureRevision, "procedureRevision", 80);
    const procedureContentHash = requiredString(
      payload.procedureContentHash,
      "procedureContentHash",
      128,
    );
    const stepId = requiredString(payload.stepId, "stepId", 96);
    const snapshot = runtime.nativeController.getSnapshot();
    if (payload.expectedDecisionRevision !== snapshot.decisionRevision) {
      throw new OperationsError(
        409,
        "stale_decision_context",
        "The incident decision context changed before this procedure step was recorded.",
        {
          expectedDecisionRevision: payload.expectedDecisionRevision,
          currentDecisionRevision: snapshot.decisionRevision,
        },
      );
    }
    const incident = snapshot.incidents.find((candidate) => candidate.id === incidentId);
    if (!incident) {
      throw new OperationsError(404, "unknown_incident", "The requested incident is unavailable.");
    }
    if (incident.status !== "active") {
      throw new OperationsError(409, "incident_not_active", "Only an active incident can receive a procedure step.");
    }
    const procedure = getProcedureRevision(
      runtime.procedureWorkspace,
      procedureId,
      procedureRevision,
    );
    if (!procedure || procedure.revision !== procedureRevision) {
      throw new OperationsError(409, "unknown_procedure_revision", "The exact procedure revision is unavailable.");
    }
    if (procedure.contentHash !== procedureContentHash) {
      throw new OperationsError(409, "stale_procedure", "The procedure content hash changed.");
    }
    if (!procedure.applicability.incidentCodes.includes(incident.incidentCode)) {
      throw new OperationsError(409, "procedure_not_applicable", "The procedure does not apply to this incident.");
    }
    const step = procedure.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) throw new OperationsError(404, "unknown_procedure_step", "The procedure step is unavailable.");
    const evidenceRequirement = operatorEvidenceReferenceRequirement(step);
    const rawEvidenceReference = payload.operatorEvidenceReference;
    if (
      evidenceRequirement &&
      (typeof rawEvidenceReference !== "string" ||
        !rawEvidenceReference.trim() ||
        rawEvidenceReference.length > OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH)
    ) {
      throw new OperationsError(
        400,
        "operator_evidence_reference_required",
        `${evidenceRequirement.label} must be a non-empty string of at most ${OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH} characters.`,
        { stepId, evidenceKind: evidenceRequirement.kind },
      );
    }
    const operatorEvidenceReference = typeof rawEvidenceReference === "string" && rawEvidenceReference.trim()
      ? requiredString(
          rawEvidenceReference,
          "operatorEvidenceReference",
          OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH,
        )
      : null;
    let execution = executionFor(runtime, incidentId, procedureId, procedureRevision);
    if (
      execution?.procedureContentHash &&
      execution.procedureContentHash !== procedure.contentHash
    ) {
      throw new OperationsError(
        409,
        "procedure_execution_hash_mismatch",
        "The pinned procedure execution does not match the exact stored procedure revision.",
        {
          executionContentHash: execution.procedureContentHash,
          procedureContentHash: procedure.contentHash,
        },
      );
    }
    if (!execution) {
      execution = {
        incidentId,
        procedureId,
        procedureRevision,
        procedureContentHash,
        completedStepIds: [],
        stepRecords: [],
        recoveryStartedAt: null,
        recoveryTelemetryRevision: null,
        updatedAt: snapshot.timestamp,
      };
      runtime.procedureExecutions.push(execution);
    } else if (!execution.procedureContentHash) {
      execution.procedureContentHash = procedure.contentHash;
    }
    if (!Array.isArray(execution.stepRecords)) execution.stepRecords = [];
    const missingPreviousStepIds = procedure.steps
      .filter((candidate) =>
        candidate.mandatory &&
        candidate.order < step.order &&
        !execution.completedStepIds.includes(candidate.stepId)
      )
      .map((candidate) => candidate.stepId);
    if (missingPreviousStepIds.length > 0) {
      throw new OperationsError(
        409,
        "procedure_step_out_of_sequence",
        "Complete the preceding mandatory procedure steps first.",
        { missingPreviousStepIds },
      );
    }
    if (execution.completedStepIds.includes(stepId)) {
      throw new OperationsError(409, "no_op", "This exact procedure step was already recorded.");
    }
    if ((step.phase === "verify" || step.phase === "close") && execution.recoveryStartedAt !== null) {
      const required = procedure.returnToNormal.observationWindowSeconds * 1_000;
      const elapsed = snapshot.timestamp - execution.recoveryStartedAt;
      if (elapsed < required) {
        throw new OperationsError(
          409,
          "observation_window_incomplete",
          "The procedure observation window has not completed.",
          {
            elapsedSeconds: Math.max(0, Math.floor(elapsed / 1_000)),
            requiredSeconds: procedure.returnToNormal.observationWindowSeconds,
            remainingSeconds: Math.max(1, Math.ceil((required - elapsed) / 1_000)),
          },
        );
      }
    }

    const command = procedureCommand(step);
    let receipt = null;
    let operationalReceipt = null;
    let nativeCapabilityReceipt = null;
    const nativeCommands = new Set(["protect-and-hold", "degraded-operation", "resolve-simulation"]);
    if (command && command !== "acknowledge" && nativeCommands.has(command)) {
      const evaluation = runtime.nativeController.evaluateResponse({ incidentId });
      const option = evaluation.options.find((candidate) => candidate.action === command);
      if (!option) {
        throw new OperationsError(409, "capability_unavailable", "The procedure capability is unavailable.");
      }
      const applied = runtime.nativeController.applyReviewedOption({
        evaluationId: evaluation.id,
        optionId: option.id,
        expectedDecisionRevision: snapshot.decisionRevision,
      });
      if (!applied.ok) {
        throw new OperationsError(409, applied.reason, applied.message);
      }
      receipt = applied.receipt;
    } else if (command && command !== "acknowledge") {
      const applied = applyOperationalResponseCapability(runtime.operationalResponse, {
        incidentId,
        capability: command as OperationalResponseCapability,
        operatorId: actor,
        timestamp: snapshot.timestamp,
      });
      runtime.operationalResponse = applied.state;
      operationalReceipt = applied.receipt;
      if (command === "insert-train") {
        const incidentCase = runtime.operationalResponse.incidentCases.find((item) => item.incidentId === incidentId);
        const stationId = operationalReceipt.affectedEntityIds[0];
        const lineCode = incidentCase?.lineCodes[0];
        if (!stationId || !lineCode) {
          throw new OperationsError(409, "no_grounded_entity", "The insertion proposal has no grounded line endpoint.");
        }
        const insertionMeasure = runtime.operationalResponse.continuityMeasures.find((item) =>
          item.incidentId === incidentId && item.kind === "train-insertion"
        );
        const direction = insertionMeasure?.plan?.kind === "train-insertion"
          ? insertionMeasure.plan.direction
          : undefined;
        nativeCapabilityReceipt = runtime.nativeController.insertTrain({ lineCode, stationId, direction });
      }
    }

    execution.completedStepIds = [...execution.completedStepIds, stepId];
    const after = runtime.nativeController.getSnapshot();
    if (step.phase === "recover") {
      execution.recoveryStartedAt = after.timestamp;
      execution.recoveryTelemetryRevision = after.telemetryRevision;
    }
    execution.updatedAt = after.timestamp;
    const receiptId = receipt?.receiptId ?? operationalReceipt?.receiptId ??
      "PROC-ACK-" + incidentId + "-" + stepId;
    const stepRecord = {
      stepId,
      receiptId,
      operatorId: actor,
      recordedAt: after.timestamp,
      operatorEvidenceReference,
      evidenceKind: evidenceRequirement?.kind ?? null,
    };
    execution.stepRecords = [...execution.stepRecords, stepRecord];
    const nextRequiredStepId = procedure.steps.find((candidate) =>
      candidate.mandatory && !execution.completedStepIds.includes(candidate.stepId)
    )?.stepId ?? null;
    const closedIncident = after.incidents.find((candidate) => candidate.id === incidentId);
    const activeRestrictions = after.restrictions.filter(
      (restriction) => restriction.incidentId === incidentId && restriction.active,
    );
    return {
      status: receipt || operationalReceipt ? "applied_to_simulation" : "procedure_step_acknowledged",
      receiptId,
      mutationApplied: Boolean(receipt || operationalReceipt),
      operationalReceipt: operationalReceipt ? clone(operationalReceipt) : null,
      nativeCapabilityReceipt: nativeCapabilityReceipt ? clone(nativeCapabilityReceipt) : null,
      previousDecisionRevision: snapshot.decisionRevision,
      decisionRevision: after.decisionRevision,
      completedStepIds: clone(execution.completedStepIds),
      stepRecord: clone(stepRecord),
      nextRequiredStepId,
      incidentCode: incident.incidentCode,
      procedureId,
      procedureRevision,
      procedureContentHash,
      stepId,
      capability: command ?? "operator-check",
      normalStateVerification: step.phase === "close"
        ? {
            status:
              closedIncident?.status === "resolved" &&
              activeRestrictions.length === 0 &&
              nextRequiredStepId === null
                ? "passed"
                : "failed",
            incidentResolved: closedIncident?.status === "resolved",
            activeIncidentRestrictionCount: activeRestrictions.length,
            mandatoryProcedureStepsComplete: nextRequiredStepId === null,
            observationWindowSeconds: procedure.returnToNormal.observationWindowSeconds,
          }
        : null,
    };
  }

  async function execute(runtime, type, payload, actor) {
    switch (type) {
      case "set_speed": {
        const speed = payload.speed;
        if (![0, 1, 2, 4].includes(speed)) {
          throw new OperationsError(400, "invalid_speed", "Speed must be 0, 1, 2 or 4.");
        }
        if (
          runtime.nativeController.getSnapshot().speed === speed &&
          runtime.detailed.speed === speed
        ) {
          throw new OperationsError(409, "no_op", "The simulation speed is already set to this value.");
        }
        runtime.nativeController.setSpeed(speed);
        runtime.detailed = setSimulationSpeed(runtime.detailed, speed);
        return { speed };
      }
      case "reset_all": {
        runtime.nativeController.reset();
        const detailed = clone(runtime.baseline.detailed);
        detailed.snapshot.decisionRevision = runtime.detailed.snapshot.decisionRevision + 1;
        detailed.snapshot.revision = runtime.detailed.snapshot.revision + 1;
        runtime.detailed = detailed;
        runtime.scheduleStore.restoreSnapshot(runtime.baseline.schedules);
        runtime.operationalResponse = clone(runtime.baseline.operationalResponse);
        runtime.procedureExecutions = [];
        runtime.shift = createCurrentShift(
          runtime.nativeController.getSnapshot(),
          runtime.detailed,
          now(),
        );
        return { reset: true };
      }
      case "update_procedure_step": {
        const procedureId = requiredString(payload.procedureId, "procedureId", 96);
        const stepId = requiredString(payload.stepId, "stepId", 96);
        const expectedProcedureRevision = requiredString(
          payload.expectedProcedureRevision,
          "expectedProcedureRevision",
          80,
        );
        const expectedProcedureContentHash = requiredString(
          payload.expectedProcedureContentHash,
          "expectedProcedureContentHash",
          128,
        );
        const patch = commandObject(payload.patch);
        const published = publishProcedureStepPatch(runtime.procedureWorkspace, {
          procedureId,
          stepId,
          expectedProcedureRevision,
          expectedProcedureContentHash,
          patch,
        });
        runtime.procedureWorkspace = published.state;
        return {
          procedure: clone(published.procedure),
          previousRevision: published.previousRevision,
          previousContentHash: published.previousContentHash,
          changedFields: clone(published.changedFields),
        };
      }
      case "activate_native_scenario": {
        const snapshot = runtime.nativeController.activateScenario(
          requiredString(payload.scenarioId, "scenarioId", 40),
        );
        runtime.operationalResponse = freshOperationalResponse(
          snapshot,
          runtime.procedureWorkspace,
        );
        runtime.procedureExecutions = [];
        return { scenarioId: snapshot.scenarioId, decisionRevision: snapshot.decisionRevision };
      }
      case "import_configuration": {
        try {
          const native = commandObject(payload.native);
          const detailed = commandObject(payload.detailed);
          assertSnapshotInvariants(detailed.snapshot);
          const loaded = runtime.nativeController.loadConfiguration({
            timestamp: native.timestamp,
            speed: native.speed,
            scenarioId: native.scenarioId,
            scenarioName: native.scenarioName,
            trains: native.trains,
            stationPassengers: native.stationPassengers,
            incidents: native.incidents,
          });
          const previousDetailedDecisionRevision = runtime.detailed.snapshot.decisionRevision;
          runtime.detailed = clone(detailed);
          runtime.detailed.snapshot.decisionRevision = previousDetailedDecisionRevision + 1;
          runtime.operationalResponse = freshOperationalResponse(
            loaded,
            runtime.procedureWorkspace,
          );
          runtime.baseline.native = clone(loaded);
          runtime.baseline.detailed = clone(runtime.detailed);
          runtime.baseline.operationalResponse = clone(runtime.operationalResponse);
          runtime.procedureExecutions = [];
          return { name: payload.name ?? loaded.scenarioName };
        } catch (error) {
          const mapped = mapExecutionError(error);
          if (mapped !== error) throw mapped;
          throw new OperationsError(
            400,
            "invalid_configuration",
            error instanceof Error ? error.message : "The imported configuration is invalid.",
          );
        }
      }
      case "create_native_incident": {
        const incident = runtime.nativeController.createIncident(payload);
        return { incident };
      }
      case "insert_native_train": {
        const lineCode = requiredString(payload.lineCode, "lineCode", 24);
        const stationId = requiredString(payload.stationId, "stationId", 128);
        if (payload.direction !== 1 && payload.direction !== -1) {
          throw new OperationsError(400, "invalid_command", "direction must be 1 or -1.");
        }
        const insertion = runtime.nativeController.insertTrain({
          lineCode,
          stationId,
          direction: payload.direction,
        });
        return { insertion };
      }
      case "evaluate_native_response": {
        return { evaluation: runtime.nativeController.evaluateResponse(payload) };
      }
      case "apply_native_response": {
        const applied = runtime.nativeController.applyReviewedOption(payload);
        if (!applied.ok) throw new OperationsError(409, applied.reason, applied.message);
        return { applied };
      }
      case "apply_procedure_step":
        return applyProcedureStep(runtime, payload, actor);
      case "set_detailed_incident_status": {
        const id = requiredString(payload.id, "id", 96);
        const status = requiredEnum(
          payload.status,
          "status",
          ["planned", "active", "acknowledged", "resolved"],
        );
        const incident = runtime.detailed.snapshot.incidents.find((candidate) => candidate.id === id);
        if (!incident) throw new OperationsError(404, "unknown_incident", "The incident is unavailable.");
        if (incident.status === status) {
          throw new OperationsError(409, "no_op", "The incident already has this status.");
        }
        runtime.detailed = updateIncidentStatus(runtime.detailed, id, status);
        return { id, status };
      }
      case "set_power_status": {
        const id = requiredString(payload.id, "id", 96);
        const status = requiredEnum(payload.status, "status", ["energized", "isolated"]);
        const section = runtime.detailed.snapshot.powerSections.find((candidate) => candidate.id === id);
        if (!section) throw new OperationsError(404, "unknown_power_section", "The power section is unavailable.");
        if (section.status === status) {
          throw new OperationsError(409, "no_op", "The power section already has this status.");
        }
        runtime.detailed = setPowerStatus(runtime.detailed, id, status);
        return { id, status };
      }
      case "regulate_train": {
        const trainId = requiredString(payload.trainId, "trainId", 96);
        const action = requiredEnum(payload.action, "action", ["priority", "hold", "turnback"]);
        if (!runtime.detailed.snapshot.trains.some((candidate) => candidate.id === trainId)) {
          throw new OperationsError(404, "unknown_train", "The train is unavailable.");
        }
        const before = runtime.detailed;
        runtime.detailed = applyRegulation(runtime.detailed, trainId, action);
        const latest = runtime.detailed.snapshot.events[0];
        const rejected = runtime.detailed === before ||
          (latest?.kind === "regulation" && latest.title.includes("rejected"));
        if (rejected) {
          throw new OperationsError(
            409,
            "regulation_rejected",
            latest?.detail ?? "Regulation rejected.",
          );
        }
        return { message: latest?.detail ?? "Regulation applied." };
      }
      case "add_detailed_incident": {
        const draft = {
          type: requiredEnum(
            payload.type,
            "type",
            ["infrastructure", "passenger", "rolling-stock", "power"],
          ),
          severity: requiredEnum(
            payload.severity,
            "severity",
            ["low", "medium", "high", "critical"],
          ),
          lineId: requiredEnum(payload.lineId, "lineId", ["RER_A", "RER_B", "M13", "M14"]),
          location: requiredString(payload.location, "location", 120),
          summary: requiredString(payload.summary, "summary", 500),
        };
        runtime.detailed = addDemoIncident(runtime.detailed, draft);
        return { incident: runtime.detailed.snapshot.incidents[0] };
      }
      case "schedule_power_incident": {
        const targetId = requiredString(payload.targetId, "targetId", 96);
        const lineCode = requiredEnum(payload.lineCode, "lineCode", ["RER_A", "RER_B", "M13", "M14"]);
        const section = runtime.detailed.snapshot.powerSections.find((candidate) => candidate.id === targetId);
        if (!section) {
          throw new OperationsError(404, "unknown_power_section", "The power section is unavailable.");
        }
        if (!section.lineIds.includes(lineCode)) {
          throw new OperationsError(400, "line_mismatch", "The power section does not belong to this line.");
        }
        if (!Number.isSafeInteger(payload.occurrenceTime) || payload.occurrenceTime < 0) {
          throw new OperationsError(
            400,
            "invalid_command",
            "occurrenceTime must be a non-negative epoch-millisecond safe integer.",
          );
        }
        const draft = {
          targetType: requiredEnum(payload.targetType, "targetType", ["power"]),
          targetId,
          lineCode,
          type: requiredEnum(
            payload.type,
            "type",
            ["infrastructure", "passenger", "rolling-stock", "power", "works", "external"],
          ),
          severity: requiredEnum(
            payload.severity,
            "severity",
            ["low", "medium", "high", "critical"],
          ),
          effect: requiredEnum(payload.effect, "effect", ["degrade-power", "isolate-power"]),
          occurrenceTime: payload.occurrenceTime,
          title: requiredString(payload.title, "title", 160),
          summary: requiredString(payload.summary, "summary", 500),
        };
        runtime.detailed = schedulePowerIncident(runtime.detailed, draft);
        return { incident: runtime.detailed.snapshot.incidents[0] };
      }
      case "close_circuit": {
        const outcome = closeCircuit(
          runtime.detailed,
          requiredString(payload.circuitId, "circuitId", 96),
          requiredEnum(payload.reason, "reason", ["works", "incident"]),
          optionalBoundedString(payload.note, "note", 180),
          optionalBoundedString(payload.reference, "reference", 64),
        );
        if (!outcome.ok) throw new OperationsError(409, outcome.reason, outcome.message);
        runtime.detailed = outcome.nextState;
        return {
          action: outcome.action,
          outcome: outcome.outcome,
          circuitId: outcome.circuitId,
          message: outcome.message,
        };
      }
      case "reopen_circuit": {
        const outcome = reopenCircuit(
          runtime.detailed,
          requiredString(payload.circuitId, "circuitId", 96),
        );
        if (!outcome.ok) throw new OperationsError(409, outcome.reason, outcome.message);
        runtime.detailed = outcome.nextState;
        return {
          action: outcome.action,
          outcome: outcome.outcome,
          circuitId: outcome.circuitId,
          message: outcome.message,
        };
      }
      case "load_schedule_plan": {
        const version = runtime.scheduleStore.loadPlan(payload.plan);
        return { version };
      }
      case "schedule_preview": {
        const preview = runtime.scheduleStore.preview(
          payload.request,
          runtime.detailed.snapshot,
          requiredEnum(payload.actor ?? "human", "actor", ["human", "agent"]),
        );
        return { preview };
      }
      case "schedule_evaluate": {
        const impact = runtime.scheduleStore.evaluatePreview(
          requiredString(payload.previewId, "previewId"),
          runtime.detailed.snapshot,
        );
        return { impact };
      }
      case "schedule_authorize": {
        runtime.scheduleStore.authorizePreview(
          requiredString(payload.previewId, "previewId"),
          requiredString(payload.impactId, "impactId"),
          runtime.detailed.snapshot,
        );
        return { authorized: true };
      }
      case "schedule_commit": {
        const receipt = runtime.scheduleStore.commitPreview(
          requiredString(payload.previewId, "previewId"),
          requiredString(payload.impactId, "impactId"),
          requiredEnum(payload.actor ?? "human", "actor", ["human", "agent"]),
          runtime.detailed.snapshot,
        );
        return { receipt };
      }
      case "schedule_discard": {
        const schedule = runtime.scheduleStore.getSnapshot();
        if (!schedule.pendingPreview && !schedule.pendingImpact) {
          throw new OperationsError(409, "no_op", "There is no pending schedule preview to discard.");
        }
        runtime.scheduleStore.discardPreview();
        return { discarded: true };
      }
      case "schedule_undo": {
        const version = runtime.scheduleStore.undo(
          requiredEnum(payload.actor ?? "human", "actor", ["human", "agent"]),
        );
        return { version };
      }
      case "update_shift_report": {
        if (runtime.shift.report.status === "frozen") {
          throw new OperationsError(
            409,
            "report_frozen",
            "The end-of-shift report is frozen and can no longer be edited.",
          );
        }
        const reportId = requiredString(payload.reportId, "reportId", 96);
        if (reportId !== runtime.shift.report.reportId) {
          throw new OperationsError(409, "stale_report", "The report identifier changed after reset.");
        }
        const source = requiredEnum(payload.source ?? "operator", "source", ["operator", "agent"]);
        let contentHtml;
        try {
          contentHtml = sanitizeShiftReportHtml(payload.contentHtml);
        } catch (error) {
          throw new OperationsError(
            400,
            "invalid_report_content",
            error instanceof Error ? error.message : "The report content is invalid.",
          );
        }
        if (!contentHtml.replace(/<[^>]+>/g, "").trim()) {
          throw new OperationsError(400, "empty_report", "The report cannot be empty.");
        }
        const updatedAt = now();
        runtime.shift.report = {
          ...runtime.shift.report,
          contentHtml,
          updatedAt,
          generatedAt: source === "agent" ? updatedAt : runtime.shift.report.generatedAt,
          sourceLogSequence: runtime.shift.nextLogSequence - 1,
        };
        return {
          reportId,
          status: runtime.shift.report.status,
          source,
          updatedAt,
          sourceLogSequence: runtime.shift.report.sourceLogSequence,
        };
      }
      case "freeze_shift_report": {
        const reportId = requiredString(payload.reportId, "reportId", 96);
        if (reportId !== runtime.shift.report.reportId) {
          throw new OperationsError(409, "stale_report", "The report identifier changed after reset.");
        }
        if (runtime.shift.report.status === "frozen") {
          throw new OperationsError(409, "report_frozen", "The report is already frozen.");
        }
        const frozenAt = now();
        runtime.shift.report = {
          ...runtime.shift.report,
          status: "frozen",
          updatedAt: frozenAt,
          frozenAt,
          sourceLogSequence: runtime.shift.nextLogSequence - 1,
        };
        return {
          reportId,
          status: "frozen",
          frozenAt,
          sourceLogSequence: runtime.shift.report.sourceLogSequence,
        };
      }
      default:
        throw new OperationsError(400, "unknown_command", "Unknown operations command: " + type + ".");
    }
  }

  async function command(workspaceId, actor, envelope) {
    assertOpen();
    const input = commandObject(envelope);
    const commandId = requiredString(input.commandId, "commandId", 128);
    if (!COMMAND_ID_PATTERN.test(commandId)) {
      throw new OperationsError(400, "invalid_command_id", "commandId has an invalid format.");
    }
    const type = requiredString(input.type, "type", 80);
    const expected = expectedRevision(input.expectedStateRevision);
    const payload = commandObject(input.payload ?? {});
    const requestFingerprintValue = createCommandRequestFingerprint({
      commandType: type,
      expectedStateRevision: expected,
      payload,
    });
    const runtime = await load(workspaceId);
    return enqueue(runtime, async () => {
      assertOpen();
      const cached = await repository.getCommandResult(workspaceId, commandId);
      if (cached) {
        if (
          cached.commandType !== type ||
          cached.requestFingerprint !== requestFingerprintValue
        ) {
          throw new OperationsError(
            409,
            "command_id_reused",
            "This commandId was already used with different arguments.",
          );
        }
        return cached.result;
      }
      stale(runtime, expected);
      const checkpoint = persistedState(runtime);
      let result;
      try {
        result = await execute(runtime, type, payload, actor);
        // A native mutation and its operational-response projection form one
        // server transaction. In particular, resolving an incident from a
        // procedure must complete its case and measures even while the native
        // clock is paused and no telemetry tick can perform the projection.
        synchronizeOperationalResponseAfterCommand(runtime, type);
      } catch (error) {
        restoreRuntime(runtime, checkpoint);
        throw mapExecutionError(error);
      }
      try {
        return await persistMutation(
          runtime,
          commandId,
          actor,
          type,
          requestFingerprintValue,
          payload,
          result,
        );
      } catch (error) {
        restoreRuntime(runtime, checkpoint);
        if (error?.code === "command_id_reused") {
          throw new OperationsError(
            409,
            "command_id_reused",
            "This commandId was already used with different arguments.",
          );
        }
        throw error;
      }
    });
  }

  async function flushTelemetryCheckpoint(runtime) {
    if (!runtime.telemetryPersistence.dirty) return false;
    const timestamp = now();
    await repository.saveRuntime(runtime.workspaceId, persistedState(runtime), {
      expectedStateRevision: runtime.state.stateRevision,
      stateRevision: runtime.state.stateRevision,
      event: null,
    });
    runtime.telemetryPersistence = {
      dirty: false,
      lastCheckpointAt: timestamp,
    };
    return true;
  }

  async function tickRuntime(runtime) {
    return enqueue(runtime, async () => {
      const checkpoint = persistedState(runtime);
      const persistenceCheckpoint = { ...runtime.telemetryPersistence };
      const nativeBefore = runtime.nativeController.getSnapshot();
      const detailedBefore = runtime.detailed;
      const operationalResponseBefore = runtime.operationalResponse;
      const nativeAfter = runtime.nativeController.tick();
      const detailedAfter = advanceSimulation(runtime.detailed);
      if (nativeAfter === nativeBefore && detailedAfter === detailedBefore) return;
      const operationalAdvance = advanceOperationalResponse(
        operationalResponseBefore,
        nativeAfter.incidents,
        nativeAfter.trains,
        nativeAfter.timestamp,
        activeProcedureCatalogue(runtime),
      );

      const previousStateRevision = runtime.state.stateRevision;
      let decisionChanged =
        nativeAfter.decisionRevision !== nativeBefore.decisionRevision ||
        detailedAfter.snapshot.decisionRevision !== detailedBefore.snapshot.decisionRevision ||
        operationalAdvance.decisionChanged;
      const timestamp = now();
      runtime.detailed = detailedAfter;
      runtime.operationalResponse = operationalAdvance.state;
      const transitionEntries = [
        ...recordIncidentTransitions(runtime.shift, {
          source: "network",
          beforeIncidents: nativeBefore.incidents,
          afterIncidents: nativeAfter.incidents,
          recordedAt: timestamp,
          operationalTime: nativeAfter.timestamp,
        }),
        ...recordIncidentTransitions(runtime.shift, {
          source: "corridor",
          beforeIncidents: detailedBefore.snapshot.incidents,
          afterIncidents: detailedAfter.snapshot.incidents,
          recordedAt: timestamp,
          operationalTime: detailedAfter.snapshot.timestamp,
        }),
      ];
      decisionChanged = decisionChanged || transitionEntries.length > 0;
      if (decisionChanged) runtime.state.stateRevision += 1;
      runtime.state.streamRevision += 1;
      runtime.state.updatedAt = new Date(timestamp).toISOString();
      const checkpointDue = decisionChanged ||
        timestamp - persistenceCheckpoint.lastCheckpointAt >= telemetryCheckpointIntervalMs;
      if (checkpointDue) {
        try {
          await repository.saveRuntime(runtime.workspaceId, persistedState(runtime), {
            expectedStateRevision: previousStateRevision,
            stateRevision: runtime.state.stateRevision,
            event: decisionChanged
              ? {
                  type: "scheduled_state_transition",
                  actor: "system",
                  occurredAt: timestamp,
                  payload: {
                    nativeDecisionRevision: nativeAfter.decisionRevision,
                    detailedDecisionRevision: detailedAfter.snapshot.decisionRevision,
                    operationalResponseRevision: operationalAdvance.state.revision,
                    operationalTransitions: operationalAdvance.transitions,
                  },
                }
              : null,
          });
        } catch (error) {
          restoreRuntime(runtime, checkpoint);
          runtime.telemetryPersistence = persistenceCheckpoint;
          throw error;
        }
        runtime.telemetryPersistence = {
          dirty: false,
          lastCheckpointAt: timestamp,
        };
      } else {
        runtime.telemetryPersistence = {
          ...persistenceCheckpoint,
          dirty: true,
        };
      }
      publish(runtime);
    });
  }

  const timer = setInterval(() => {
    if (closed) return;
    for (const runtime of runtimes.values()) {
      void tickRuntime(runtime).catch((error) => {
        console.error("[operations] tick failed", error);
      });
    }
  }, tickIntervalMs);
  timer.unref?.();

  return {
    async getSnapshot(workspaceId) {
      const runtime = await load(workspaceId);
      return enqueue(runtime, async () => {
        assertOpen();
        return publicState(runtime);
      });
    },
    command,
    async subscribe(workspaceId, listener) {
      if (typeof listener !== "function") {
        throw new OperationsError(400, "invalid_listener", "A snapshot listener is required.");
      }
      const runtime = await load(workspaceId);
      return enqueue(runtime, async () => {
        assertOpen();
        runtime.listeners.add(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          runtime.listeners.delete(listener);
        };
      });
    },
    async listEvents(workspaceId, options = {}) {
      const runtime = await load(workspaceId);
      return enqueue(runtime, async () => {
        assertOpen();
        return repository.listEvents({ ...options, workspaceId });
      });
    },
    health() {
      return {
        ready: !closed,
        activeRuntimeCount: runtimes.size,
        databasePath: repository.databasePath ?? null,
      };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      clearInterval(timer);
      closePromise = (async () => {
        let failure = null;
        await Promise.allSettled([...loadingRuntimes.values()]);
        await Promise.all([...runtimes.values()].map((runtime) => runtime.queue));
        const flushes = await Promise.allSettled(
          [...runtimes.values()].map((runtime) =>
            enqueue(runtime, () => flushTelemetryCheckpoint(runtime))
          ),
        );
        const rejectedFlush = flushes.find((result) => result.status === "rejected");
        if (rejectedFlush?.status === "rejected") failure = rejectedFlush.reason;
        for (const runtime of runtimes.values()) runtime.listeners.clear();
        try {
          await repository.close();
        } catch (error) {
          failure = failure
            ? new AggregateError([failure, error], "Operations checkpoint and repository close failed.")
            : error;
        } finally {
          loadingRuntimes.clear();
          runtimes.clear();
        }
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };
}
