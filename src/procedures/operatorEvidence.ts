import type {
  OperatorEvidenceReferenceKind,
  ProcedureStep,
} from "./types";

export const OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH = 160;

export interface OperatorEvidenceReferenceRequirement {
  kind: OperatorEvidenceReferenceKind;
  label: string;
  placeholder: string;
  helpText: string;
  maxLength: typeof OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH;
}

type EvidenceBearingStep = object & Partial<Pick<
  ProcedureStep,
  "requiredEvidenceReferenceKind"
>>;

const WORKS_HANDBACK: OperatorEvidenceReferenceRequirement = Object.freeze({
  kind: "works-handback",
  label: "Engineering handback reference",
  placeholder: "e.g. HAND-2026-08-30-042",
  helpText: "Enter the explicit reference issued by the competent works handback authority.",
  maxLength: OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH,
});

const POLICE_CLEARANCE: OperatorEvidenceReferenceRequirement = Object.freeze({
  kind: "police-clearance",
  label: "Police clearance reference",
  placeholder: "e.g. POL-2026-08-30-117",
  helpText: "Enter the explicit reference issued by the police or security authority.",
  maxLength: OPERATOR_EVIDENCE_REFERENCE_MAX_LENGTH,
});

/**
 * Resolve the immutable machine gate. Editable prose must never change whether
 * an externally issued authority reference is required.
 */
export function operatorEvidenceReferenceRequirement(
  step: EvidenceBearingStep,
): OperatorEvidenceReferenceRequirement | null {
  switch (step.requiredEvidenceReferenceKind) {
    case "police-clearance":
      return POLICE_CLEARANCE;
    case "works-handback":
      return WORKS_HANDBACK;
    default:
      return null;
  }
}
