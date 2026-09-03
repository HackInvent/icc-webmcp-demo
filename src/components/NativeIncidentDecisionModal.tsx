import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeIncidentDecision,
  applyIncidentProcedureStep,
  assessIncidentProcedureChoice,
  type IncidentDecisionPackage,
  type IncidentDecisionProgress,
  type IncidentOperationalResponse,
  type OperationalProcedureStep,
  type ProcedureChoiceAdvice,
} from "../agent/incidentDecisionAgent";
import { useRuntimeConfiguration } from "../runtime/RuntimeGate";
import { operatorEvidenceReferenceRequirement } from "../procedures";
import { procedurePath } from "../navigation";
import { RAIL_GRAPH_STATION_BY_ID } from "../rail/interdependenceGraph";
import { NATIVE_LINE_BY_CODE } from "../rail/nativeNetwork";
import type {
  NativeIncident,
  NativeSimulationSnapshot,
} from "../rail/nativeSimulation";
import { formatDelay, formatTime, severityLabel, severityTone } from "../utils";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { StatusPill } from "./StatusPill";
import type { WebMcpApprovalView } from "./WebMcpApprovalDialog";

interface NativeIncidentDecisionModalProps {
  incidentId: string;
  simulation: NativeSimulationSnapshot;
  procedureCatalogueSequence: number;
  expectedToolNames: readonly string[];
  inPageTools: readonly WebMcpToolDefinition[];
  toolsPublished: boolean;
  toolApproval: WebMcpApprovalView | null;
  onToolApprovalDecision: (approved: boolean) => void;
  onClose: () => void;
  onApplied: (message: string) => void;
}

interface AppliedReceipt {
  message: string;
  receiptId: string;
  decisionRevision: number;
  stepId: string;
  recordedAt: number;
  operatorEvidenceReference: string | null;
}

type WorkflowStage = "situation" | "options" | "execution" | "closure";

const WORKFLOW_STAGES: readonly {
  id: WorkflowStage;
  label: string;
  description: string;
}[] = [
  { id: "situation", label: "Situation & impact", description: "Establish trusted context" },
  { id: "options", label: "Action options & consequences", description: "Compare cited responses" },
  { id: "execution", label: "Procedure execution", description: "Review and approve one step" },
  { id: "closure", label: "Closure", description: "Verify return to normal" },
];

const PROGRESS_ORDER: readonly IncidentDecisionProgress[] = [
  "discovering",
  "inspecting",
  "searching",
  "reading",
  "reasoning",
];

const PROGRESS_LABELS: Record<IncidentDecisionProgress, string> = {
  discovering: "Connecting to page WebMCP tools",
  inspecting: "Reading the coded incident state",
  searching: "Searching the controlled procedure library",
  reading: "Opening the applicable document revision",
  reasoning: "Grounding the operator decision aid",
};

function progressIndex(progress: IncidentDecisionProgress): number {
  return PROGRESS_ORDER.indexOf(progress);
}

function nextMonotoneProgress(
  current: IncidentDecisionProgress,
  next: IncidentDecisionProgress,
): IncidentDecisionProgress {
  const currentIndex = progressIndex(current);
  const nextIndex = progressIndex(next);
  const readingIndex = progressIndex("reading");
  if (next === "reasoning" && currentIndex < readingIndex) return current;
  return PROGRESS_ORDER[Math.max(currentIndex, nextIndex)] ?? current;
}

function lineLabel(incident: NativeIncident): string {
  return NATIVE_LINE_BY_CODE.get(incident.lineCode)?.label ?? incident.lineCode;
}

function stepIcon(step: OperationalProcedureStep): "shield" | "activity" | "reset" {
  if (step.phase === "protect") return "shield";
  if (step.phase === "close" || step.capability?.command === "close-incident") return "reset";
  return "activity";
}

function actionLabel(step: OperationalProcedureStep): string {
  if (!step.capability || step.capability.command === "acknowledge") {
    return "Record operator check";
  }
  if (step.capability.command === "close-incident") {
    return "Verify & return to normal";
  }
  return "Review & apply";
}

function consequenceLabel(step: OperationalProcedureStep): string {
  switch (step.capability?.command) {
    case undefined:
    case "acknowledge":
      return "Records the operator check in the incident history without changing traffic controls.";
    case "protect-and-hold":
      return "Protects the affected area and may hold approaching trains at their current station until the next documented gate.";
    case "degraded-operation":
      return "Introduces the documented degraded mode while keeping the incident under operator control.";
    case "publish-passenger-information":
      return "Publishes the reviewed disruption scope and alternatives; it does not change train movement.";
    case "protect-connections":
      return "Protects only graph-grounded connections and may hold a connecting service within the reviewed operating margin.";
    case "dispatch-maintenance":
      return "Dispatches the relevant maintenance team to the exact target; dispatch is not technical clearance.";
    case "activate-provisional-service":
      return "Splits the service around the blocked scope and changes the served passenger corridor until recovery.";
    case "activate-turnbacks":
      return "Turns eligible trains at graph-grounded stations before the blockage, preserving service on either side.";
    case "activate-shuttle-bus":
      return "Starts a bidirectional replacement-bus service between reviewed endpoints; it does not imply rail recovery.";
    case "insert-train":
      return "Adds capacity at the proposed station and direction, increasing fleet load and the traction estimate.";
    case "start-towing":
      return "Starts the reviewed rescue movement; the immobilised train remains protected throughout the three-hour nominal operation.";
    case "close-incident":
      return "Attempts the documented return to normal only after prerequisites and recovery evidence are verified.";
  }
}

function durationPart(seconds: number): string {
  if (seconds >= 3_600) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.round((seconds % 3_600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function durationRangeLabel(step: OperationalProcedureStep): string {
  const duration = step.durationRangeSeconds;
  return `${durationPart(duration.minSeconds)}–${durationPart(duration.maxSeconds)} · nominal ${durationPart(duration.nominalSeconds)}`;
}


function integer(value: number): string {
  return Math.round(value).toLocaleString("en-GB");
}

function stationLabel(stationId: string): string {
  return RAIL_GRAPH_STATION_BY_ID.get(stationId)?.name ?? stationId;
}

function stationList(stationIds: readonly string[]): string {
  return stationIds.length > 0 ? stationIds.map(stationLabel).join(" ↔ ") : "No station returned";
}

function etaLabel(earliestAt: number, expectedAt: number, latestAt: number): string {
  return `${formatTime(earliestAt)}–${formatTime(latestAt)} · expected ${formatTime(expectedAt)}`;
}

interface OperationalPlanView {
  title: string;
  status: string;
  rows: Array<{ label: string; value: string }>;
}

function operationalPlanForStep(
  step: OperationalProcedureStep,
  response: IncidentOperationalResponse | undefined,
): OperationalPlanView | null {
  const command = step.capability?.command;
  if (!command || !response) return null;
  if (command === "dispatch-maintenance") {
    const dispatch = response.dispatches.find((item) => item.status === "proposed") ?? response.dispatches[0];
    if (!dispatch) return null;
    return {
      title: "Graph-grounded maintenance dispatch",
      status: dispatch.status,
      rows: [
        { label: "Team", value: dispatch.plan.team.replaceAll("-", " ") },
        { label: "Target", value: stationList(dispatch.plan.targetStationIds) },
        { label: "Intervention", value: `${durationPart(dispatch.plan.estimatedDuration.minSeconds)}–${durationPart(dispatch.plan.estimatedDuration.maxSeconds)} · nominal ${durationPart(dispatch.plan.estimatedDuration.nominalSeconds)}` },
        { label: "Planning ETA", value: etaLabel(dispatch.plan.eta.earliestAt, dispatch.plan.eta.expectedAt, dispatch.plan.eta.latestAt) },
      ],
    };
  }
  const kindByCommand = {
    "publish-passenger-information": "passenger-information",
    "protect-connections": "connection-protection",
    "activate-provisional-service": "provisional-service",
    "activate-turnbacks": "turnback",
    "activate-shuttle-bus": "shuttle-bus",
    "insert-train": "train-insertion",
    "start-towing": "towing",
  } as const;
  const kind = command in kindByCommand
    ? kindByCommand[command as keyof typeof kindByCommand]
    : null;
  const measure = kind
    ? response.continuityMeasures.find((item) => item.kind === kind && item.status === "proposed")
      ?? response.continuityMeasures.find((item) => item.kind === kind)
    : null;
  if (!measure) return null;
  const common = { title: "Prepared operational plan", status: measure.status, rows: [] as OperationalPlanView["rows"] };
  if (!measure.plan) {
    return {
      ...common,
      rows: [
        { label: "Affected stations", value: stationList(measure.stationIds) },
        { label: "Connections", value: measure.connectionIds.join(", ") || "No graph connection returned" },
      ],
    };
  }
  switch (measure.plan.kind) {
    case "provisional-service": {
      const sections = measure.plan.serviceSegments ?? [];
      return { ...common, title: "Split provisional rail service", rows: [
        ...(measure.plan.protectedStationIds?.length
          ? [{ label: "Excluded station", value: stationList(measure.plan.protectedStationIds) }]
          : []),
        ...(measure.plan.turnbackStationIds?.length
          ? [{ label: "Flanking turnbacks", value: stationList(measure.plan.turnbackStationIds) }]
          : []),
        {
          label: sections.length === 1 ? "Operating section" : "Operating sections",
          value: sections.length > 0
            ? sections.map((segment) => stationList(segment.terminalStationIds)).join(" · ")
            : stationList(measure.plan.terminusStationIds),
        },
        { label: "Operation", value: sections.length > 0 ? "Bidirectional on every open section" : measure.plan.directions.map((leg) => `${stationLabel(leg.fromStationId)} → ${stationLabel(leg.toStationId)}`).join(" · ") },
        { label: "Target headway", value: durationPart(measure.plan.targetHeadwaySeconds) },
      ] };
    }
    case "turnback": {
      const sections = measure.plan.serviceSegments ?? [];
      return { ...common, title: "Protected flanking-turnback plan", rows: [
        ...(measure.plan.protectedStationIds?.length
          ? [{ label: "Excluded station", value: stationList(measure.plan.protectedStationIds) }]
          : []),
        { label: "Turnback points", value: stationList(measure.plan.turnbackStationIds) },
        {
          label: sections.length === 1 ? "Protected service section" : "Protected service sections",
          value: sections.length > 0
            ? sections.map((segment) => stationList(segment.terminalStationIds)).join(" · ")
            : measure.plan.directions.map((leg) => `${stationLabel(leg.fromStationId)} → ${stationLabel(leg.toStationId)}`).join(" · "),
        },
      ] };
    }
    case "shuttle-bus":
      return { ...common, title: "Bidirectional replacement-bus plan", rows: [
        { label: "Termini", value: stationList(measure.plan.terminusStationIds) },
        { label: "Fleet / headway", value: `${measure.plan.fleetSize} buses · every ${durationPart(measure.plan.headwaySeconds)}` },
        { label: "Planned capacity", value: `${integer(measure.plan.capacityPerHour)} passengers/hour` },
        { label: "Current cycle", value: `${measure.plan.cycle.phase.replaceAll("-", " ")} · cycle ${measure.plan.cycle.cycleIndex + 1}` },
      ] };
    case "train-insertion":
      return { ...common, title: "Crowding-relief train insertion", rows: [
        { label: "Insert at", value: stationLabel(measure.plan.stationId) },
        { label: "Direction", value: `${stationLabel(measure.plan.stationId)} → ${stationLabel(measure.plan.destinationStationId)}` },
        { label: "Added capacity", value: `${integer(measure.plan.capacityDeltaPassengers)} passengers` },
      ] };
    case "towing":
      return { ...common, title: "Protected rescue and towing plan", rows: [
        { label: "Receiving terminal", value: stationLabel(measure.plan.receivingTerminalStationId) },
        { label: "Intervention", value: `${durationPart(measure.plan.estimatedDuration.minSeconds)}–${durationPart(measure.plan.estimatedDuration.maxSeconds)} · nominal ${durationPart(measure.plan.estimatedDuration.nominalSeconds)}` },
        { label: "Planning ETA", value: etaLabel(measure.plan.eta.earliestAt, measure.plan.eta.expectedAt, measure.plan.eta.latestAt) },
      ] };
  }
}

function OperationalPlanCard({ plan }: { plan: OperationalPlanView }) {
  return (
    <section className="incident-operational-plan" aria-label={plan.title}>
      <header><span><Icon name="network" size={16}/></span><div><small>OPERATIONAL PLAN · OPERATOR APPROVAL REQUIRED</small><strong>{plan.title}</strong></div><StatusPill tone="purple">{plan.status}</StatusPill></header>
      <dl>{plan.rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    </section>
  );
}

function AnalysisProgress({ progress }: { progress: IncidentDecisionProgress }) {
  const current = progressIndex(progress);
  return (
    <section className="incident-agent-working" role="status" data-testid="incident-agent-progress">
      <div className="incident-agent-working__signal"><Icon name="radio" size={28}/></div>
      <div className="incident-agent-working__copy">
        <small>AGENT WORKING · PROCEDURE-GROUNDED ANALYSIS</small>
        <strong>{PROGRESS_LABELS[progress]}</strong>
        <p>Every proposal is being checked against the current page state and a cited procedure revision.</p>
      </div>
      <ol aria-label="Procedure retrieval progress">
        {PROGRESS_ORDER.map((step, index) => (
          <li
            key={step}
            className={index < current ? "is-complete" : index === current ? "is-active" : ""}
          >
            <i>{index < current ? "✓" : index + 1}</i>
            <span>{PROGRESS_LABELS[step]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function InlineWebMcpApproval({
  request,
  onDecision,
}: {
  request: WebMcpApprovalView;
  onDecision: (approved: boolean) => void;
}) {
  return (
    <section
      className={"webmcp-approval webmcp-approval--" + request.kind + " procedure-step-approval"}
      id="text-text-modal-native-incident-inline-approval"
      data-testid="agent-tool-approval"
      aria-label="Review this procedure action"
    >
      <div className="webmcp-approval__summary">
        <span><Icon name="alert" size={21}/></span>
        <div>
          <small>FINAL OPERATOR CONFIRMATION</small>
          <strong>{request.label}</strong>
        </div>
      </div>
      <p>
        Confirm the selected documented step. Its incident, procedure revision and
        decision revision remain pinned in the background.
      </p>
      <div className="webmcp-approval__guard">
        <Icon name="shield" size={17}/>
        <span>
          <strong>One-use approval for this procedure step.</strong>
          <small>Any changed argument or decision revision requires a fresh confirmation.</small>
        </span>
      </div>
      <div className="webmcp-approval__actions" id="text-text-modal-native-incident-inline-approval-actions">
        <button
          type="button"
          className="button button--secondary"
          data-testid="agent-tool-reject"
          onClick={() => onDecision(false)}
        >
          Keep step unrecorded
        </button>
        <button
          type="button"
          className="button button--primary"
          data-testid="agent-tool-approve"
          onClick={() => onDecision(true)}
        >
          <Icon name="shield" size={15}/> Confirm and record this step
        </button>
      </div>
    </section>
  );
}

export function NativeIncidentDecisionModal({
  incidentId,
  simulation,
  procedureCatalogueSequence,
  expectedToolNames,
  inPageTools,
  toolsPublished,
  toolApproval,
  onToolApprovalDecision,
  onClose,
  onApplied,
}: NativeIncidentDecisionModalProps) {
  const { configuration } = useRuntimeConfiguration();
  const incident = simulation.incidents.find((candidate) => candidate.id === incidentId);
  const [decision, setDecision] = useState<IncidentDecisionPackage | null>(null);
  const [progress, setProgress] = useState<IncidentDecisionProgress>("discovering");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingStepId, setApplyingStepId] = useState<string | null>(null);
  const [workflowReceipts, setWorkflowReceipts] = useState<AppliedReceipt[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [activeStage, setActiveStage] = useState<WorkflowStage>("situation");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [choiceAdvice, setChoiceAdvice] = useState<ProcedureChoiceAdvice | null>(null);
  const [choiceAdviceStepId, setChoiceAdviceStepId] = useState<string | null>(null);
  const [choiceAdviceError, setChoiceAdviceError] = useState<string | null>(null);
  const [operatorEvidenceReferences, setOperatorEvidenceReferences] = useState<Record<string, string>>({});
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const applyAbortRef = useRef<AbortController | null>(null);
  const choiceAbortRef = useRef<AbortController | null>(null);
  const refreshDecisionRevisionRef = useRef<number | null>(null);
  const decisionRef = useRef<IncidentDecisionPackage | null>(null);
  const decisionIncidentIdRef = useRef<string | null>(null);
  decisionRef.current = decision;

  useEffect(() => {
    if (!incident || !toolsPublished) return undefined;
    const controller = new AbortController();
    const retainsCurrentWorkflow =
      decisionIncidentIdRef.current === incidentId && decisionRef.current !== null;
    if (!retainsCurrentWorkflow) {
      decisionIncidentIdRef.current = incidentId;
      setDecision(null);
      setWorkflowReceipts([]);
      setActiveStage("situation");
      setSelectedStepId(null);
      setChoiceAdvice(null);
      setChoiceAdviceStepId(null);
      setChoiceAdviceError(null);
      setOperatorEvidenceReferences({});
      setEvidenceOpen(false);
    }
    setIsRefreshing(retainsCurrentWorkflow);
    setAnalysisError(null);
    setApplyError(null);
    setProgress("discovering");
    const revision = refreshDecisionRevisionRef.current ?? simulation.decisionRevision;
    refreshDecisionRevisionRef.current = null;
    void analyzeIncidentDecision({
      incidentId,
      decisionRevision: revision,
      procedureCatalogueSequence,
      expectedToolNames,
      inPageTools,
      modelEnabled: configuration.agent.enabled,
      maxToolRounds: configuration.agent.maxToolRounds,
      signal: controller.signal,
      onProgress: (next) => {
        setProgress((current) => nextMonotoneProgress(current, next));
      },
    }).then((result) => {
      if (!controller.signal.aborted) {
        setProgress("reasoning");
        setDecision(result);
        decisionIncidentIdRef.current = incidentId;
        setIsRefreshing(false);
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setIsRefreshing(false);
      setAnalysisError(
        error instanceof Error
          ? error.message
          : "The procedural incident analysis could not be completed.",
      );
    });
    return () => controller.abort();
  }, [
    configuration.agent.enabled,
    configuration.agent.maxToolRounds,
    expectedToolNames,
    inPageTools,
    incidentId,
    procedureCatalogueSequence,
    retry,
    toolsPublished,
  ]);

  useEffect(() => () => {
    applyAbortRef.current?.abort();
    choiceAbortRef.current?.abort();
  }, []);

  const stale = Boolean(
    decision &&
    decision.context.evidence.decisionRevision !== simulation.decisionRevision,
  );
  const completedStepIds = useMemo(() => new Set([
    ...(decision?.context.incident.procedureExecution.completedStepIds ?? []),
    ...workflowReceipts.map((item) => item.stepId),
  ]), [decision, workflowReceipts]);
  const declaredNextRequiredStepId =
    decision?.context.incident.procedureExecution.nextRequiredStepId ?? null;
  const nextRequiredStepId = decision
    ? declaredNextRequiredStepId && !completedStepIds.has(declaredNextRequiredStepId)
      ? declaredNextRequiredStepId
      : decision.procedure.steps.find(
          (step) => step.mandatory && !completedStepIds.has(step.stepId),
        )?.stepId ?? null
    : null;
  const orderedActions = useMemo(() => {
    if (!decision) return [];
    const steps = new Map(decision.procedure.steps.map((step) => [step.stepId, step]));
    return decision.recommendation.actions
      .map((action) => ({ action, step: steps.get(action.stepId) }))
      .filter((entry): entry is typeof entry & { step: OperationalProcedureStep } =>
        Boolean(entry.step) && !completedStepIds.has(entry.action.stepId)
      )
      .sort((left, right) => {
        if (left.step.stepId === nextRequiredStepId) return -1;
        if (right.step.stepId === nextRequiredStepId) return 1;
        return left.action.priority - right.action.priority;
      });
  }, [completedStepIds, decision, nextRequiredStepId]);
  const agentSuggestedStepId = orderedActions[0]?.step.stepId ?? null;
  const agentSuggestedStep = decision?.procedure.steps.find(
    (step) => step.stepId === agentSuggestedStepId,
  ) ?? null;
  const agentSuggestedAction = decision?.recommendation.actions.find(
    (action) => action.stepId === agentSuggestedStepId,
  ) ?? null;
  const completedProcedureSteps = decision
    ? decision.procedure.steps.filter((step) => completedStepIds.has(step.stepId))
    : [];
  const remainingProcedureDuration = decision?.procedure.steps
    .filter((step) => step.mandatory && !completedStepIds.has(step.stepId))
    .reduce((total, step) => ({
      minSeconds: total.minSeconds + step.durationRangeSeconds.minSeconds,
      nominalSeconds: total.nominalSeconds + step.durationRangeSeconds.nominalSeconds,
      maxSeconds: total.maxSeconds + step.durationRangeSeconds.maxSeconds,
    }), { minSeconds: 0, nominalSeconds: 0, maxSeconds: 0 }) ?? null;
  const mandatorySteps = decision?.procedure.steps.filter((step) => step.mandatory) ?? [];
  const procedureComplete = Boolean(
    decision && mandatorySteps.length > 0 && mandatorySteps.every((step) => completedStepIds.has(step.stepId)),
  );
  const closeStep = decision?.procedure.steps.find(
    (step) => step.phase === "close" || step.capability?.command === "close-incident",
  ) ?? null;
  const closurePrerequisitesComplete = Boolean(
    decision && decision.procedure.steps
      .filter((step) => step.mandatory && step.stepId !== closeStep?.stepId)
      .every((step) => completedStepIds.has(step.stepId)),
  );
  const receiptForStep = (stepId: string) => workflowReceipts
    .slice()
    .reverse()
    .find((item) => item.stepId === stepId);
  useEffect(() => {
    if (!decision) return;
    const fallback = nextRequiredStepId ?? orderedActions[0]?.step.stepId ?? null;
    setSelectedStepId((current) => {
      if (!current || completedStepIds.has(current) || !decision.procedure.steps.some((step) => step.stepId === current)) {
        return fallback;
      }
      return current;
    });
  }, [completedStepIds, decision, nextRequiredStepId, orderedActions]);

  const inlineApproval =
    toolApproval?.toolName === "apply_reviewed_procedure_step" &&
    toolApproval.input.incidentId === incidentId
      ? toolApproval
      : null;
  const inlineApprovalStepId = typeof inlineApproval?.input.stepId === "string"
    ? inlineApproval.input.stepId
    : null;

  useEffect(() => {
    if (!inlineApprovalStepId) return;
    setSelectedStepId(inlineApprovalStepId);
    setActiveStage("execution");
  }, [inlineApprovalStepId]);

  const selectedStep = decision?.procedure.steps.find((step) => step.stepId === selectedStepId) ?? null;
  const selectedEvidenceRequirement = selectedStep
    ? operatorEvidenceReferenceRequirement(selectedStep)
    : null;
  const selectedEvidenceReference = selectedStep
    ? operatorEvidenceReferences[selectedStep.stepId] ?? ""
    : "";
  const selectedAction = decision?.recommendation.actions.find((action) => action.stepId === selectedStepId) ?? null;
  const operationalResponse = decision?.context.operationalResponse;
  const predictedDuration = operationalResponse?.incidentCase.predictedDuration ?? null;
  const dueMilestones = operationalResponse?.incidentCase.milestones.filter((item) => item.status === "due") ?? [];
  const primaryCrowding = operationalResponse?.crowding
    .slice()
    .sort((left, right) => right.estimatedPassengers - left.estimatedPassengers)[0] ?? null;
  const selectedOperationalPlan = selectedStep
    ? operationalPlanForStep(selectedStep, operationalResponse)
    : null;

  const applyStep = async (stepId: string) => {
    if (!decision || stale || applyingStepId || isRefreshing) return;
    const reviewedStep = decision.procedure.steps.find((step) => step.stepId === stepId);
    const evidenceRequirement = reviewedStep
      ? operatorEvidenceReferenceRequirement(reviewedStep)
      : null;
    const operatorEvidenceReference = operatorEvidenceReferences[stepId]?.trim() ?? "";
    if (evidenceRequirement && !operatorEvidenceReference) {
      setApplyError(`${evidenceRequirement.label} is required before this step can be recorded.`);
      return;
    }
    setApplyingStepId(stepId);
    setApplyError(null);
    const controller = new AbortController();
    applyAbortRef.current = controller;
    try {
      const output = await applyIncidentProcedureStep({
        package: decision,
        stepId,
        ...(operatorEvidenceReference ? { operatorEvidenceReference } : {}),
        inPageTools,
        signal: controller.signal,
      });
      const outputStepRecord = output.stepRecord && typeof output.stepRecord === "object" && !Array.isArray(output.stepRecord)
        ? output.stepRecord as Record<string, unknown>
        : null;
      const applied: AppliedReceipt = {
        message: typeof output.message === "string"
          ? output.message
          : output.status === "applied_to_simulation"
            ? (reviewedStep?.title ?? "The procedure step") +
              " was applied and recorded in the current operational state."
            : (reviewedStep?.title ?? "The procedure step") +
              " was reviewed and recorded by the operator.",
        receiptId: typeof output.receiptId === "string"
          ? output.receiptId
          : "procedure-step-receipt",
        decisionRevision: typeof output.decisionRevision === "number"
          ? output.decisionRevision
          : simulation.decisionRevision,
        stepId,
        recordedAt: Date.now(),
        operatorEvidenceReference: typeof outputStepRecord?.operatorEvidenceReference === "string"
          ? outputStepRecord.operatorEvidenceReference
          : operatorEvidenceReference || null,
      };
      setWorkflowReceipts((current) => [
        ...current.filter((item) => item.stepId !== stepId),
        applied,
      ]);
      setChoiceAdvice(null);
      setChoiceAdviceStepId(null);
      setChoiceAdviceError(null);
      refreshDecisionRevisionRef.current = applied.decisionRevision;
      onApplied(applied.message);
      setRetry((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) {
        setApplyError(
          error instanceof Error ? error.message : "The reviewed procedure step was blocked.",
        );
      }
    } finally {
      if (applyAbortRef.current === controller) applyAbortRef.current = null;
      setApplyingStepId(null);
    }
  };

  if (!incident) {
    return (
      <Modal contentId="text-text-modal-native-incident-unavailable" title="Incident unavailable" eyebrow="DECISION SUPPORT" onClose={onClose}>
        <div className="empty-state">
          <Icon name="alert" size={26}/>
          <p>This native incident no longer exists.</p>
        </div>
      </Modal>
    );
  }

  const line = NATIVE_LINE_BY_CODE.get(incident.lineCode);
  const stageStatus = (stage: WorkflowStage): string => {
    if (stage === "situation") return decision ? "Context ready" : "In progress";
    if (stage === "options") return decision ? `${orderedActions.length} remaining` : "Waiting for context";
    if (stage === "execution") return decision
      ? `${completedProcedureSteps.length}/${decision.procedure.steps.length} recorded`
      : "Waiting for context";
    return procedureComplete ? "Return to normal recorded" : closurePrerequisitesComplete ? "Ready for closure gate" : "Pending prerequisites";
  };
  const chooseStep = (stepId: string) => {
    setSelectedStepId(stepId);
    setActiveStage("execution");
    setChoiceAdvice(null);
    setChoiceAdviceError(null);
    choiceAbortRef.current?.abort();
    if (!decision || !agentSuggestedStepId || completedStepIds.has(stepId)) {
      setChoiceAdviceStepId(null);
      return;
    }
    const controller = new AbortController();
    choiceAbortRef.current = controller;
    setChoiceAdviceStepId(stepId);
    void assessIncidentProcedureChoice({
      package: decision,
      stepId,
      agentSuggestedStepId,
      inPageTools,
      signal: controller.signal,
    }).then((advice) => {
      if (!controller.signal.aborted) setChoiceAdvice(advice);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setChoiceAdviceError(
          error instanceof Error
            ? error.message
            : "The agent could not assess this choice against the current operational state.",
        );
      }
    }).finally(() => {
      if (choiceAbortRef.current === controller) choiceAbortRef.current = null;
      if (!controller.signal.aborted) setChoiceAdviceStepId(null);
    });
  };

  return (
    <Modal
      contentId="text-text-modal-native-incident-decision"
      title={incident.title}
      eyebrow="PROCEDURE-GROUNDED DECISION SUPPORT · HUMAN CONTROL"
      onClose={onClose}
      workspace
      footer={(
        <>
          <span className="footer-note incident-workspace__footer-note">
            <Icon name="shield" size={15}/>
            Panel view · operational decision rev. {simulation.decisionRevision}
          </span>
          <button type="button" className="button button--secondary" onClick={onClose}>
            Close panel
          </button>
        </>
      )}
    >
      <div className="incident-workspace" id="text-text-modal-native-incident-content" data-testid="native-incident-decision-modal">
        <div className="incident-workspace__fixed-context">
          <section className="incident-workspace__incident" id="text-text-modal-native-incident-summary">
            <span
              className={"incident-workspace__line severity-mark severity-mark--" + severityTone(incident.severity)}
              style={{ borderColor: line?.color }}
            >
              <Icon name={incident.type === "power" ? "bolt" : "alert"} size={21}/>
            </span>
            <div className="incident-workspace__incident-copy">
              <small>{incident.id} · <b>{incident.incidentCode}</b> · {lineLabel(incident)}</small>
              <strong>{severityLabel(incident.severity)} {incident.type} incident</strong>
              <p>{incident.summary}</p>
            </div>
            <div className="incident-workspace__incident-status">
              <StatusPill tone={severityTone(incident.severity)}>{incident.restrictionMode}</StatusPill>
              <time dateTime={new Date(incident.startedAt).toISOString()}>
                Occurred {formatTime(incident.startedAt)}
              </time>
            </div>
          </section>

          <nav className="incident-workflow-stepper" aria-label="Incident decision workflow">
            {WORKFLOW_STAGES.map((stage, index) => {
              const disabled = stage.id !== "situation" && !decision;
              const active = activeStage === stage.id;
              const completed = stage.id === "situation"
                ? Boolean(decision)
                : stage.id === "options"
                  ? completedProcedureSteps.length > 0 || procedureComplete
                  : stage.id === "execution"
                    ? procedureComplete
                    : procedureComplete;
              return (
                <button
                  key={stage.id}
                  type="button"
                  className={`${active ? "is-active" : ""}${completed ? " is-complete" : ""}`}
                  disabled={disabled}
                  aria-current={active ? "step" : undefined}
                  onClick={() => setActiveStage(stage.id)}
                >
                  <i>{completed ? "✓" : index + 1}</i>
                  <span><strong>{stage.label}</strong><small>{stageStatus(stage.id)}</small></span>
                </button>
              );
            })}
          </nav>

          {decision && (
            <div className="incident-workspace__procedure-ribbon">
              <span><Icon name="shield" size={16}/></span>
              <div>
                <small>{decision.modelAssisted ? "AGENT-SELECTED CONTROLLED PROCEDURE" : "CITED CONTROLLED PROCEDURE"}</small>
                <strong>{decision.procedure.procedureId} · rev. {decision.procedure.revision}</strong>
              </div>
              <a
                href="#text-text-modal-native-incident-procedure-document"
                onClick={(event) => {
                  event.preventDefault();
                  setEvidenceOpen((open) => !open);
                }}
              >
                {evidenceOpen ? "Hide evidence & provenance" : "View evidence & provenance"}
              </a>
              <a href={`#${procedurePath(decision.procedure.procedureId)}`} target="_blank" rel="noreferrer">Open procedure document</a>
            </div>
          )}
        </div>

        <div className="incident-workspace__body">
          <div className="incident-workspace__trust" id="text-text-modal-native-incident-trust">
            <span><Icon name="radio" size={14}/>{decision?.modelAssisted
              ? configuration.agent.model ?? "OpenAI"
              : configuration.agent.enabled
                ? "Procedure fallback"
                : "Agent API offline"}</span>
            <span><Icon name="network" size={14}/>{decision?.transport === "native"
              ? "Native WebMCP"
              : "In-page WebMCP bridge"}</span>
            <span><Icon name="shield" size={14}/>Read-only analysis · operator-approved writes</span>
          </div>

          {decision && evidenceOpen && (
            <section
              className="incident-evidence"
              id="text-text-modal-native-incident-procedure-document"
              aria-labelledby="procedure-document-title"
            >
              <header>
                <div>
                  <small>EVIDENCE & PROVENANCE</small>
                  <h3 id="procedure-document-title">{decision.procedure.title}</h3>
                </div>
                <button type="button" className="button button--secondary" onClick={() => setEvidenceOpen(false)}>Collapse</button>
              </header>
              <div className="incident-evidence__trace" id="text-text-modal-native-incident-retrieval-trace" aria-label="Agent procedure retrieval trace">
                <div><i>1</i><span><small>INSPECTED INCIDENT</small><strong>{decision.context.incident.incidentCode} · {decision.context.incident.procedureExecution.managementState}</strong></span></div>
                <div><i>2</i><span><small>SEARCHED LIBRARY</small><strong>{decision.search.matches.length} exact match{decision.search.matches.length === 1 ? "" : "es"}</strong></span></div>
                <div><i>3</i><span><small>OPENED REVISION</small><strong>{decision.procedure.procedureId} · {decision.procedure.revision}</strong></span></div>
              </div>
              <dl>
                <div><dt>Procedure</dt><dd>{decision.procedure.procedureId}</dd></div>
                <div><dt>Revision</dt><dd>{decision.procedure.revision}</dd></div>
                <div><dt>Integrity</dt><dd><code>{decision.procedure.contentHash}</code></dd></div>
                <div><dt>Evidence time</dt><dd>{formatTime(decision.context.evidence.timestamp)}</dd></div>
                <div><dt>Telemetry revision</dt><dd>{decision.context.evidence.telemetryRevision}</dd></div>
                <div><dt>Scenario</dt><dd>{decision.context.evidence.scenarioId}</dd></div>
              </dl>
            </section>
          )}

          {isRefreshing && decision && (
            <div className="incident-workspace__refresh" id="text-text-modal-native-incident-workflow-update" role="status" data-testid="incident-workflow-refresh">
              <span><Icon name="radio" size={17}/></span>
              <div><strong>Agent updating the decision context</strong><small>{PROGRESS_LABELS[progress]} · current workflow remains available</small></div>
            </div>
          )}

          {analysisError && decision && (
            <div className="incident-decision__message incident-decision__message--error" role="alert">
              <Icon name="alert" size={20}/>
              <div>
                <strong>Context refresh failed</strong>
                <p>{analysisError} The current procedure view has been preserved.</p>
                <button type="button" className="button button--secondary" onClick={() => setRetry((value) => value + 1)}>
                  <Icon name="reset" size={14}/> Retry context refresh
                </button>
              </div>
            </div>
          )}

          {decision && !decision.modelAssisted && (
            <div className="incident-decision__message incident-decision__message--warning">
              <Icon name="alert" size={20}/>
              <div>
                <strong>Agent unavailable — showing the cited procedure</strong>
                <p>The current incident context and exact procedure revision were still retrieved through WebMCP.</p>
                {configuration.agent.enabled && (
                  <button type="button" className="button button--secondary" onClick={() => setRetry((value) => value + 1)}>
                    Retry OpenAI analysis
                  </button>
                )}
              </div>
            </div>
          )}

          {stale && !isRefreshing && decision && (
            <div className="incident-decision__message incident-decision__message--warning" role="alert">
              <Icon name="reset" size={20}/>
              <div>
                <strong>Recommendation expired</strong>
                <p>Decision revision changed from {decision.context.evidence.decisionRevision} to {simulation.decisionRevision}. Procedure actions are disabled until retrieval is refreshed.</p>
                <button type="button" className="button button--secondary" onClick={() => setRetry((value) => value + 1)}>Refresh evidence</button>
              </div>
            </div>
          )}

          {applyError && (
            <div className="incident-decision__message incident-decision__message--error" role="alert">
              <Icon name="alert" size={20}/>
              <div><strong>Procedure step not applied</strong><p>{applyError}</p></div>
            </div>
          )}

          {activeStage === "situation" && (
            <section className="incident-stage" aria-labelledby="incident-stage-situation-title">
              <header className="incident-stage__header">
                <div><small>STEP 1 OF 4</small><h3 id="incident-stage-situation-title">Situation & impact</h3></div>
                <p>Establish a trusted operational picture before considering any intervention.</p>
              </header>

              {!toolsPublished ? (
                <div className="incident-decision__message" role="status">
                  <Icon name="radio" size={22}/><div><strong>Publishing page tools…</strong><p>The analysis starts as soon as the procedure tools are available.</p></div>
                </div>
              ) : !decision && !analysisError ? (
                <AnalysisProgress progress={progress}/>
              ) : !decision && analysisError ? (
                <div className="incident-decision__message incident-decision__message--error" role="alert">
                  <Icon name="alert" size={22}/>
                  <div>
                    <strong>Procedure-grounded analysis unavailable</strong>
                    <p>{analysisError}</p>
                    <button type="button" className="button button--secondary" onClick={() => setRetry((value) => value + 1)}><Icon name="reset" size={14}/> Retry analysis</button>
                  </div>
                </div>
              ) : decision ? (
                <>
                  <section className="incident-assessment" id="text-text-modal-native-incident-assessment">
                    <div className="incident-assessment__narrative">
                      <small>AGENT SITUATION ASSESSMENT</small>
                      <h4>{decision.recommendation.situationSummary}</h4>
                      <p>The agent can prioritise and explain steps; the instruction and executable capability remain bound to the retrieved document.</p>
                    </div>
                    <dl className="incident-impact-grid">
                      <div><dt>Impacted trains</dt><dd>{decision.context.impact.impactedTrainCount}</dd></div>
                      <div><dt>Passenger exposure</dt><dd>{integer(decision.context.impact.passengersOnImpactedTrains)}</dd></div>
                      <div><dt>Worst delay</dt><dd>{formatDelay(decision.context.impact.worstDelaySeconds)}</dd></div>
                      <div><dt>Active restrictions</dt><dd>{decision.context.impact.activeRestrictionCount}</dd></div>
                      <div><dt>Predicted resolution</dt><dd>{predictedDuration ? `${durationPart(predictedDuration.minSeconds)}–${durationPart(predictedDuration.maxSeconds)} · nominal ${durationPart(predictedDuration.nominalSeconds)}` : remainingProcedureDuration ? `${durationPart(remainingProcedureDuration.minSeconds)}–${durationPart(remainingProcedureDuration.maxSeconds)}` : "—"}</dd></div>
                      <div><dt>Expected return to normal</dt><dd>{predictedDuration ? etaLabel(predictedDuration.eta.earliestAt, predictedDuration.eta.expectedAt, predictedDuration.eta.latestAt) : "Pending procedure estimate"}</dd></div>
                    </dl>
                  </section>
                  <div className="incident-stage__two-column">
                    <section className="incident-stage__panel">
                      <small>OPERATIONAL SCOPE</small>
                      <dl className="incident-facts">
                        <div><dt>Target</dt><dd>{decision.context.incident.target.type} · {decision.context.incident.target.id}</dd></div>
                        <div><dt>Management state</dt><dd>{decision.context.incident.procedureExecution.managementState}</dd></div>
                        <div><dt>Affected lines</dt><dd>{decision.context.impact.affectedLineCodes.join(", ") || "None reported"}</dd></div>
                        <div><dt>SCADA link</dt><dd>{operationalResponse?.lineScada.map((item) => `${item.lineCode}: ${item.status}`).join(" · ") || "No degraded link reported"}</dd></div>
                      </dl>
                    </section>
                    <section className="incident-stage__panel">
                      <small>RISKS TO CONTROL</small>
                      {decision.recommendation.risks.length > 0
                        ? <ul className="incident-check-list">{decision.recommendation.risks.map((risk) => <li key={risk}><Icon name="alert" size={14}/>{risk}</li>)}</ul>
                        : <p>No additional risk was returned beyond the documented incident controls.</p>}
                      <dl className="incident-response-signals">
                        <div><dt>Continuity gates due</dt><dd>{dueMilestones.length > 0 ? dueMilestones.map((item) => item.code.replaceAll("-", " ")).join(", ") : "None at the current forecast"}</dd></div>
                        <div><dt>Highest crowding pressure</dt><dd>{primaryCrowding ? `${stationLabel(primaryCrowding.stationId)} · ${primaryCrowding.level} · ${integer(primaryCrowding.estimatedPassengers)} passengers` : "No affected station pressure returned"}</dd></div>
                      </dl>
                    </section>
                  </div>
                  <div className="incident-stage__actions">
                    <button type="button" className="button button--primary" onClick={() => setActiveStage("options")}>Continue to action options <Icon name="arrow" size={14}/></button>
                  </div>
                </>
              ) : null}
            </section>
          )}

          {activeStage === "options" && decision && (
            <section className="incident-stage" id="text-text-modal-native-incident-actions" aria-labelledby="procedure-actions-title">
              <header className="incident-stage__header">
                <div><small>STEP 2 OF 4</small><h3 id="procedure-actions-title">Action options & consequences</h3></div>
                <p>Compare only actions cited by the active procedure, then open one step for controlled execution.</p>
              </header>
              <div className="incident-stage__section-title">
                <div><small>PROCEDURE-DERIVED NEXT STEPS</small><h4>Agent recommendation and operator choices</h4></div>
                <StatusPill tone="purple">{orderedActions.length} remaining</StatusPill>
              </div>

              {agentSuggestedStep && (
                <section className="incident-agent-suggestion" id="text-text-modal-native-incident-agent-suggestion">
                  <span><Icon name="activity" size={22}/></span>
                  <div>
                    <small>AGENT SUGGESTS NOW</small>
                    <h4>{agentSuggestedStep.title}</h4>
                    <p>{agentSuggestedAction?.rationale ?? agentSuggestedStep.rationale}</p>
                  </div>
                  <button type="button" className="button button--primary" onClick={() => chooseStep(agentSuggestedStep.stepId)}>
                    Review suggested step <Icon name="arrow" size={14}/>
                  </button>
                </section>
              )}

              {orderedActions.length === 0 ? (
                <div className="procedure-workflow-complete" role="status">
                  <span><Icon name="shield" size={20}/></span>
                  <div><strong>All documented actions are recorded</strong><p>Continue to Closure to verify return-to-normal evidence.</p></div>
                </div>
              ) : (
                <div className="incident-options-grid">
                  {orderedActions.map(({ action, step }) => {
                    const suggested = step.stepId === agentSuggestedStepId;
                    return (
                      <article
                        key={step.stepId}
                        className={`incident-option${suggested ? " incident-option--required" : ""}`}
                        data-testid={`incident-procedure-option-${step.stepId}`}
                        data-step-id={step.stepId}
                      >
                        <header>
                          <span><Icon name={stepIcon(step)} size={18}/></span>
                          <div><small>#{action.priority} · {step.phase} · {step.responsibleRole}</small><h4>{step.title}</h4></div>
                          {suggested && <StatusPill tone="purple">Agent suggests now</StatusPill>}
                        </header>
                        <p>{step.instruction}</p>
                        <div className="incident-option__consequence"><small>OPERATIONAL CONSEQUENCE</small><strong>{consequenceLabel(step)}</strong></div>
                        {(() => {
                          const plan = operationalPlanForStep(step, operationalResponse);
                          return plan ? <OperationalPlanCard plan={plan}/> : null;
                        })()}
                        <dl>
                          <div><dt>Evidence</dt><dd>{step.evidenceRequired.length} item{step.evidenceRequired.length === 1 ? "" : "s"}</dd></div>
                          <div><dt>Operator checks</dt><dd>{action.operatorChecks.length}</dd></div>
                          <div><dt>Control</dt><dd>{step.capability?.reversible === false ? "Non-reversible gate" : "Reversible / record only"}</dd></div>
                          <div><dt>Estimated intervention</dt><dd>{durationRangeLabel(step)}</dd></div>
                        </dl>
                        <footer>
                          <code>{step.stepId}</code>
                          <button type="button" className={suggested ? "button button--primary" : "button button--secondary"} onClick={() => chooseStep(step.stepId)}>
                            Review this step <Icon name="arrow" size={14}/>
                          </button>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              )}
              <div className="incident-stage__actions incident-stage__actions--split">
                <span>Every documented step remains selectable. The agent advises; the operator decides.</span>
                <button type="button" className="button button--secondary" onClick={() => setActiveStage("situation")}>Back to situation</button>
                <button type="button" className="button button--primary" disabled={!selectedStepId} onClick={() => selectedStepId && chooseStep(selectedStepId)}>Open procedure execution <Icon name="arrow" size={14}/></button>
              </div>
            </section>
          )}

          {activeStage === "execution" && decision && (
            <section className="incident-stage" aria-labelledby="incident-stage-execution-title">
              <header className="incident-stage__header">
                <div><small>STEP 3 OF 4</small><h3 id="incident-stage-execution-title">Procedure execution</h3></div>
                <p>One procedure step is active at a time. Every state-changing action still requires explicit operator approval.</p>
              </header>

              <ol className="incident-procedure-roadmap" aria-label="Procedure roadmap">
                {decision.procedure.steps.map((step) => {
                  const complete = completedStepIds.has(step.stepId);
                  const active = !complete && selectedStepId === step.stepId;
                  const suggested = !complete && agentSuggestedStepId === step.stepId;
                  const missingPreviousSteps = decision.procedure.steps.filter(
                    (candidate) =>
                      candidate.mandatory &&
                      candidate.order < step.order &&
                      !completedStepIds.has(candidate.stepId),
                  );
                  const advisoryCaution = !complete && missingPreviousSteps.length > 0;
                  return (
                    <li key={step.stepId} className={`${complete ? "is-complete" : ""}${active ? " is-active" : ""}${advisoryCaution ? " is-advisory-caution" : ""}`}>
                      <button
                        type="button"
                        onClick={() => complete
                          ? document.getElementById("text-text-modal-native-incident-completed-step-" + step.stepId.toLowerCase())?.scrollIntoView({ block: "nearest" })
                          : chooseStep(step.stepId)}
                      >
                        <i>{complete ? "✓" : step.order / 10}</i>
                        <span><small>{step.phase} · {step.responsibleRole}</small><strong>{step.title}</strong></span>
                        <b>{complete ? "Recorded" : active ? "Open" : suggested ? "Agent suggests" : "Operator choice"}</b>
                      </button>
                    </li>
                  );
                })}
              </ol>

              {procedureComplete && !selectedStep ? (
                <div className="procedure-workflow-complete" id="text-text-modal-native-incident-workflow-complete" role="status" data-testid="incident-procedure-workflow-complete">
                  <span><Icon name="shield" size={20}/></span>
                  <div><strong>All mandatory procedure steps are recorded</strong><p>Review closure evidence and the return-to-normal criteria before leaving the incident workflow.</p></div>
                  <button type="button" className="button button--primary" onClick={() => setActiveStage("closure")}>Review closure</button>
                </div>
              ) : selectedStep ? (
                <article
                  id={"text-text-modal-native-incident-step-" + selectedStep.stepId.toLowerCase()}
                  className="incident-execution-card"
                  data-testid={"incident-procedure-step-" + selectedStep.stepId}
                >
                  <header>
                    <span><Icon name={stepIcon(selectedStep)} size={21}/></span>
                    <div><small>OPERATOR-SELECTED STEP · {selectedStep.phase} · {selectedStep.responsibleRole}</small><h4>{selectedStep.title}</h4></div>
                    {selectedStep.stepId === agentSuggestedStepId
                      ? <StatusPill tone="purple">Agent suggests now</StatusPill>
                      : <StatusPill tone="warning">Operator choice</StatusPill>}
                  </header>
                  <p className="incident-execution-card__instruction">{selectedStep.instruction}</p>
                  <div className="procedure-citation"><Icon name="shield" size={13}/><span>Citation: {decision.procedure.procedureId} rev. {decision.procedure.revision} · {selectedStep.stepId}</span></div>
                  {choiceAdviceStepId === selectedStep.stepId && (
                    <section className="incident-choice-advice is-loading" role="status">
                      <span><Icon name="activity" size={18}/></span>
                      <div><small>WEBMCP PROCEDURE CHECK</small><strong>Comparing this step with the current state and documented procedure…</strong></div>
                    </section>
                  )}
                  {choiceAdvice?.selectedStepId === selectedStep.stepId && (
                    <section className={`incident-choice-advice is-${choiceAdvice.verdict}`} data-testid="incident-procedure-choice-advice">
                      <span><Icon name={choiceAdvice.verdict === "recommended" ? "shield" : "alert"} size={18}/></span>
                      <div>
                        <small>{choiceAdvice.verdict === "recommended" ? "PROCEDURAL SEQUENCE CONFIRMED" : "PROCEDURAL CAUTION"}</small>
                        <strong>{choiceAdvice.statement}</strong>
                        <ul>{choiceAdvice.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                        <p>This advice is non-blocking. The operator retains authority to approve any documented step.</p>
                      </div>
                    </section>
                  )}
                  {choiceAdviceError && choiceAdviceStepId === null && (
                    <section className="incident-choice-advice is-unavailable" role="status">
                      <span><Icon name="alert" size={18}/></span>
                      <div><small>PROCEDURE CHECK UNAVAILABLE</small><strong>{choiceAdviceError}</strong><p>The selected procedure step remains available to the operator.</p></div>
                    </section>
                  )}
                  <div className="incident-execution-card__decision-grid">
                    <section><small>AGENT RATIONALE</small><p>{selectedAction?.rationale ?? "This step is available in the cited procedure. Select it to obtain a current agent assessment."}</p></section>
                    <section><small>DOCUMENT RATIONALE</small><p>{selectedStep.rationale}</p></section>
                    <section><small>OPERATIONAL CONSEQUENCE</small><p>{consequenceLabel(selectedStep)}</p></section>
                    <section><small>ESTIMATED INTERVENTION</small><p>{durationRangeLabel(selectedStep)}. Planning envelope only; elapsed time never proves completion or clearance.</p></section>
                  </div>
                  {selectedOperationalPlan && <OperationalPlanCard plan={selectedOperationalPlan}/>}
                  <div className="incident-execution-card__checks">
                    <section>
                      <small>REQUIRED EVIDENCE</small>
                      {selectedStep.evidenceRequired.length > 0
                        ? <ul>{selectedStep.evidenceRequired.map((item) => <li key={item}>{item}</li>)}</ul>
                        : <p>No additional evidence listed for this step.</p>}
                    </section>
                    <section>
                      <small>OPERATOR CHECKS</small>
                      {selectedAction?.operatorChecks.length
                        ? <ul>{selectedAction.operatorChecks.map((item) => <li key={item}>{item}</li>)}</ul>
                        : <p>Confirm the cited instruction and current decision revision.</p>}
                    </section>
                  </div>
                  {selectedEvidenceRequirement && (
                    <label
                      className="incident-execution-card__evidence-reference"
                      htmlFor={`operator-evidence-reference-${selectedStep.stepId}`}
                    >
                      <span>
                        <small>MANDATORY AUTHORITY EVIDENCE</small>
                        <strong>{selectedEvidenceRequirement.label}</strong>
                        <em>{selectedEvidenceRequirement.helpText}</em>
                      </span>
                      <input
                        id={`operator-evidence-reference-${selectedStep.stepId}`}
                        data-testid="operator-evidence-reference"
                        type="text"
                        value={selectedEvidenceReference}
                        maxLength={selectedEvidenceRequirement.maxLength}
                        placeholder={selectedEvidenceRequirement.placeholder}
                        autoComplete="off"
                        required
                        aria-required="true"
                        onChange={(event) => {
                          const value = event.target.value;
                          setOperatorEvidenceReferences((current) => ({
                            ...current,
                            [selectedStep.stepId]: value,
                          }));
                          if (value.trim()) setApplyError(null);
                        }}
                      />
                    </label>
                  )}
                  {inlineApprovalStepId === selectedStep.stepId && inlineApproval ? (
                    <InlineWebMcpApproval request={inlineApproval} onDecision={onToolApprovalDecision}/>
                  ) : (
                    <footer>
                      <span><Icon name="shield" size={14}/>Decision rev. {decision.context.evidence.decisionRevision} · explicit approval required</span>
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={stale || isRefreshing || Boolean(applyingStepId) || Boolean(selectedEvidenceRequirement && !selectedEvidenceReference.trim())}
                        onClick={() => void applyStep(selectedStep.stepId)}
                      >
                        {applyingStepId === selectedStep.stepId
                          ? "Awaiting operator approval…"
                          : isRefreshing
                            ? "Updating context…"
                            : selectedEvidenceRequirement && !selectedEvidenceReference.trim()
                                ? "Enter authority reference"
                              : actionLabel(selectedStep)}
                        {applyingStepId !== selectedStep.stepId && <Icon name="arrow" size={14}/>}
                      </button>
                    </footer>
                  )}
                </article>
              ) : (
                <div className="incident-decision__message"><Icon name="activity" size={20}/><div><strong>Select a procedure step</strong><p>Every documented step is available. The agent will assess your choice without blocking it.</p></div></div>
              )}

              {completedProcedureSteps.length > 0 && (
                <details className="incident-completed-history" open>
                  <summary>{completedProcedureSteps.length} recorded step{completedProcedureSteps.length === 1 ? "" : "s"} · view receipts</summary>
                  <div>
                    {completedProcedureSteps.map((step) => {
                      const receipt = receiptForStep(step.stepId);
                      const persistedRecord = decision.context.incident.procedureExecution.stepRecords
                        ?.find((record) => record.stepId === step.stepId);
                      const evidenceReference = receipt?.operatorEvidenceReference ??
                        persistedRecord?.operatorEvidenceReference ?? null;
                      return (
                        <article key={step.stepId} id={"text-text-modal-native-incident-completed-step-" + step.stepId.toLowerCase()} data-testid={"incident-completed-step-" + step.stepId} data-step-status="completed">
                          <span><Icon name="shield" size={16}/></span>
                          <div><small>STEP {step.order / 10} · {step.stepId} · RECORDED OUTCOME</small><strong>{step.title}</strong><p>{receipt?.message ?? `${step.title} was completed and recorded.`}</p>{evidenceReference && <p className="incident-completed-step__evidence">Authority reference · <code>{evidenceReference}</code></p>}</div>
                          <aside>{receipt ? `${receipt.receiptId} · decision rev. ${receipt.decisionRevision} · ${formatTime(receipt.recordedAt)}` : persistedRecord ? `${persistedRecord.receiptId} · ${formatTime(persistedRecord.recordedAt)}` : "Persisted completion · current operational record"}</aside>
                        </article>
                      );
                    })}
                  </div>
                </details>
              )}

              <div className="incident-stage__actions incident-stage__actions--split">
                <button type="button" className="button button--secondary" onClick={() => setActiveStage("options")}>Back to options</button>
                <button type="button" className="button button--primary" onClick={() => setActiveStage("closure")}>Review closure conditions <Icon name="arrow" size={14}/></button>
              </div>
            </section>
          )}

          {activeStage === "closure" && decision && (
            <section className="incident-stage" id="text-text-modal-native-incident-return-to-normal" aria-labelledby="normal-state-title">
              <header className="incident-stage__header">
                <div><small>STEP 4 OF 4</small><h3 id="normal-state-title">Closure</h3></div>
                <p>Business closure is a controlled operational action. Closing this panel does not close the incident.</p>
              </header>
              <section className={`incident-closure-status${procedureComplete ? " is-complete" : ""}`}>
                <span><Icon name={procedureComplete ? "shield" : "alert"} size={24}/></span>
                <div>
                  <small>RETURN-TO-NORMAL GATE</small>
                  <h4>{procedureComplete ? "Procedure closure is recorded" : closurePrerequisitesComplete ? "Ready to review the closure step" : "Closure prerequisites remain open"}</h4>
                  <p>{procedureComplete
                    ? "The documented workflow is complete. Retain the recorded evidence and verify the live operational state before handover."
                    : closurePrerequisitesComplete
                      ? "Protection and recovery prerequisites are recorded. The operator can now review the documented closure action."
                      : `The agent recommends completing ${nextRequiredStepId ?? "the next documented procedure step"} before return to normal. The operator may still review the closure step.`}</p>
                </div>
              </section>
              <div className="incident-stage__two-column incident-closure-grid">
                <section className="incident-stage__panel">
                  <small>CURRENT CLOSURE EVIDENCE</small>
                  <dl className="incident-facts">
                    <div><dt>Incident status</dt><dd>{decision.context.incident.status}</dd></div>
                    <div><dt>Management state</dt><dd>{decision.context.incident.procedureExecution.managementState}</dd></div>
                    <div><dt>Recovery started</dt><dd>{decision.context.incident.procedureExecution.recoveryStartedAt ? formatTime(decision.context.incident.procedureExecution.recoveryStartedAt) : "Not recorded"}</dd></div>
                    <div><dt>Active restrictions</dt><dd>{decision.context.impact.activeRestrictionCount}</dd></div>
                    <div><dt>Mandatory steps</dt><dd>{mandatorySteps.filter((step) => completedStepIds.has(step.stepId)).length}/{mandatorySteps.length} recorded</dd></div>
                  </dl>
                </section>
                <section className="incident-stage__panel">
                  <small>CONDITIONS TO VERIFY BEFORE CLOSURE</small>
                  <h4>Conditions to verify before closure</h4>
                  <ul className="incident-normal-criteria">
                    {decision.procedure.normalStateCriteria.map((criterion) => (
                      <li key={criterion} className={procedureComplete ? "is-complete" : ""}><span>{procedureComplete ? "✓" : "○"}</span>{criterion}</li>
                    ))}
                  </ul>
                </section>
              </div>
              {procedureComplete && (
                <div id="text-text-modal-native-incident-workflow-complete" role="status" data-testid="incident-procedure-workflow-complete" className="incident-closure-receipt">
                  <Icon name="shield" size={19}/><div><strong>Return-to-normal workflow recorded</strong><p>{completedProcedureSteps.length} procedure receipts are available in Procedure execution. Closing the panel now only dismisses this view.</p></div>
                </div>
              )}
              <div className="incident-stage__actions incident-stage__actions--split">
                <button type="button" className="button button--secondary" onClick={() => setActiveStage("execution")}>Back to execution</button>
                {!procedureComplete && (
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={!closeStep && !agentSuggestedStepId}
                    onClick={() => chooseStep(closeStep?.stepId ?? agentSuggestedStepId ?? "")}
                  >
                    {closeStep ? "Review closure step" : "Review agent suggestion"} <Icon name="arrow" size={14}/>
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}
