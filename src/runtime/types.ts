import type { SimulationState } from "../rail/domain";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import type { ScheduleWorkspaceState } from "../schedules/types";
import type { OperationalResponseState } from "../operations/operationalResponse";
import type { OperationalProcedure } from "../procedures";

export const OPERATIONS_SNAPSHOT_SCHEMA =
  "paris-icc-operations-runtime-v1" as const;

export interface ProcedureExecutionSnapshot {
  incidentId: string;
  procedureId: string;
  procedureRevision: string;
  procedureContentHash?: string;
  completedStepIds: readonly string[];
  /** Optional for snapshots persisted before evidence-bearing step records were introduced. */
  stepRecords?: readonly ProcedureStepRecordSnapshot[];
  recoveryStartedAt: number | null;
  recoveryTelemetryRevision: number | null;
  updatedAt?: number;
}

export interface ProcedureStepRecordSnapshot {
  stepId: string;
  receiptId: string;
  operatorId: string;
  recordedAt: number;
  operatorEvidenceReference: string | null;
  evidenceKind: "works-handback" | "police-clearance" | null;
}

/**
 * Lightweight public projection of workspace-specific procedure editions.
 * The immutable bundled catalogue is never duplicated in the runtime snapshot;
 * only active overrides and exact historical revisions pinned by executions are exposed.
 */
export interface ProcedureCatalogueSnapshot {
  schemaVersion: "paris-icc.procedure-workspace.v1";
  sequence: number;
  revision: string;
  contentHash: string;
  activeOverrides: Readonly<Record<string, string>>;
  referencedVersions: readonly OperationalProcedure[];
}

export type ShiftLogCategory =
  | "incident"
  | "operator-action"
  | "decision-support"
  | "system";

export interface ShiftLogEntry {
  id: string;
  sequence: number;
  category: ShiftLogCategory;
  eventType: string;
  actor: "operator" | "agent" | "system";
  recordedAt: number;
  operationalTime: number;
  title: string;
  summary: string;
  incidentId: string | null;
  entityIds: readonly string[];
  durationSeconds: number | null;
}

export interface ShiftReportSnapshot {
  reportId: string;
  status: "draft" | "frozen";
  title: string;
  contentHtml: string;
  createdAt: number;
  updatedAt: number;
  frozenAt: number | null;
  generatedAt: number | null;
  sourceLogSequence: number;
}

export interface ShiftWorkspaceSnapshot {
  shiftId: string;
  startedAt: number;
  startedOperationalTime: number;
  nextLogSequence: number;
  logs: readonly ShiftLogEntry[];
  report: ShiftReportSnapshot;
}

/**
 * One server-authoritative view of an authenticated operations run.
 *
 * The two existing railway models deliberately remain separate: `native`
 * drives the full network map while `detailed` drives corridor, power, crew,
 * and schedule impact views. `stateRevision` orders operator decision changes;
 * `streamRevision` orders every published snapshot, including telemetry-only ticks.
 */
export interface OperationsServerSnapshot {
  schema: typeof OPERATIONS_SNAPSHOT_SCHEMA;
  runId: string;
  stateRevision: number;
  streamRevision: number;
  native: NativeSimulationSnapshot;
  detailed: SimulationState;
  procedureExecutions: readonly ProcedureExecutionSnapshot[];
  procedureCatalogue?: ProcedureCatalogueSnapshot;
  schedules: ScheduleWorkspaceState;
  operationalResponse: OperationalResponseState;
  shift: ShiftWorkspaceSnapshot;
  updatedAt?: string;
}

export type OperationsStreamStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface OperationsClientFailure extends Error {
  readonly code: string;
  readonly status?: number;
  readonly commandId?: string;
}

export type OperationsClientSnapshot =
  | {
      status: "loading";
      serverSnapshot: null;
      error: null;
      streamStatus: "idle" | "connecting";
    }
  | {
      status: "ready";
      serverSnapshot: OperationsServerSnapshot;
      error: null;
      streamStatus: OperationsStreamStatus;
    }
  | {
      status: "error";
      serverSnapshot: OperationsServerSnapshot | null;
      error: OperationsClientFailure;
      streamStatus: "idle" | "reconnecting" | "closed";
    };

export interface OperationsCommandRequest<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  commandId: string;
  type: string;
  expectedStateRevision: number;
  payload: TPayload;
}

export interface OperationsCommandOptions {
  commandId?: string;
  expectedStateRevision?: number;
  signal?: AbortSignal;
}

export interface OperationsCommandResult<TReceipt = unknown> {
  status: string;
  commandId: string;
  stateRevision: number;
  type?: string;
  message?: string;
  idempotent?: boolean;
  result?: TReceipt;
  receipt?: TReceipt;
  snapshot?: OperationsServerSnapshot;
}

export interface OperationsConflictBody {
  error?: string;
  code?: string;
  message?: string;
  commandId?: string;
  expectedStateRevision?: number;
  currentStateRevision?: number;
  snapshot?: OperationsServerSnapshot;
}

export interface OperationsSnapshotEvent {
  type: "snapshot";
  snapshot: OperationsServerSnapshot;
}
