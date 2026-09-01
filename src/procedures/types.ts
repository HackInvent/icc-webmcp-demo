/**
 * Procedure-domain types for the Paris ICC demonstration.
 *
 * The bundled catalogue is deliberately synthetic. It must never be presented
 * as an RATP, IDFM, infrastructure-manager, or statutory operating document.
 */

export type ProcedureIncidentType =
  | "infrastructure"
  | "passenger"
  | "rolling-stock"
  | "staff"
  | "power"
  | "works"
  | "external"
  | "communications"
  | "security";

export type ProcedureTargetType =
  | "train"
  | "station"
  | "interstation"
  | "power"
  | "line";

export type ProcedureIncidentEffect =
  | "stop-train"
  | "station-closure"
  | "station-dwell"
  | "block-interstation"
  | "reduce-speed"
  | "degrade-power"
  | "isolate-power"
  | "communication-degraded"
  | "communication-loss"
  | "abandoned-baggage"
  | "tow-train";

export type IncidentCode = `ICC-INC-${string}`;
export type ProcedureId = `ICC-PROC-${string}`;

export type ProcedurePhase =
  | "acknowledge"
  | "protect"
  | "diagnose"
  | "coordinate"
  | "mitigate"
  | "recover"
  | "verify"
  | "close";

/** The only state-changing primitives a procedure may expose. */
export type ProcedureCapability =
  | "acknowledge"
  | "protect-and-hold"
  | "degraded-operation"
  | "resolve-simulation"
  | "publish-passenger-information"
  | "protect-connections"
  | "dispatch-maintenance"
  | "activate-provisional-service"
  | "activate-turnbacks"
  | "activate-shuttle-bus"
  | "insert-train"
  | "start-towing";

/** Machine-readable authority reference required before a step may complete. */
export type OperatorEvidenceReferenceKind =
  | "works-handback"
  | "police-clearance";

export interface ProcedureStepDurationRange {
  minSeconds: number;
  nominalSeconds: number;
  maxSeconds: number;
}

export interface ProcedureSource {
  kind: "demo-authored";
  official: false;
  issuer: "Hackinvent / Paris ICC demo";
  documentReference: string;
  authoredOn: string;
  notice: string;
}

export interface ProcedureStep {
  stepId: string;
  order: number;
  phase: ProcedurePhase;
  title: string;
  instruction: string;
  rationale: string;
  responsibleRole: string;
  mandatory: boolean;
  preconditions: readonly string[];
  evidenceRequired: readonly string[];
  completionCriteria: readonly string[];
  /** Planning estimate, never an automatic clearance or completion timer. */
  durationRangeSeconds: ProcedureStepDurationRange;
  /** Immutable workflow gate; procedure editors cannot change this field. */
  requiredEvidenceReferenceKind?: OperatorEvidenceReferenceKind;
  capability?: ProcedureCapability;
  operatorConfirmationRequired: boolean;
}

export interface ReturnToNormalCriterion {
  criterionId: string;
  label: string;
  evidence: string;
  required: true;
}

export interface ReturnToNormalPolicy {
  objective: string;
  observationWindowSeconds: number;
  criteria: readonly ReturnToNormalCriterion[];
  operatorSignoffRequired: true;
}

export interface ProcedureApplicability {
  incidentCodes: readonly IncidentCode[];
  targetTypes: readonly ProcedureTargetType[];
  effects: readonly ProcedureIncidentEffect[];
}

export interface OperationalProcedure {
  schemaVersion: "paris-icc.operational-procedure.v1";
  procedureId: ProcedureId;
  revision: string;
  title: string;
  summary: string;
  effectiveFrom: number;
  validUntil: number | null;
  source: ProcedureSource;
  applicability: ProcedureApplicability;
  steps: readonly ProcedureStep[];
  returnToNormal: ReturnToNormalPolicy;
  /** SHA-256 of the canonical document excluding this field. */
  contentHash: string;
}

export interface IncidentClassificationInput {
  type: ProcedureIncidentType;
  targetType: ProcedureTargetType;
  effect: ProcedureIncidentEffect;
}

export interface ProcedureSearchInput {
  incidentCode: IncidentCode | string;
  targetType: ProcedureTargetType;
  effect: ProcedureIncidentEffect;
  atTime?: number;
  limit?: number;
}

export interface OperationalProcedureSearchResult {
  procedureId: ProcedureId;
  revision: string;
  title: string;
  summary: string;
  contentHash: string;
  sourceKind: ProcedureSource["kind"];
  official: false;
  matchedIncidentCode: IncidentCode;
  matchedTargetType: ProcedureTargetType;
  matchedEffect: ProcedureIncidentEffect;
  effectiveFrom: number;
  validUntil: number | null;
}

export interface OperationalProcedureCatalogueMetadata {
  schemaVersion: "paris-icc.procedure-catalogue.v1";
  catalogueId: "paris-icc-operational-procedures";
  revision: string;
  sourceKind: ProcedureSource["kind"];
  official: false;
  notice: string;
  procedureCount: number;
  hashAlgorithm: "sha256";
  contentHash: string;
}
