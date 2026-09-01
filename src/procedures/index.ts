import { OPERATIONAL_PROCEDURE_CATALOGUE } from "./catalogue";
import type {
  IncidentClassificationInput,
  IncidentCode,
  OperationalProcedure,
  OperationalProcedureSearchResult,
  ProcedureId,
  ProcedureIncidentEffect,
  ProcedureIncidentType,
  ProcedureSearchInput,
  ProcedureTargetType,
} from "./types";

const TYPE_CODE: Readonly<Record<ProcedureIncidentType, string>> = Object.freeze({
  infrastructure: "INF",
  passenger: "PAX",
  "rolling-stock": "RST",
  staff: "STF",
  power: "PWR",
  works: "WRK",
  external: "EXT",
  communications: "COM",
  security: "SEC",
});

const TARGET_CODE: Readonly<Record<ProcedureTargetType, string>> = Object.freeze({
  train: "TRN",
  station: "STA",
  interstation: "INT",
  power: "PWR",
  line: "LIN",
});

const EFFECT_CODE: Readonly<Record<ProcedureIncidentEffect, string>> = Object.freeze({
  "stop-train": "IMM",
  "station-closure": "CLS",
  "station-dwell": "DWL",
  "block-interstation": "BLK",
  "reduce-speed": "SPD",
  "degrade-power": "DEG",
  "isolate-power": "ISO",
  "communication-degraded": "DEG",
  "communication-loss": "LOS",
  "abandoned-baggage": "BAG",
  "tow-train": "TOW",
});

const ALLOWED_EFFECTS: Readonly<Record<ProcedureTargetType, readonly ProcedureIncidentEffect[]>> =
  Object.freeze({
    train: Object.freeze(["stop-train", "tow-train"] as ProcedureIncidentEffect[]),
    station: Object.freeze(["station-closure", "station-dwell", "abandoned-baggage"] as ProcedureIncidentEffect[]),
    interstation: Object.freeze(["block-interstation", "reduce-speed"] as ProcedureIncidentEffect[]),
    power: Object.freeze(["degrade-power", "isolate-power"] as ProcedureIncidentEffect[]),
    line: Object.freeze(["communication-degraded", "communication-loss"] as ProcedureIncidentEffect[]),
  });

const ALLOWED_TYPES: Readonly<Record<ProcedureTargetType, readonly ProcedureIncidentType[]>> =
  Object.freeze({
    train: Object.freeze(["rolling-stock", "passenger", "external", "staff"] as ProcedureIncidentType[]),
    station: Object.freeze(["passenger", "infrastructure", "works", "external", "security"] as ProcedureIncidentType[]),
    interstation: Object.freeze(["infrastructure", "works", "external"] as ProcedureIncidentType[]),
    power: Object.freeze(["power", "infrastructure", "works", "external"] as ProcedureIncidentType[]),
    line: Object.freeze(["communications", "infrastructure", "external"] as ProcedureIncidentType[]),
  });

export const UNKNOWN_INCIDENT_CODE: IncidentCode = "ICC-INC-UNK-000";

/** Classify every semantic combination exposed by the simulator form. */
export function classifyIncidentCode(input: IncidentClassificationInput): IncidentCode {
  const typeCode = TYPE_CODE[input.type];
  const targetCode = TARGET_CODE[input.targetType];
  const effectCode = EFFECT_CODE[input.effect];
  if (
    !typeCode ||
    !targetCode ||
    !effectCode ||
    !ALLOWED_TYPES[input.targetType]?.includes(input.type) ||
    !ALLOWED_EFFECTS[input.targetType]?.includes(input.effect)
  ) {
    return UNKNOWN_INCIDENT_CODE;
  }
  return `ICC-INC-${typeCode}-${targetCode}-${effectCode}-001`;
}

function validatedSearchTime(value: number | undefined): number {
  if (value === undefined) return Date.now();
  if (!Number.isFinite(value)) throw new RangeError("atTime must be a finite timestamp");
  return value;
}

function validatedLimit(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("limit must be a positive finite number");
  }
  return Math.min(50, Math.floor(value));
}

function activeAt(procedure: OperationalProcedure, atTime: number): boolean {
  return procedure.effectiveFrom <= atTime &&
    (procedure.validUntil === null || atTime <= procedure.validUntil);
}

/**
 * Return procedure metadata matching qualified incident evidence. Callers must
 * explicitly retrieve the selected revision before proposing any action.
 */
export function searchOperationalProcedures(
  input: ProcedureSearchInput,
): readonly OperationalProcedureSearchResult[] {
  const atTime = validatedSearchTime(input.atTime);
  const limit = validatedLimit(input.limit);
  const incidentCode = input.incidentCode as IncidentCode;
  if (incidentCode === UNKNOWN_INCIDENT_CODE) return Object.freeze([]);

  return Object.freeze(OPERATIONAL_PROCEDURE_CATALOGUE
    .filter((procedure) =>
      activeAt(procedure, atTime) &&
      procedure.applicability.incidentCodes.includes(incidentCode) &&
      procedure.applicability.targetTypes.includes(input.targetType) &&
      procedure.applicability.effects.includes(input.effect)
    )
    .sort((left, right) =>
      right.effectiveFrom - left.effectiveFrom ||
      right.revision.localeCompare(left.revision) ||
      left.procedureId.localeCompare(right.procedureId)
    )
    .slice(0, limit)
    .map((procedure) => Object.freeze({
      procedureId: procedure.procedureId,
      revision: procedure.revision,
      title: procedure.title,
      summary: procedure.summary,
      contentHash: procedure.contentHash,
      sourceKind: procedure.source.kind,
      official: procedure.source.official,
      matchedIncidentCode: incidentCode,
      matchedTargetType: input.targetType,
      matchedEffect: input.effect,
      effectiveFrom: procedure.effectiveFrom,
      validUntil: procedure.validUntil,
    })));
}

/** Retrieve one exact procedure revision; unknown IDs/revisions never fall back. */
export function getOperationalProcedure(
  id: ProcedureId | string,
  revision?: string,
): OperationalProcedure | null {
  return OPERATIONAL_PROCEDURE_CATALOGUE.find((procedure) =>
    procedure.procedureId === id && (revision === undefined || procedure.revision === revision)
  ) ?? null;
}

export {
  DEMO_NOTICE,
  DEMO_OPERATIONAL_PROCEDURES,
  OPERATIONAL_PROCEDURE_CATALOGUE,
  OPERATIONAL_PROCEDURE_CATALOGUE_METADATA,
  PROCEDURE_CATALOG_REVISION,
  PROCEDURE_CATALOGUE_METADATA,
} from "./catalogue";

export {
  OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH,
  operatorEvidenceReferenceRequirement,
} from "./operatorEvidence";

export {
  EDITABLE_PROCEDURE_STEP_FIELDS,
  PROCEDURE_WORKSPACE_SCHEMA_VERSION,
  ProcedureWorkspaceError,
  createProcedureWorkspace,
  getProcedureRevision,
  listActiveProcedures,
  migrateProcedureWorkspace,
  projectProcedureWorkspace,
  publishProcedureStepPatch,
  resolveActiveProcedure,
  searchProcedureWorkspace,
} from "./registry";

export {
  canonicalProcedureJson,
  canonicalSha256,
  hasValidProcedureContentHash,
  procedureContentHash,
} from "./integrity";

export type {
  EditableProcedureStepField,
  ProcedureStepEditablePatch,
  ProcedureVersionReference,
  ProcedureWorkspaceErrorCode,
  ProcedureWorkspaceProjection,
  ProcedureWorkspaceState,
  PublishProcedureStepPatchCommand,
  PublishProcedureStepPatchResult,
} from "./registry";

export type {
  IncidentClassificationInput,
  IncidentCode,
  OperationalProcedure,
  OperationalProcedureCatalogueMetadata,
  OperationalProcedureSearchResult,
  OperatorEvidenceReferenceKind,
  ProcedureApplicability,
  ProcedureCapability,
  ProcedureId,
  ProcedureIncidentEffect,
  ProcedureIncidentType,
  ProcedurePhase,
  ProcedureSearchInput,
  ProcedureSource,
  ProcedureStep,
  ProcedureTargetType,
  ReturnToNormalCriterion,
  ReturnToNormalPolicy,
} from "./types";
