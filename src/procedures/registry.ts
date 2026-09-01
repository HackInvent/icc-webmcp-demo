import { OPERATIONAL_PROCEDURE_CATALOGUE } from "./catalogue";
import { canonicalSha256, hasValidProcedureContentHash, procedureContentHash } from "./integrity";
import type {
  IncidentCode,
  OperationalProcedure,
  OperationalProcedureSearchResult,
  ProcedureId,
  ProcedureSearchInput,
  ProcedureStep,
  ProcedureStepDurationRange,
} from "./types";

export const PROCEDURE_WORKSPACE_SCHEMA_VERSION =
  "paris-icc.procedure-workspace.v1" as const;

export const EDITABLE_PROCEDURE_STEP_FIELDS = Object.freeze([
  "title", "instruction", "rationale", "responsibleRole", "preconditions",
  "evidenceRequired", "completionCriteria", "durationRangeSeconds",
] as const);

export type EditableProcedureStepField =
  typeof EDITABLE_PROCEDURE_STEP_FIELDS[number];

export type ProcedureStepEditablePatch = Partial<Pick<
  ProcedureStep,
  EditableProcedureStepField
>>;

export interface ProcedureVersionReference {
  procedureId: ProcedureId | string;
  revision: string;
}

export interface ProcedureWorkspaceState {
  schemaVersion: typeof PROCEDURE_WORKSPACE_SCHEMA_VERSION;
  sequence: number;
  revision: string;
  contentHash: string;
  activeOverrides: Readonly<Record<string, string>>;
  versions: readonly OperationalProcedure[];
}

export interface ProcedureWorkspaceProjection {
  schemaVersion: typeof PROCEDURE_WORKSPACE_SCHEMA_VERSION;
  sequence: number;
  revision: string;
  contentHash: string;
  activeOverrides: Readonly<Record<string, string>>;
  referencedVersions: readonly OperationalProcedure[];
}

export interface PublishProcedureStepPatchCommand {
  procedureId: ProcedureId | string;
  stepId: string;
  expectedProcedureRevision: string;
  expectedProcedureContentHash: string;
  patch: ProcedureStepEditablePatch;
}

export interface PublishProcedureStepPatchResult {
  state: ProcedureWorkspaceState;
  procedure: OperationalProcedure;
  previousRevision: string;
  previousContentHash: string;
  changedFields: readonly EditableProcedureStepField[];
}

export type ProcedureWorkspaceErrorCode =
  | "invalid_input"
  | "procedure_not_found"
  | "step_not_found"
  | "revision_conflict"
  | "hash_conflict"
  | "no_change"
  | "integrity_error";

export class ProcedureWorkspaceError extends Error {
  readonly code: ProcedureWorkspaceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ProcedureWorkspaceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProcedureWorkspaceError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

const BASELINES = new Map(
  OPERATIONAL_PROCEDURE_CATALOGUE.map((procedure) => [procedure.procedureId, procedure]),
);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_DURATION_SECONDS = 604_800;
const MAX_INSTRUCTION_LENGTH = 1_400;
const MAX_RATIONALE_LENGTH = 900;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(
  code: ProcedureWorkspaceErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ProcedureWorkspaceError(code, message, details);
}

function workspaceRevision(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999_999) {
    return fail("integrity_error", "Procedure workspace sequence is outside the supported range.", { sequence });
  }
  return `ws.${String(sequence).padStart(6, "0")}`;
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fail("invalid_input", `${field} must be a string.`, { field });
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized) return fail("invalid_input", `${field} must not be empty.`, { field });
  if (normalized.length > maxLength) {
    return fail("invalid_input", `${field} exceeds its maximum length.`, { field, maxLength });
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    return fail("invalid_input", `${field} contains a control character.`, { field });
  }
  return normalized;
}

function normalizeList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    return fail("invalid_input", `${field} must be an array of strings.`, { field });
  }
  if (value.length > 32) {
    return fail("invalid_input", `${field} has too many entries.`, { field, maxItems: 32 });
  }
  const result = value.map((item, index) =>
    normalizeText(item, `${field}[${index}]`, 500)
  );
  if (new Set(result).size !== result.length) {
    return fail("invalid_input", `${field} must contain unique normalized entries.`, { field });
  }
  return Object.freeze(result);
}

function normalizeDuration(value: unknown): ProcedureStepDurationRange {
  if (!isRecord(value)) {
    return fail("invalid_input", "durationRangeSeconds must be an object.");
  }
  const expected = ["minSeconds", "nominalSeconds", "maxSeconds"];
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys.some((key) => !expected.includes(key))) {
    return fail("invalid_input", "durationRangeSeconds accepts exactly minSeconds, nominalSeconds, and maxSeconds.", { keys });
  }
  const read = (key: string): number => {
    const item = value[key];
    if (typeof item !== "number" || !Number.isSafeInteger(item) ||
        item < 0 || item > MAX_DURATION_SECONDS) {
      return fail("invalid_input", `durationRangeSeconds.${key} must be an integer between 0 and ${MAX_DURATION_SECONDS}.`);
    }
    return item;
  };
  const minSeconds = read("minSeconds");
  const nominalSeconds = read("nominalSeconds");
  const maxSeconds = read("maxSeconds");
  if (minSeconds > nominalSeconds || nominalSeconds > maxSeconds) {
    return fail("invalid_input", "Duration must satisfy minSeconds <= nominalSeconds <= maxSeconds.");
  }
  return Object.freeze({ minSeconds, nominalSeconds, maxSeconds });
}

function normalizeEditableStep(source: Record<string, unknown>): Pick<
  ProcedureStep,
  EditableProcedureStepField
> {
  return {
    title: normalizeText(source.title, "title", 200),
    instruction: normalizeText(source.instruction, "instruction", MAX_INSTRUCTION_LENGTH),
    rationale: normalizeText(source.rationale, "rationale", MAX_RATIONALE_LENGTH),
    responsibleRole: normalizeText(source.responsibleRole, "responsibleRole", 160),
    preconditions: normalizeList(source.preconditions, "preconditions"),
    evidenceRequired: normalizeList(source.evidenceRequired, "evidenceRequired"),
    completionCriteria: normalizeList(source.completionCriteria, "completionCriteria"),
    durationRangeSeconds: normalizeDuration(source.durationRangeSeconds),
  };
}

function normalizePatch(value: unknown): {
  patch: ProcedureStepEditablePatch;
  fields: readonly EditableProcedureStepField[];
} {
  if (!isRecord(value)) return fail("invalid_input", "patch must be an object.");
  const keys = Object.keys(value);
  if (keys.length === 0) return fail("invalid_input", "patch must edit at least one step attribute.");
  const allowed = new Set<string>(EDITABLE_PROCEDURE_STEP_FIELDS);
  const forbidden = keys.filter((key) => !allowed.has(key));
  if (forbidden.length) {
    return fail("invalid_input", "The patch contains locked or unknown fields.", {
      forbiddenFields: forbidden.sort(),
      editableFields: EDITABLE_PROCEDURE_STEP_FIELDS,
    });
  }
  const patch: ProcedureStepEditablePatch = {};
  for (const key of keys as EditableProcedureStepField[]) {
    if (key === "title") patch.title = normalizeText(value[key], key, 200);
    else if (key === "instruction") patch.instruction = normalizeText(value[key], key, MAX_INSTRUCTION_LENGTH);
    else if (key === "rationale") patch.rationale = normalizeText(value[key], key, MAX_RATIONALE_LENGTH);
    else if (key === "responsibleRole") patch.responsibleRole = normalizeText(value[key], key, 160);
    else if (key === "durationRangeSeconds") patch.durationRangeSeconds = normalizeDuration(value[key]);
    else patch[key] = normalizeList(value[key], key);
  }
  return { patch, fields: Object.freeze(keys as EditableProcedureStepField[]) };
}

function same(left: unknown, right: unknown): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

function hasExactKeys(
  value: Record<string, unknown>,
  reference: object,
): boolean {
  const actual = Object.keys(value).sort();
  const expected = Object.keys(reference).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function editedSequence(revision: string, baseRevision: string): number | null {
  const prefix = `${baseRevision}-ws.`;
  if (!revision.startsWith(prefix)) return null;
  const suffix = revision.slice(prefix.length);
  if (!/^\d{6}$/.test(suffix)) return null;
  const sequence = Number(suffix);
  return sequence > 0 ? sequence : null;
}

function hydrateEditedProcedure(value: unknown): OperationalProcedure {
  if (!isRecord(value)) return fail("integrity_error", "An edited procedure version must be an object.");
  if (typeof value.procedureId !== "string" || typeof value.revision !== "string") {
    return fail("integrity_error", "An edited procedure has no valid ID or revision.");
  }
  const baseline = BASELINES.get(value.procedureId as ProcedureId);
  if (!baseline) return fail("integrity_error", "An edited procedure has no static baseline.", { procedureId: value.procedureId });
  if (!hasExactKeys(value, baseline)) {
    return fail("integrity_error", "An edited procedure has missing or unknown procedure-level fields.", {
      procedureId: value.procedureId,
    });
  }
  if (editedSequence(value.revision, baseline.revision) === null) {
    return fail("integrity_error", "An edited revision is not derived from its baseline.", {
      procedureId: value.procedureId, revision: value.revision,
    });
  }
  if (typeof value.contentHash !== "string" || !HASH_PATTERN.test(value.contentHash)) {
    return fail("integrity_error", "An edited procedure has an invalid content hash.");
  }
  const procedureLocked = {
    schemaVersion: value.schemaVersion, procedureId: value.procedureId,
    title: value.title, summary: value.summary, effectiveFrom: value.effectiveFrom,
    validUntil: value.validUntil, source: value.source, applicability: value.applicability,
    returnToNormal: value.returnToNormal,
  };
  const baselineLocked = {
    schemaVersion: baseline.schemaVersion, procedureId: baseline.procedureId,
    title: baseline.title, summary: baseline.summary, effectiveFrom: baseline.effectiveFrom,
    validUntil: baseline.validUntil, source: baseline.source, applicability: baseline.applicability,
    returnToNormal: baseline.returnToNormal,
  };
  if (!same(procedureLocked, baselineLocked)) {
    return fail("integrity_error", "An edited revision changes locked procedure-level fields.", { procedureId: baseline.procedureId });
  }
  if (!Array.isArray(value.steps) || value.steps.length !== baseline.steps.length) {
    return fail("integrity_error", "An edited revision must retain every baseline step.", { procedureId: baseline.procedureId });
  }
  const steps = value.steps.map((candidate, index) => {
    if (!isRecord(candidate)) return fail("integrity_error", "An edited procedure step must be an object.");
    const baseStep = baseline.steps[index];
    if (!hasExactKeys(candidate, baseStep)) {
      return fail("integrity_error", "An edited procedure step has missing or unknown fields.", {
        procedureId: baseline.procedureId,
        stepId: baseStep.stepId,
      });
    }
    const locked = {
      stepId: candidate.stepId, order: candidate.order, phase: candidate.phase,
      mandatory: candidate.mandatory, capability: candidate.capability,
      operatorConfirmationRequired: candidate.operatorConfirmationRequired,
      requiredEvidenceReferenceKind: candidate.requiredEvidenceReferenceKind,
    };
    const baselineStepLocked = {
      stepId: baseStep.stepId, order: baseStep.order, phase: baseStep.phase,
      mandatory: baseStep.mandatory, capability: baseStep.capability,
      operatorConfirmationRequired: baseStep.operatorConfirmationRequired,
      requiredEvidenceReferenceKind: baseStep.requiredEvidenceReferenceKind,
    };
    if (!same(locked, baselineStepLocked)) {
      return fail("integrity_error", "An edited revision changes locked step fields.", {
        procedureId: baseline.procedureId, stepId: baseStep.stepId,
      });
    }
    return Object.freeze({ ...baseStep, ...normalizeEditableStep(candidate) });
  });
  const procedure = Object.freeze({
    ...baseline,
    revision: value.revision,
    steps: Object.freeze(steps),
    contentHash: value.contentHash,
  });
  if (!hasValidProcedureContentHash(procedure)) {
    return fail("integrity_error", "An edited procedure content hash does not match its canonical document.", {
      procedureId: procedure.procedureId, revision: procedure.revision,
    });
  }
  return procedure;
}

function freezeOverrides(value: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function buildState(
  sequence: number,
  activeOverrides: Record<string, string>,
  versions: readonly OperationalProcedure[],
): ProcedureWorkspaceState {
  const unsigned = {
    schemaVersion: PROCEDURE_WORKSPACE_SCHEMA_VERSION,
    sequence,
    revision: workspaceRevision(sequence),
    activeOverrides: freezeOverrides(activeOverrides),
    versions: Object.freeze([...versions]),
  };
  return Object.freeze({ ...unsigned, contentHash: canonicalSha256(unsigned) });
}

export function createProcedureWorkspace(): ProcedureWorkspaceState {
  return buildState(0, {}, []);
}

export function migrateProcedureWorkspace(input: unknown): ProcedureWorkspaceState {
  if (input === undefined || input === null) return createProcedureWorkspace();
  if (!isRecord(input)) {
    return fail("integrity_error", "The procedure workspace snapshot must be an object.");
  }
  if (input.schemaVersion !== undefined &&
      input.schemaVersion !== PROCEDURE_WORKSPACE_SCHEMA_VERSION) {
    return fail("integrity_error", "Unsupported procedure workspace schema version.", {
      schemaVersion: input.schemaVersion,
    });
  }
  const sourceVersions = input.versions ?? input.referencedVersions ?? [];
  if (!Array.isArray(sourceVersions)) {
    return fail("integrity_error", "Procedure workspace versions must be an array.");
  }
  const versions = sourceVersions.map(hydrateEditedProcedure);
  const versionKeys = new Set<string>();
  for (const procedure of versions) {
    const key = `${procedure.procedureId}@${procedure.revision}`;
    if (versionKeys.has(key)) {
      return fail("integrity_error", "The procedure workspace contains a duplicate revision.", {
        procedureId: procedure.procedureId, revision: procedure.revision,
      });
    }
    versionKeys.add(key);
  }

  const rawOverrides = input.activeOverrides ?? {};
  if (!isRecord(rawOverrides)) {
    return fail("integrity_error", "activeOverrides must be an object.");
  }
  const activeOverrides: Record<string, string> = {};
  for (const [procedureId, revision] of Object.entries(rawOverrides)) {
    if (typeof revision !== "string") {
      return fail("integrity_error", "An active override revision must be a string.", { procedureId });
    }
    if (!BASELINES.has(procedureId as ProcedureId)) {
      return fail("integrity_error", "An active override has no static baseline.", { procedureId });
    }
    if (!versionKeys.has(`${procedureId}@${revision}`)) {
      return fail("integrity_error", "An active override does not reference a stored edited version.", {
        procedureId, revision,
      });
    }
    activeOverrides[procedureId] = revision;
  }

  const inferredSequence = versions.length;
  const sequence = input.sequence === undefined ? inferredSequence : input.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < inferredSequence) {
    return fail("integrity_error", "The procedure workspace sequence is invalid.", {
      sequence, minimum: inferredSequence,
    });
  }
  const revision = workspaceRevision(sequence as number);
  if (input.revision !== undefined && input.revision !== revision) {
    return fail("integrity_error", "The procedure workspace revision does not match its sequence.", {
      revision: input.revision, expectedRevision: revision,
    });
  }

  if (input.contentHash !== undefined) {
    if (typeof input.contentHash !== "string" || !HASH_PATTERN.test(input.contentHash)) {
      return fail("integrity_error", "The procedure workspace content hash is invalid.");
    }
    const common = {
      schemaVersion: PROCEDURE_WORKSPACE_SCHEMA_VERSION,
      sequence: sequence as number,
      revision,
      activeOverrides: freezeOverrides(activeOverrides),
    };
    const unsigned = input.referencedVersions !== undefined && input.versions === undefined
      ? { ...common, referencedVersions: Object.freeze([...versions]) }
      : { ...common, versions: Object.freeze([...versions]) };
    if (input.contentHash !== canonicalSha256(unsigned)) {
      return fail("integrity_error", "The procedure workspace hash does not match its canonical snapshot.");
    }
  }
  return buildState(sequence as number, activeOverrides, versions);
}

export function resolveActiveProcedure(
  state: ProcedureWorkspaceState,
  procedureId: ProcedureId | string,
): OperationalProcedure | null {
  const baseline = BASELINES.get(procedureId as ProcedureId);
  if (!baseline) return null;
  const revision = state.activeOverrides[procedureId];
  if (!revision) return baseline;
  return state.versions.find((procedure) =>
    procedure.procedureId === procedureId && procedure.revision === revision
  ) ?? null;
}

export function listActiveProcedures(
  state: ProcedureWorkspaceState,
): readonly OperationalProcedure[] {
  return Object.freeze(OPERATIONAL_PROCEDURE_CATALOGUE.map((baseline) => {
    const procedure = resolveActiveProcedure(state, baseline.procedureId);
    if (!procedure) {
      return fail("integrity_error", "The active procedure override cannot be resolved.", {
        procedureId: baseline.procedureId,
      });
    }
    return procedure;
  }));
}

export function getProcedureRevision(
  state: ProcedureWorkspaceState,
  procedureId: ProcedureId | string,
  revision: string,
): OperationalProcedure | null {
  const baseline = BASELINES.get(procedureId as ProcedureId);
  if (!baseline) return null;
  if (baseline.revision === revision) return baseline;
  return state.versions.find((procedure) =>
    procedure.procedureId === procedureId && procedure.revision === revision
  ) ?? null;
}

function searchTime(value: number | undefined): number {
  if (value === undefined) return Date.now();
  if (!Number.isFinite(value)) throw new RangeError("atTime must be a finite timestamp");
  return value;
}

function searchLimit(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("limit must be a positive finite number");
  }
  return Math.min(50, Math.floor(value));
}

export function searchProcedureWorkspace(
  state: ProcedureWorkspaceState,
  input: ProcedureSearchInput,
): readonly OperationalProcedureSearchResult[] {
  const atTime = searchTime(input.atTime);
  const limit = searchLimit(input.limit);
  const incidentCode = input.incidentCode as IncidentCode;
  if (incidentCode === "ICC-INC-UNK-000") return Object.freeze([]);
  return Object.freeze(listActiveProcedures(state)
    .filter((procedure) =>
      procedure.effectiveFrom <= atTime &&
      (procedure.validUntil === null || atTime <= procedure.validUntil) &&
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

function nextProcedureRevision(
  state: ProcedureWorkspaceState,
  baseline: OperationalProcedure,
): string {
  const maximum = state.versions
    .filter((procedure) => procedure.procedureId === baseline.procedureId)
    .reduce((current, procedure) =>
      Math.max(current, editedSequence(procedure.revision, baseline.revision) ?? 0),
    0);
  if (maximum >= 999_999) {
    return fail("integrity_error", "The procedure revision sequence is exhausted.", {
      procedureId: baseline.procedureId,
    });
  }
  return `${baseline.revision}-ws.${String(maximum + 1).padStart(6, "0")}`;
}

export function publishProcedureStepPatch(
  state: ProcedureWorkspaceState,
  command: PublishProcedureStepPatchCommand,
): PublishProcedureStepPatchResult {
  if (!isRecord(command)) {
    return fail("invalid_input", "The procedure publication command must be an object.");
  }
  const allowedKeys = new Set([
    "procedureId", "stepId", "expectedProcedureRevision",
    "expectedProcedureContentHash", "patch",
  ]);
  const unknownFields = Object.keys(command).filter((key) => !allowedKeys.has(key));
  if (unknownFields.length) {
    return fail("invalid_input", "The procedure publication command contains unknown fields.", {
      unknownFields: unknownFields.sort(),
    });
  }
  const {
    procedureId, stepId, expectedProcedureRevision, expectedProcedureContentHash,
  } = command;
  if (typeof procedureId !== "string" || !procedureId) {
    return fail("invalid_input", "procedureId is required.");
  }
  if (typeof stepId !== "string" || !stepId) {
    return fail("invalid_input", "stepId is required.");
  }
  if (typeof expectedProcedureRevision !== "string" || !expectedProcedureRevision) {
    return fail("invalid_input", "expectedProcedureRevision is required.");
  }
  if (typeof expectedProcedureContentHash !== "string" ||
      !HASH_PATTERN.test(expectedProcedureContentHash)) {
    return fail("invalid_input", "expectedProcedureContentHash must be a SHA-256 hash.");
  }
  const baseline = BASELINES.get(procedureId as ProcedureId);
  if (!baseline) return fail("procedure_not_found", "The procedure does not exist.", { procedureId });
  const active = resolveActiveProcedure(state, procedureId);
  if (!active) return fail("integrity_error", "The active procedure cannot be resolved.", { procedureId });
  if (active.revision !== expectedProcedureRevision) {
    return fail("revision_conflict", "The procedure revision changed before publication.", {
      expectedProcedureRevision, currentProcedureRevision: active.revision,
    });
  }
  if (active.contentHash !== expectedProcedureContentHash) {
    return fail("hash_conflict", "The procedure content changed before publication.", {
      expectedProcedureContentHash, currentProcedureContentHash: active.contentHash,
    });
  }
  const stepIndex = active.steps.findIndex((step) => step.stepId === stepId);
  if (stepIndex < 0) {
    return fail("step_not_found", "The procedure step does not exist.", { procedureId, stepId });
  }
  const normalized = normalizePatch(command.patch);
  const currentStep = active.steps[stepIndex];
  const editedStep = Object.freeze({ ...currentStep, ...normalized.patch });
  const changedFields = normalized.fields.filter((field) =>
    !same(currentStep[field], editedStep[field])
  );
  if (!changedFields.length) {
    return fail("no_change", "The normalized patch does not change the active step.", {
      procedureId, stepId,
    });
  }
  const revision = nextProcedureRevision(state, baseline);
  const { contentHash: _previousHash, ...activeDocument } = active;
  const document = {
    ...activeDocument,
    revision,
    steps: Object.freeze(active.steps.map((step, index) =>
      index === stepIndex ? editedStep : step
    )),
  };
  const procedure = Object.freeze({
    ...document,
    contentHash: procedureContentHash(document),
  });
  const nextState = buildState(
    state.sequence + 1,
    { ...state.activeOverrides, [procedureId]: revision },
    [...state.versions, procedure],
  );
  return Object.freeze({
    state: nextState,
    procedure,
    previousRevision: active.revision,
    previousContentHash: active.contentHash,
    changedFields: Object.freeze(changedFields),
  });
}

export function projectProcedureWorkspace(
  state: ProcedureWorkspaceState,
  referencedVersions: readonly ProcedureVersionReference[] = [],
): ProcedureWorkspaceProjection {
  const keys = new Set(Object.entries(state.activeOverrides).map(
    ([procedureId, revision]) => `${procedureId}@${revision}`,
  ));
  for (const reference of referencedVersions) {
    if (!reference || typeof reference.procedureId !== "string" ||
        typeof reference.revision !== "string") {
      return fail("invalid_input", "Every version reference requires procedureId and revision.");
    }
    const exact = getProcedureRevision(state, reference.procedureId, reference.revision);
    if (!exact) {
      return fail("procedure_not_found", "A referenced procedure revision does not exist.", {
        procedureId: reference.procedureId, revision: reference.revision,
      });
    }
    if (state.versions.includes(exact)) {
      keys.add(`${reference.procedureId}@${reference.revision}`);
    }
  }
  const selected = Object.freeze(state.versions.filter((procedure) =>
    keys.has(`${procedure.procedureId}@${procedure.revision}`)
  ));
  const unsigned = {
    schemaVersion: PROCEDURE_WORKSPACE_SCHEMA_VERSION,
    sequence: state.sequence,
    revision: state.revision,
    activeOverrides: state.activeOverrides,
    referencedVersions: selected,
  };
  return Object.freeze({ ...unsigned, contentHash: canonicalSha256(unsigned) });
}
