import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OperationalProcedure,
  ProcedureStep,
} from "../procedures";
import type { ProcedureStepDurationRange } from "../procedures/types";
import type {
  ProcedureFeedbackField,
  ProcedureFeedbackHandler,
  ProcedureFeedbackResponse,
  ProcedureFieldFeedback,
} from "../procedures/feedback";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { StatusPill } from "./StatusPill";
import "./ProcedureEditorModal.css";

export type EditableProcedureStepPatch = Partial<Pick<ProcedureStep,
  | "title"
  | "instruction"
  | "rationale"
  | "responsibleRole"
  | "preconditions"
  | "evidenceRequired"
  | "completionCriteria"
  | "durationRangeSeconds"
>>;

export interface PublishProcedureStepInput {
  procedureId: string;
  expectedProcedureRevision: string;
  expectedProcedureContentHash: string;
  stepId: string;
  patch: EditableProcedureStepPatch;
}

export type PublishProcedureStepHandler = (
  input: PublishProcedureStepInput,
) => Promise<unknown>;

export interface ProcedureStepEditorValues {
  title: string;
  instruction: string;
  rationale: string;
  responsibleRole: string;
  preconditions: string;
  evidenceRequired: string;
  completionCriteria: string;
  minSeconds: string;
  nominalSeconds: string;
  maxSeconds: string;
}

export type ProcedureStepEditorErrors = Partial<Record<keyof ProcedureStepEditorValues, string>>;

interface ProcedureEditorModalProps {
  procedure: OperationalProcedure;
  initialStepId?: string;
  onClose: () => void;
  onPublishStep?: PublishProcedureStepHandler;
  onRequestAgentFeedback?: ProcedureFeedbackHandler;
}

const MUTABLE_FIELD_LABELS: Readonly<Record<keyof EditableProcedureStepPatch, string>> = {
  title: "Title",
  instruction: "Operator instruction",
  rationale: "Rationale",
  responsibleRole: "Responsible role",
  preconditions: "Preconditions",
  evidenceRequired: "Required evidence",
  completionCriteria: "Completion criteria",
  durationRangeSeconds: "Planning duration",
};

const TEXT_LIMITS = {
  title: 200,
  instruction: 1_400,
  rationale: 900,
  responsibleRole: 160,
} as const;
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_LENGTH = 500;
const MAX_DURATION_SECONDS = 604_800;

const FEEDBACK_BASIS_LABELS = Object.freeze({
  "operator-history": "Previous edits",
  "operational-rex": "Operational REX",
  "public-source": "Public source",
  "general-knowledge": "General guidance",
});

function ProcedureFieldAgentFeedback({
  feedback,
  stale,
}: {
  feedback: ProcedureFieldFeedback | undefined;
  stale: boolean;
}) {
  if (!feedback) return null;
  return (
    <aside
      className={`procedure-editor__field-feedback${stale ? " is-stale" : ""}`}
      data-testid={`procedure-editor-agent-field-${feedback.field}`}
    >
      <header>
        <span><Icon name="radio" size={14}/> Agent feedback</span>
        <div>
          {feedback.basis.map((basis) => (
            <small key={basis}>{FEEDBACK_BASIS_LABELS[basis]}</small>
          ))}
        </div>
      </header>
      <p>{feedback.assessment}</p>
      <p><strong>Suggestion</strong>{feedback.suggestion}</p>
      <small>{feedback.rationale}</small>
      {feedback.logEntryIds.length > 0 && (
        <footer>
          Evidence {feedback.logEntryIds.map((logId) => <code key={logId}>{logId}</code>)}
        </footer>
      )}
    </aside>
  );
}

function normalisedLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

export function procedureStepEditorValues(step: ProcedureStep): ProcedureStepEditorValues {
  return {
    title: step.title,
    instruction: step.instruction,
    rationale: step.rationale,
    responsibleRole: step.responsibleRole,
    preconditions: step.preconditions.join("\n"),
    evidenceRequired: step.evidenceRequired.join("\n"),
    completionCriteria: step.completionCriteria.join("\n"),
    minSeconds: String(step.durationRangeSeconds.minSeconds),
    nominalSeconds: String(step.durationRangeSeconds.nominalSeconds),
    maxSeconds: String(step.durationRangeSeconds.maxSeconds),
  };
}

export function validateProcedureStepEditor(
  values: ProcedureStepEditorValues,
): ProcedureStepEditorErrors {
  const errors: ProcedureStepEditorErrors = {};
  const requiredTextFields = [
    ["title", "Enter a concise step title."],
    ["instruction", "Enter the instruction shown to the operator."],
    ["rationale", "Explain why this step is required."],
    ["responsibleRole", "Identify the responsible operational role."],
  ] as const;
  for (const [field, message] of requiredTextFields) {
    if (!values[field].trim()) errors[field] = message;
    else if (values[field].normalize("NFC").trim().length > TEXT_LIMITS[field]) {
      errors[field] = `Use at most ${TEXT_LIMITS[field]} characters.`;
    }
  }

  const listFields = ["preconditions", "evidenceRequired", "completionCriteria"] as const;
  for (const field of listFields) {
    const items = normalisedLines(values[field]);
    if (items.length > MAX_LIST_ITEMS) {
      errors[field] = `Use at most ${MAX_LIST_ITEMS} items.`;
    } else if (items.some((item) => item.length > MAX_LIST_ITEM_LENGTH)) {
      errors[field] = `Use at most ${MAX_LIST_ITEM_LENGTH} characters per item.`;
    } else if (new Set(items).size !== items.length) {
      errors[field] = "Remove duplicate items.";
    }
  }
  if (normalisedLines(values.evidenceRequired).length === 0) {
    errors.evidenceRequired = "Add at least one item of required evidence.";
  }
  if (normalisedLines(values.completionCriteria).length === 0) {
    errors.completionCriteria = "Add at least one completion criterion.";
  }

  const durationFields = ["minSeconds", "nominalSeconds", "maxSeconds"] as const;
  const durations = durationFields.map((field) => Number(values[field]));
  durationFields.forEach((field, index) => {
    if (
      !values[field].trim() ||
      !Number.isInteger(durations[index]) ||
      durations[index] < 0 ||
      durations[index] > MAX_DURATION_SECONDS
    ) {
      errors[field] = `Use a whole number from 0 to ${MAX_DURATION_SECONDS} seconds.`;
    }
  });
  if (!errors.minSeconds && !errors.nominalSeconds && durations[1] < durations[0]) {
    errors.nominalSeconds = "Nominal duration must be greater than or equal to minimum.";
  }
  if (
    !errors.maxSeconds &&
    values.nominalSeconds.trim() &&
    Number.isInteger(durations[1]) &&
    durations[1] >= 0 &&
    durations[2] < durations[1]
  ) {
    errors.maxSeconds = "Maximum duration must be greater than or equal to nominal.";
  }

  return errors;
}

export function buildProcedureStepPatch(
  step: ProcedureStep,
  values: ProcedureStepEditorValues,
): EditableProcedureStepPatch {
  const patch: EditableProcedureStepPatch = {};
  const textFields = ["title", "instruction", "rationale", "responsibleRole"] as const;
  for (const field of textFields) {
    const nextValue = values[field].trim();
    if (nextValue !== step[field]) patch[field] = nextValue;
  }

  const listFields = ["preconditions", "evidenceRequired", "completionCriteria"] as const;
  for (const field of listFields) {
    const nextValue = normalisedLines(values[field]);
    if (!sameLines(nextValue, step[field])) patch[field] = nextValue;
  }

  const durationRangeSeconds: ProcedureStepDurationRange = {
    minSeconds: Number(values.minSeconds),
    nominalSeconds: Number(values.nominalSeconds),
    maxSeconds: Number(values.maxSeconds),
  };
  if (
    durationRangeSeconds.minSeconds !== step.durationRangeSeconds.minSeconds ||
    durationRangeSeconds.nominalSeconds !== step.durationRangeSeconds.nominalSeconds ||
    durationRangeSeconds.maxSeconds !== step.durationRangeSeconds.maxSeconds
  ) {
    patch.durationRangeSeconds = durationRangeSeconds;
  }

  return patch;
}

export function buildPublishProcedureStepInput(
  procedure: OperationalProcedure,
  step: ProcedureStep,
  values: ProcedureStepEditorValues,
): PublishProcedureStepInput {
  return {
    procedureId: procedure.procedureId,
    expectedProcedureRevision: procedure.revision,
    expectedProcedureContentHash: procedure.contentHash,
    stepId: step.stepId,
    patch: buildProcedureStepPatch(step, values),
  };
}

export function procedureEditorNavigationIndex(
  currentIndex: number,
  delta: -1 | 1,
  stepCount: number,
): number {
  return Math.max(0, Math.min(Math.max(0, stepCount - 1), currentIndex + delta));
}

function durationLabel(range: ProcedureStepDurationRange): string {
  return `${range.minSeconds}s / ${range.nominalSeconds}s / ${range.maxSeconds}s`;
}

export function ProcedureEditorModal({
  procedure,
  initialStepId,
  onClose,
  onPublishStep,
  onRequestAgentFeedback,
}: ProcedureEditorModalProps) {
  const initialIndex = Math.max(0, procedure.steps.findIndex((step) => step.stepId === initialStepId));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const activeStep = procedure.steps[activeIndex] ?? procedure.steps[0];
  const [values, setValues] = useState<ProcedureStepEditorValues>(() => procedureStepEditorValues(activeStep));
  const [publishError, setPublishError] = useState("");
  const [publishState, setPublishState] = useState<"idle" | "publishing" | "published">("idle");
  const [feedbackState, setFeedbackState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [agentFeedback, setAgentFeedback] = useState<ProcedureFeedbackResponse | null>(null);
  const [feedbackError, setFeedbackError] = useState("");
  const [feedbackValuesSignature, setFeedbackValuesSignature] = useState("");
  const feedbackRequestRef = useRef(0);

  useEffect(() => {
    const nextIndex = Math.max(0, procedure.steps.findIndex((step) => step.stepId === activeStep?.stepId));
    const nextStep = procedure.steps[nextIndex] ?? procedure.steps[0];
    if (!nextStep) return;
    const nextValues = procedureStepEditorValues(nextStep);
    setActiveIndex(nextIndex);
    setValues(nextValues);
    setPublishError("");
    setPublishState("idle");
    feedbackRequestRef.current += 1;
    setFeedbackState("idle");
    setAgentFeedback(null);
    setFeedbackError("");
    setFeedbackValuesSignature("");
  }, [procedure.procedureId, procedure.revision, procedure.contentHash]);

  const errors = useMemo(() => validateProcedureStepEditor(values), [values]);
  const errorEntries = Object.entries(errors).filter((entry): entry is [keyof ProcedureStepEditorValues, string] => Boolean(entry[1]));
  const patch = useMemo(
    () => activeStep ? buildProcedureStepPatch(activeStep, values) : {},
    [activeStep, values],
  );
  const changedFields = Object.keys(patch) as (keyof EditableProcedureStepPatch)[];
  const dirty = publishState !== "published" && changedFields.length > 0;
  const valid = errorEntries.length === 0;
  const valuesSignature = useMemo(() => JSON.stringify(values), [values]);
  const feedbackStale = Boolean(agentFeedback && feedbackValuesSignature !== valuesSignature);
  const feedbackByField = useMemo(() => new Map<ProcedureFeedbackField, ProcedureFieldFeedback>(
    (agentFeedback?.fieldFeedback ?? []).map((item) => [item.field, item]),
  ), [agentFeedback]);

  if (!activeStep) return null;

  const update = (field: keyof ProcedureStepEditorValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setPublishError("");
    if (publishState === "published") setPublishState("idle");
  };

  const confirmDiscard = (message: string): boolean => (
    !dirty || typeof window === "undefined" || window.confirm(message)
  );

  const requestClose = () => {
    if (confirmDiscard("Discard the unpublished changes to this procedure step?")) onClose();
  };

  const selectStep = (nextIndex: number) => {
    if (nextIndex === activeIndex) return;
    if (!confirmDiscard("Discard the unpublished changes before opening another step?")) return;
    const nextStep = procedure.steps[nextIndex];
    if (!nextStep) return;
    const nextValues = procedureStepEditorValues(nextStep);
    setActiveIndex(nextIndex);
    setValues(nextValues);
    setPublishError("");
    setPublishState("idle");
    feedbackRequestRef.current += 1;
    setFeedbackState("idle");
    setAgentFeedback(null);
    setFeedbackError("");
    setFeedbackValuesSignature("");
  };

  const requestAgentFeedback = async () => {
    if (!onRequestAgentFeedback || feedbackState === "loading" || publishState === "publishing") return;
    const requestNumber = feedbackRequestRef.current + 1;
    feedbackRequestRef.current = requestNumber;
    const requestedValuesSignature = valuesSignature;
    setFeedbackState("loading");
    setFeedbackError("");
    try {
      const feedback = await onRequestAgentFeedback({
        procedureId: procedure.procedureId,
        expectedProcedureRevision: procedure.revision,
        expectedProcedureContentHash: procedure.contentHash,
        stepId: activeStep.stepId,
        values: { ...values },
      });
      if (feedbackRequestRef.current !== requestNumber) return;
      if (
        feedback.procedureId !== procedure.procedureId ||
        feedback.procedureRevision !== procedure.revision ||
        feedback.procedureContentHash !== procedure.contentHash ||
        feedback.stepId !== activeStep.stepId
      ) {
        throw new Error("The feedback does not match the procedure revision currently open.");
      }
      setAgentFeedback(feedback);
      setFeedbackValuesSignature(requestedValuesSignature);
      setFeedbackState("ready");
    } catch (error) {
      if (feedbackRequestRef.current !== requestNumber) return;
      setFeedbackState("error");
      setFeedbackError(error instanceof Error ? error.message : "The agent could not review this procedure step.");
    }
  };

  const publish = async () => {
    if (!valid || !dirty || !onPublishStep || publishState === "publishing") return;
    setPublishError("");
    setPublishState("publishing");
    try {
      await onPublishStep(buildPublishProcedureStepInput(procedure, activeStep, values));
      setPublishState("published");
    } catch (error) {
      setPublishState("idle");
      setPublishError(error instanceof Error ? error.message : "The step revision could not be published.");
    }
  };

  return (
    <Modal
      contentId="text-text-procedure-editor-modal"
      title={`Edit procedure · ${procedure.title}`}
      eyebrow="CONTROLLED PROCEDURE WORKSPACE"
      onClose={requestClose}
      workspace
      footer={(
        <>
          <span className="footer-note" id="text-text-procedure-editor-footer-status">
            <Icon name={publishState === "published" ? "shield" : "wrench"} size={16}/>
            {publishState === "published"
              ? "Step revision published · waiting for catalogue refresh"
              : "Workspace revision · human-authored"}
          </span>
          <button
            type="button"
            className="button button--secondary"
            data-testid="procedure-editor-previous"
            disabled={activeIndex === 0 || publishState === "publishing"}
            onClick={() => selectStep(procedureEditorNavigationIndex(activeIndex, -1, procedure.steps.length))}
          >
            Previous step
          </button>
          <button
            type="button"
            className="button button--secondary"
            data-testid="procedure-editor-next"
            disabled={activeIndex >= procedure.steps.length - 1 || publishState === "publishing"}
            onClick={() => selectStep(procedureEditorNavigationIndex(activeIndex, 1, procedure.steps.length))}
          >
            Next step <Icon name="arrow" size={15}/>
          </button>
          <button
            type="button"
            className="button button--primary"
            data-testid="procedure-editor-publish"
            disabled={!onPublishStep || !dirty || !valid || publishState === "publishing"}
            onClick={() => void publish()}
          >
            {publishState === "publishing" ? "Publishing revision…" : "Publish step revision"}
          </button>
        </>
      )}
    >
      <div className="procedure-editor" id="text-text-procedure-editor-workspace" data-testid="procedure-editor">
        <aside className="procedure-editor__rail" id="text-text-procedure-editor-step-rail">
          <header>
            <small>DOCUMENT STEPS</small>
            <strong>{procedure.procedureId}</strong>
            <span>rev. {procedure.revision}</span>
          </header>
          <ol data-testid="procedure-editor-step-list">
            {procedure.steps.map((step, index) => (
              <li key={step.stepId}>
                <button
                  type="button"
                  className={index === activeIndex ? "is-active" : ""}
                  data-testid={`procedure-editor-step-${step.stepId}`}
                  aria-current={index === activeIndex ? "step" : undefined}
                  onClick={() => selectStep(index)}
                >
                  <i>{index + 1}</i>
                  <span>
                    <small>{step.phase}</small>
                    <strong>{step.title}</strong>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <main className="procedure-editor__form" id="text-text-procedure-editor-step-form">
          <header className="procedure-editor__form-header">
            <div>
              <small>STEP {activeIndex + 1} OF {procedure.steps.length}</small>
              <h3>{activeStep.title}</h3>
              <p>Edit only the controlled descriptive attributes and planning estimates for this step.</p>
            </div>
            <div className="procedure-editor__form-actions">
              <StatusPill tone={dirty ? "warning" : "ok"}>{dirty ? "unpublished changes" : "current revision"}</StatusPill>
              <button
                type="button"
                className="button button--secondary procedure-editor__agent-button"
                data-testid="procedure-editor-agent-feedback"
                disabled={!onRequestAgentFeedback || feedbackState === "loading" || publishState === "publishing"}
                title={onRequestAgentFeedback
                  ? "Review this draft against procedure history, operational REX and public sources"
                  : "Agent feedback requires the application server"}
                onClick={() => void requestAgentFeedback()}
              >
                {feedbackState === "loading"
                  ? <span className="procedure-editor__spinner"/>
                  : <Icon name="radio" size={15}/>}
                {feedbackState === "loading" ? "Agent reviewing…" : agentFeedback ? "Refresh agent feedback" : "Ask agent for feedback"}
              </button>
            </div>
          </header>

          {feedbackState === "loading" && (
            <div className="procedure-editor__agent-progress" role="status" aria-live="polite">
              <span className="procedure-editor__spinner"/>
              <div>
                <strong>Agent review in progress</strong>
                <small>Reading previous edits, linked operational REX and relevant public sources.</small>
              </div>
            </div>
          )}

          {feedbackStale && (
            <div className="procedure-editor__agent-stale" role="status">
              <Icon name="alert" size={15}/>
              The draft changed after this review. Refresh agent feedback before relying on it.
            </div>
          )}

          <form onSubmit={(event) => { event.preventDefault(); void publish(); }} noValidate>
            <fieldset disabled={publishState === "publishing"}>
              <legend>Operator-facing content</legend>
              <label className="procedure-editor__field">
                <span>Step title</span>
                <input
                  data-testid="procedure-editor-title"
                  value={values.title}
                  maxLength={TEXT_LIMITS.title}
                  onChange={(event) => update("title", event.target.value)}
                  aria-invalid={Boolean(errors.title)}
                  aria-describedby={errors.title ? "procedure-editor-title-error" : undefined}
                />
                {errors.title && <em id="procedure-editor-title-error" role="alert">{errors.title}</em>}
                <ProcedureFieldAgentFeedback feedback={feedbackByField.get("title")} stale={feedbackStale}/>
              </label>
              <label className="procedure-editor__field">
                <span>Operator instruction</span>
                <textarea
                  data-testid="procedure-editor-instruction"
                  rows={4}
                  value={values.instruction}
                  maxLength={TEXT_LIMITS.instruction}
                  onChange={(event) => update("instruction", event.target.value)}
                  aria-invalid={Boolean(errors.instruction)}
                  aria-describedby={errors.instruction ? "procedure-editor-instruction-error" : undefined}
                />
                {errors.instruction && <em id="procedure-editor-instruction-error" role="alert">{errors.instruction}</em>}
                <ProcedureFieldAgentFeedback feedback={feedbackByField.get("instruction")} stale={feedbackStale}/>
              </label>
              <label className="procedure-editor__field">
                <span>Rationale</span>
                <textarea
                  data-testid="procedure-editor-rationale"
                  rows={3}
                  value={values.rationale}
                  maxLength={TEXT_LIMITS.rationale}
                  onChange={(event) => update("rationale", event.target.value)}
                  aria-invalid={Boolean(errors.rationale)}
                  aria-describedby={errors.rationale ? "procedure-editor-rationale-error" : undefined}
                />
                {errors.rationale && <em id="procedure-editor-rationale-error" role="alert">{errors.rationale}</em>}
                <ProcedureFieldAgentFeedback feedback={feedbackByField.get("rationale")} stale={feedbackStale}/>
              </label>
              <label className="procedure-editor__field">
                <span>Responsible role</span>
                <input
                  data-testid="procedure-editor-responsible-role"
                  value={values.responsibleRole}
                  maxLength={TEXT_LIMITS.responsibleRole}
                  onChange={(event) => update("responsibleRole", event.target.value)}
                  aria-invalid={Boolean(errors.responsibleRole)}
                  aria-describedby={errors.responsibleRole ? "procedure-editor-role-error" : undefined}
                />
                {errors.responsibleRole && <em id="procedure-editor-role-error" role="alert">{errors.responsibleRole}</em>}
                <ProcedureFieldAgentFeedback feedback={feedbackByField.get("responsibleRole")} stale={feedbackStale}/>
              </label>
            </fieldset>

            <fieldset disabled={publishState === "publishing"}>
              <legend>Evidence and completion</legend>
              {([
                ["preconditions", "Preconditions", "One requirement per line. This list may be empty."],
                ["evidenceRequired", "Evidence required", "One required evidence item per line."],
                ["completionCriteria", "Completion criteria", "One verifiable outcome per line."],
              ] as const).map(([field, label, hint]) => (
                <label className="procedure-editor__field" key={field}>
                  <span>{label}</span>
                  <textarea
                    data-testid={`procedure-editor-${field}`}
                    rows={4}
                    value={values[field]}
                    maxLength={MAX_LIST_ITEMS * (MAX_LIST_ITEM_LENGTH + 1)}
                    onChange={(event) => update(field, event.target.value)}
                    aria-invalid={Boolean(errors[field])}
                    aria-describedby={`procedure-editor-${field}-hint${errors[field] ? ` procedure-editor-${field}-error` : ""}`}
                  />
                  <small id={`procedure-editor-${field}-hint`}>{hint}</small>
                  {errors[field] && <em id={`procedure-editor-${field}-error`} role="alert">{errors[field]}</em>}
                  <ProcedureFieldAgentFeedback feedback={feedbackByField.get(field)} stale={feedbackStale}/>
                </label>
              ))}
            </fieldset>

            <fieldset disabled={publishState === "publishing"}>
              <legend>Planning duration · seconds</legend>
              <div className="procedure-editor__duration-grid">
                {([
                  ["minSeconds", "Minimum"],
                  ["nominalSeconds", "Nominal"],
                  ["maxSeconds", "Maximum"],
                ] as const).map(([field, label]) => (
                  <label className="procedure-editor__field" key={field}>
                    <span>{label}</span>
                    <input
                      data-testid={`procedure-editor-${field}`}
                      type="number"
                      min="0"
                      max={MAX_DURATION_SECONDS}
                      step="1"
                      inputMode="numeric"
                      value={values[field]}
                      onChange={(event) => update(field, event.target.value)}
                      aria-invalid={Boolean(errors[field])}
                      aria-describedby={errors[field] ? `procedure-editor-${field}-error` : undefined}
                    />
                    {errors[field] && <em id={`procedure-editor-${field}-error`} role="alert">{errors[field]}</em>}
                    <ProcedureFieldAgentFeedback feedback={feedbackByField.get(field)} stale={feedbackStale}/>
                  </label>
                ))}
              </div>
            </fieldset>
          </form>
        </main>

        <aside className="procedure-editor__review" id="text-text-procedure-editor-review-panel">
          <section
            className={`procedure-editor__agent-review${feedbackStale ? " is-stale" : ""}`}
            id="text-text-procedure-editor-agent-review"
            aria-live="polite"
          >
            <header>
              <Icon name="radio" size={18}/>
              <div><small>AGENT REVIEW</small><h3>Procedure edit feedback</h3></div>
            </header>
            {!agentFeedback && feedbackState === "idle" && (
              <p>Ask the agent to compare this draft with previous edits, linked operational REX and current public sources. No change is applied automatically.</p>
            )}
            {!agentFeedback && feedbackState === "loading" && (
              <div className="procedure-editor__review-loading" role="status">
                <span className="procedure-editor__spinner"/>
                <span><strong>Reviewing this step…</strong><small>Evidence and public-source checks are running.</small></span>
              </div>
            )}
            {feedbackState === "error" && (
              <div className="procedure-editor__review-error" role="alert">
                <strong>Feedback unavailable</strong>
                <p>{feedbackError}</p>
                <button type="button" className="button button--secondary" onClick={() => void requestAgentFeedback()}>
                  Try again
                </button>
              </div>
            )}
            {agentFeedback && (
              <>
                <div className="procedure-editor__agent-meta">
                  <StatusPill tone={agentFeedback.modelAssisted ? "purple" : "warning"}>
                    {agentFeedback.modelAssisted ? agentFeedback.model ?? "OpenAI agent" : "general guidance"}
                  </StatusPill>
                  {feedbackStale && <StatusPill tone="danger">draft changed</StatusPill>}
                </div>
                <p className="procedure-editor__agent-summary">{agentFeedback.summary}</p>
                <dl className="procedure-editor__evidence-counts">
                  <div><dt>Previous edits</dt><dd>{agentFeedback.evidenceCounts.previousEdits}</dd></div>
                  <div><dt>Operator actions</dt><dd>{agentFeedback.evidenceCounts.operatorActions}</dd></div>
                  <div><dt>REX records</dt><dd>{agentFeedback.evidenceCounts.rexLogEntries + agentFeedback.evidenceCounts.procedureExecutions}</dd></div>
                  <div><dt>Public sources</dt><dd>{agentFeedback.evidenceCounts.publicSources}</dd></div>
                </dl>
                {agentFeedback.warning && (
                  <div className="procedure-editor__agent-warning">
                    <Icon name="alert" size={14}/><span>{agentFeedback.warning}</span>
                  </div>
                )}
                <div className="procedure-editor__web-summary">
                  <strong>Public research</strong>
                  <p>{agentFeedback.webResearchSummary}</p>
                </div>
                {agentFeedback.sources.length > 0 && (
                  <div className="procedure-editor__sources">
                    <strong>Verified sources</strong>
                    <ul>
                      {agentFeedback.sources.map((source) => (
                        <li key={source.sourceId}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            <span>{source.title}<small>{source.sourceId} · {source.domain}</small></span>
                            <Icon name="external" size={13}/>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {agentFeedback.cautions.length > 0 && (
                  <div className="procedure-editor__cautions">
                    <strong>Review points</strong>
                    <ul>{agentFeedback.cautions.map((caution) => <li key={caution}>{caution}</li>)}</ul>
                  </div>
                )}
              </>
            )}
          </section>

          <section id="text-text-procedure-editor-invariants">
            <header><Icon name="shield" size={18}/><div><small>IMMUTABLE CONTRACT</small><h3>Execution invariants</h3></div></header>
            <dl>
              <div><dt>Step ID</dt><dd><code>{activeStep.stepId}</code></dd></div>
              <div><dt>Order</dt><dd>{activeStep.order}</dd></div>
              <div><dt>Phase</dt><dd>{activeStep.phase}</dd></div>
              <div><dt>Mandatory</dt><dd>{activeStep.mandatory ? "Yes" : "No"}</dd></div>
              <div><dt>Capability</dt><dd>{activeStep.capability ?? "None"}</dd></div>
              <div><dt>Operator confirmation</dt><dd>{activeStep.operatorConfirmationRequired ? "Required" : "Not required"}</dd></div>
              <div><dt>Authority evidence gate</dt><dd>{activeStep.requiredEvidenceReferenceKind ?? "None"}</dd></div>
            </dl>
          </section>

          <section id="text-text-procedure-editor-diff" aria-live="polite">
            <header><Icon name="activity" size={18}/><div><small>REVISION DIFF</small><h3>Pending changes</h3></div></header>
            {publishState === "published" ? (
              <p>The step revision was accepted. The catalogue refresh will replace this draft with its new revision and integrity hash.</p>
            ) : changedFields.length > 0 ? (
              <ul data-testid="procedure-editor-diff-list">
                {changedFields.map((field) => (
                  <li key={field}>
                    <span>{MUTABLE_FIELD_LABELS[field]}</span>
                    {field === "durationRangeSeconds" && patch.durationRangeSeconds
                      ? <small>{durationLabel(activeStep.durationRangeSeconds)} → {durationLabel(patch.durationRangeSeconds)}</small>
                      : <small>Modified in this draft</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No unpublished changes for this step.</p>
            )}
          </section>

          <section className={valid ? "is-valid" : "is-invalid"} id="text-text-procedure-editor-validation" aria-live="polite">
            <header><Icon name={valid ? "shield" : "alert"} size={18}/><div><small>VALIDATION</small><h3>{valid ? "Ready for review" : `${errorEntries.length} issue${errorEntries.length === 1 ? "" : "s"}`}</h3></div></header>
            {valid ? <p>The mutable attributes satisfy the publication contract.</p> : (
              <ul>
                {errorEntries.map(([field, message]) => <li key={field}>{message}</li>)}
              </ul>
            )}
          </section>

          {!onPublishStep && (
            <section className="is-offline" id="text-text-procedure-editor-unavailable" role="status">
              <header><Icon name="alert" size={18}/><div><small>PUBLICATION</small><h3>Read-only catalogue</h3></div></header>
              <p>The publication endpoint is not connected. Drafting remains available for review.</p>
            </section>
          )}
          {publishError && (
            <section className="is-invalid" id="text-text-procedure-editor-publish-error" role="alert">
              <header><Icon name="alert" size={18}/><div><small>PUBLICATION FAILED</small><h3>Revision not published</h3></div></header>
              <p>{publishError}</p>
            </section>
          )}
        </aside>
      </div>
    </Modal>
  );
}
