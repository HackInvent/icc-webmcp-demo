/**
 * Transaction and versioning model adapted from ProofSheet.
 * Copyright (c) 2026 Alexandre EL — used under the MIT License.
 * See the repository LICENSE for the complete license text.
 */

import type { LineId, RailSnapshot } from "../rail/domain";

export type Actor = "human" | "agent";
export type ScheduleServiceStatus = "scheduled" | "cancelled";

export interface ScheduleService {
  serviceId: string;
  circulationId: string;
  trainId: string | null;
  lineId: LineId;
  origin: string;
  destination: string;
  departureMinutes: number;
  arrivalMinutes: number;
  track: string;
  driverToken: string | null;
  status: ScheduleServiceStatus;
}

export interface SchedulePlan {
  name: string;
  serviceDate: string;
  services: ScheduleService[];
  importedAt: string;
}

export type ScheduleChangeRequest =
  | {
      kind: "shift_service";
      serviceId: string;
      deltaMinutes: number;
    }
  | {
      kind: "reassign_driver";
      serviceId: string;
      driverToken: string | null;
    }
  | {
      kind: "change_track";
      serviceId: string;
      track: string;
    }
  | {
      kind: "cancel_service";
      serviceId: string;
    };

export interface ScheduleChange {
  serviceId: string;
  field: keyof ScheduleService;
  before: string | number | null;
  after: string | number | null;
}

export interface SchedulePreview {
  id: string;
  request: ScheduleChangeRequest;
  beforeHash: string;
  afterHash: string;
  contextHash: string;
  result: SchedulePlan;
  changes: ScheduleChange[];
  affectedServiceIds: string[];
  summary: string;
  warnings: string[];
  createdAt: string;
  actor: Actor;
  simulationOnly: true;
}

export type ScheduleConflictKind =
  | "missing_driver"
  | "unknown_driver"
  | "driver_overlap"
  | "driver_relief_risk"
  | "driver_qualification"
  | "driver_shift"
  | "rolling_stock_overlap"
  | "headway"
  | "track"
  | "power_isolation";

export interface ScheduleConflict {
  id: string;
  kind: ScheduleConflictKind;
  severity: "hard" | "warning";
  serviceIds: string[];
  resourceId?: string;
  message: string;
}

export interface ScheduleCoverage {
  totalServices: number;
  operatingServices: number;
  coveredServices: number;
  uncoveredServiceIds: string[];
  percent: number;
}

export interface IncidentExposure {
  serviceCount: number;
  serviceIds: string[];
  incidentIds: string[];
}

export interface PowerExposure {
  serviceCount: number;
  serviceIds: string[];
  sectionIds: string[];
  isolatedServiceIds: string[];
}

export type ImpactAssessment =
  | "blocked"
  | "high-risk"
  | "review"
  | "acceptable";

export interface ImpactEvaluation {
  id: string;
  previewId: string;
  beforeHash: string;
  afterHash: string;
  contextHash: string;
  baselineCoverage: ScheduleCoverage;
  baselineConflicts: ScheduleConflict[];
  coverage: ScheduleCoverage;
  conflicts: ScheduleConflict[];
  passengersAffected: number;
  passengerDelayMinutes: number;
  incidentExposure: IncidentExposure;
  powerExposure: PowerExposure;
  score: number;
  assessment: ImpactAssessment;
  hardBlocks: string[];
  warnings: string[];
  summary: string;
  evaluatedAt: string;
}

export interface ScheduleReceipt {
  id: string;
  previewId: string;
  impactId: string;
  request: ScheduleChangeRequest;
  beforeHash: string;
  afterHash: string;
  contextHash: string;
  changedServiceIds: string[];
  summary: string;
  score: number;
  assessment: ImpactAssessment;
  createdAt: string;
  actor: Actor;
  simulationOnly: true;
}

export interface ScheduleVersion {
  id: string;
  label: string;
  createdAt: string;
  plan: SchedulePlan;
  receipt?: ScheduleReceipt;
}

export interface ScheduleWorkspaceState {
  versions: ScheduleVersion[];
  cursor: number;
  pendingPreview: SchedulePreview | null;
  pendingImpact: ImpactEvaluation | null;
  authorizedPreviewId: string | null;
  authorizedImpactId: string | null;
  lastReceipt: ScheduleReceipt | null;
  lastEvent: string;
  simulationOnly: true;
}

export type ScheduleWorkspaceErrorCode =
  | "PLAN_NOT_LOADED"
  | "PREVIEW_STALE"
  | "IMPACT_REQUIRED"
  | "IMPACT_STALE"
  | "CONTEXT_STALE"
  | "AUTHORIZATION_REQUIRED"
  | "HARD_BLOCK"
  | "LIVE_FORBIDDEN"
  | "NO_CHANGES"
  | "INVALID_REQUEST"
  | "NOTHING_TO_UNDO";

export class ScheduleWorkspaceError extends Error {
  readonly code: ScheduleWorkspaceErrorCode;

  constructor(code: ScheduleWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "ScheduleWorkspaceError";
    this.code = code;
  }
}

export type ScheduleAwaitable<T> = T | Promise<T>;

export interface ScheduleWorkspace {
  getSnapshot: () => ScheduleWorkspaceState;
  subscribe: (listener: () => void) => () => void;
  currentPlan(): SchedulePlan;
  currentHash(): string;
  loadPlan(plan: SchedulePlan): ScheduleAwaitable<ScheduleVersion>;
  preview(
    request: ScheduleChangeRequest,
    snapshot: RailSnapshot,
    actor?: Actor,
  ): ScheduleAwaitable<SchedulePreview>;
  evaluatePreview(
    previewId: string,
    snapshot: RailSnapshot,
  ): ScheduleAwaitable<ImpactEvaluation>;
  authorizePreview(
    previewId: string,
    impactId: string,
    snapshot: RailSnapshot,
  ): ScheduleAwaitable<void>;
  commitPreview(
    previewId: string,
    impactId: string,
    actor: Actor,
    snapshot: RailSnapshot,
  ): ScheduleAwaitable<ScheduleReceipt>;
  discardPreview(): ScheduleAwaitable<void>;
  undo(actor?: Actor): ScheduleAwaitable<ScheduleVersion>;
}
