import { canonicalSha256, procedureContentHash } from "./integrity";
import type {
  IncidentCode,
  OperationalProcedure,
  OperationalProcedureCatalogueMetadata,
  ProcedureCapability,
  ProcedureId,
  ProcedureIncidentEffect,
  OperatorEvidenceReferenceKind,
  ProcedureStep,
  ProcedureTargetType,
  ReturnToNormalCriterion,
} from "./types";

export const DEMO_NOTICE =
  "Synthetic demonstration procedure authored for the Paris ICC simulation. " +
  "It is not an official RATP, IDFM, infrastructure-manager, or regulatory instruction.";

export const PROCEDURE_CATALOG_REVISION = "2026.08.30.4";

const EFFECTIVE_FROM = Date.UTC(2026, 0, 1, 0, 0, 0);
type ProcedureDraft = Omit<OperationalProcedure, "contentHash">;

interface ProcedureSpec {
  procedureId: ProcedureId;
  revision?: string;
  title: string;
  summary: string;
  incidentCodes: readonly IncidentCode[];
  targetType: ProcedureTargetType;
  effects: readonly ProcedureIncidentEffect[];
  protectedScope: string;
  assessmentInstruction: string;
  assessmentEvidence: readonly string[];
  clearanceRole: string;
  requiredEvidenceReferenceKind?: OperatorEvidenceReferenceKind;
  recoveryInstruction: string;
  recoveryEvidence: readonly string[];
  normalObjective: string;
  targetNormalEvidence: string;
  serviceNormalEvidence: string;
  observationWindowSeconds?: number;
  recoveryCapability?: ProcedureCapability;
  recoveryDurationRangeSeconds?: ProcedureStep["durationRangeSeconds"];
  coordinationDurationRangeSeconds?: ProcedureStep["durationRangeSeconds"];
  maintenanceDispatch?: Readonly<{
    role: string;
    instruction: string;
    durationRangeSeconds: ProcedureStep["durationRangeSeconds"];
  }>;
  mandatoryProvisionalService?: Readonly<{
    turnbackInstruction: string;
    turnbackEvidence: readonly string[];
    turnbackCompletion: string;
    turnbackDurationRangeSeconds: ProcedureStep["durationRangeSeconds"];
    serviceInstruction: string;
    serviceEvidence: readonly string[];
    serviceCompletion: string;
    serviceDurationRangeSeconds: ProcedureStep["durationRangeSeconds"];
  }>;
}

function step(input: {
  procedureId: ProcedureId;
  index: number;
  phase: ProcedureStep["phase"];
  title: string;
  instruction: string;
  rationale: string;
  responsibleRole?: string;
  preconditions?: readonly string[];
  evidenceRequired?: readonly string[];
  completionCriteria?: readonly string[];
  capability?: ProcedureCapability;
  mandatory?: boolean;
  order?: number;
  durationRangeSeconds?: ProcedureStep["durationRangeSeconds"];
  requiredEvidenceReferenceKind?: OperatorEvidenceReferenceKind;
}): ProcedureStep {
  return Object.freeze({
    stepId: `${input.procedureId}-S${String(input.index).padStart(2, "0")}`,
    order: input.order ?? input.index * 10,
    phase: input.phase,
    title: input.title,
    instruction: input.instruction,
    rationale: input.rationale,
    responsibleRole: input.responsibleRole ?? "ICC operator",
    mandatory: input.mandatory ?? true,
    preconditions: Object.freeze([...(input.preconditions ?? [])]),
    evidenceRequired: Object.freeze([...(input.evidenceRequired ?? [])]),
    completionCriteria: Object.freeze([...(input.completionCriteria ?? [])]),
    durationRangeSeconds: Object.freeze(input.durationRangeSeconds ?? {
      minSeconds: 15,
      nominalSeconds: 60,
      maxSeconds: 300,
    }),
    ...(input.requiredEvidenceReferenceKind
      ? { requiredEvidenceReferenceKind: input.requiredEvidenceReferenceKind }
      : {}),
    ...(input.capability ? { capability: input.capability } : {}),
    operatorConfirmationRequired: Boolean(input.capability),
  });
}

function buildSteps(spec: ProcedureSpec): readonly ProcedureStep[] {
  return Object.freeze([
    step({
      procedureId: spec.procedureId,
      index: 1,
      phase: "acknowledge",
      title: "Acknowledge and bind the incident",
      instruction: "Confirm the incident code, exact target, occurrence time, and current decision revision before considering a response.",
      rationale: "Every recommendation must remain bound to the qualified event and exact current operational state.",
      evidenceRequired: ["Incident ID and code", "Target ID", "Decision revision"],
      completionCriteria: ["The operator has acknowledged the exact incident and target."],
      capability: "acknowledge",
    }),
    step({
      procedureId: spec.procedureId,
      index: 2,
      phase: "protect",
      title: "Establish operational protection",
      instruction: `Protect ${spec.protectedScope} and hold or meter any movement that could enter the affected scope.`,
      rationale: "Protection must precede diagnosis, mitigation, and recovery.",
      preconditions: ["The incident is active and the target exists in the current digital twin."],
      evidenceRequired: ["Target location and state", "Affected and approaching train IDs", "Active restriction state"],
      completionCriteria: ["The affected scope has a protected disposition and no uncontrolled entry remains."],
      capability: "protect-and-hold",
    }),
    step({
      procedureId: spec.procedureId,
      index: 3,
      phase: "diagnose",
      title: "Collect the coded-event evidence",
      instruction: spec.assessmentInstruction,
      rationale: "The agent must use observed evidence and must not invent a live field, technical, security, or electrical report.",
      preconditions: ["Operational protection is confirmed."],
      evidenceRequired: spec.assessmentEvidence,
      completionCriteria: ["The cause, impact, and continued-protection decision are recorded."],
    }),
    ...(spec.mandatoryProvisionalService ? [
      step({
        procedureId: spec.procedureId,
        index: 32,
        order: 32,
        phase: "mitigate",
        title: "Activate graph-grounded flanking turnbacks",
        instruction: spec.mandatoryProvisionalService.turnbackInstruction,
        rationale: "The unavailable station must be excluded from train movements before a split service can protect passenger journeys on either side.",
        preconditions: [
          "Operational protection is confirmed.",
          "The affected station and its adjacent operating scope are recorded.",
        ],
        evidenceRequired: spec.mandatoryProvisionalService.turnbackEvidence,
        completionCriteria: [spec.mandatoryProvisionalService.turnbackCompletion],
        capability: "activate-turnbacks",
        mandatory: true,
        durationRangeSeconds: spec.mandatoryProvisionalService.turnbackDurationRangeSeconds,
      }),
      step({
        procedureId: spec.procedureId,
        index: 33,
        order: 33,
        phase: "mitigate",
        title: "Activate the split provisional service",
        instruction: spec.mandatoryProvisionalService.serviceInstruction,
        rationale: "A protected closure needs an explicit, operator-approved continuity plan; protection alone does not provide a usable passenger service.",
        preconditions: [
          "The graph-grounded flanking turnbacks have an operator-approved receipt.",
          "No movement is authorised into the excluded station scope.",
        ],
        evidenceRequired: spec.mandatoryProvisionalService.serviceEvidence,
        completionCriteria: [spec.mandatoryProvisionalService.serviceCompletion],
        capability: "activate-provisional-service",
        mandatory: true,
        durationRangeSeconds: spec.mandatoryProvisionalService.serviceDurationRangeSeconds,
      }),
    ] : []),
    ...(spec.maintenanceDispatch ? [step({
      procedureId: spec.procedureId,
      index: 35,
      order: 35,
      phase: "coordinate",
      title: "Dispatch the grounded maintenance intervention",
      instruction: spec.maintenanceDispatch.instruction,
      rationale: "A dispatch receipt authorises a scoped intervention only; it never proves clearance, recovery, or return to normal.",
      responsibleRole: spec.maintenanceDispatch.role,
      preconditions: ["Operational protection and the coded technical diagnosis are recorded."],
      evidenceRequired: [
        "Grounded maintenance target and affected entity IDs",
        "Named maintenance team or discipline",
        "Minimum, nominal, and maximum intervention estimate",
        "Operator approval",
      ],
      completionCriteria: ["A persistent dispatch receipt identifies the target, team, approval time, and ETA range."],
      capability: "dispatch-maintenance",
      mandatory: false,
      durationRangeSeconds: spec.maintenanceDispatch.durationRangeSeconds,
    })] : []),
    step({
      procedureId: spec.procedureId,
      index: 4,
      phase: "coordinate",
      title: "Record the applicable clearance",
      instruction: `Request and record a clearance or continued-protection decision from the named ${spec.clearanceRole}.`,
      rationale: "Elapsed time or apparent service improvement cannot replace the required clearance.",
      preconditions: ["The coded-event evidence is complete enough for the named role to decide."],
      evidenceRequired: ["Named competent authority", "Clearance scope", "Clearance or handback reference"],
      completionCriteria: ["A scoped clearance or continued-protection decision is recorded."],
      durationRangeSeconds: spec.coordinationDurationRangeSeconds,
      requiredEvidenceReferenceKind: spec.requiredEvidenceReferenceKind,
    }),
    ...([
      [41, "publish-passenger-information", "Publish reviewed passenger information", "After more than 15 minutes, publish the reviewed disruption scope and connection consequences."],
      [42, "protect-connections", "Protect grounded connections", "After more than 15 minutes, protect only graph-grounded connections exposed by the decision context."],
      [43, "activate-provisional-service", "Activate a provisional service", "After more than 25 minutes, approve the proposed provisional service over graph-grounded termini."],
      [44, "activate-turnbacks", "Activate reviewed turnbacks", "After more than 25 minutes, approve turnbacks only at termini returned by the interdependence graph."],
      [45, "activate-shuttle-bus", "Activate bidirectional shuttle buses", "After more than 60 minutes, approve the proposed outbound and inbound shuttle-bus service."],
      [46, "insert-train", "Approve a grounded train insertion", "Approve an insertion only at an eligible terminal returned by the interdependence graph."],
    ] as const)
      .filter(([, capability]) =>
        !spec.mandatoryProvisionalService ||
        (capability !== "activate-provisional-service" && capability !== "activate-turnbacks")
      )
      .map(([index, capability, title, instruction]) => step({
      procedureId: spec.procedureId,
      index,
      order: index,
      phase: "mitigate",
      title,
      instruction,
      rationale: "The capability remains a proposal until an operator approves this exact procedure step; elapsed time never applies it automatically.",
      preconditions: ["The operational-response context reports this capability as proposed and due."],
      evidenceRequired: ["Current incident revision", "Graph-grounded affected entity IDs", "Operator approval"],
      completionCriteria: ["A persistent operator-approved receipt identifies the exact affected entities."],
      capability,
      mandatory: false,
      durationRangeSeconds: { minSeconds: 30, nominalSeconds: 120, maxSeconds: 600 },
    })),
    step({
      procedureId: spec.procedureId,
      index: 5,
      phase: "recover",
      title: "Apply a monitored recovery",
      instruction: spec.recoveryInstruction,
      rationale: "A staged monitored recovery exposes secondary impact before normal operation is declared.",
      preconditions: ["A valid clearance covers the exact target and intended recovery."],
      evidenceRequired: spec.recoveryEvidence,
      completionCriteria: ["The recovery action is applied and its first operational result is observed."],
      capability: spec.recoveryCapability ?? "degraded-operation",
      durationRangeSeconds: spec.recoveryDurationRangeSeconds,
    }),
    step({
      procedureId: spec.procedureId,
      index: 6,
      phase: "verify",
      title: "Verify the return-to-normal gates",
      instruction: "Re-inspect the digital twin and record every return-to-normal criterion throughout the procedure observation window.",
      rationale: "Removing a restriction is not by itself proof that normal service has returned.",
      preconditions: ["The monitored recovery step has completed."],
      evidenceRequired: ["Fresh telemetry revision", "Return-to-normal criterion results"],
      completionCriteria: ["Every required criterion passes or the incident remains in recovery."],
    }),
    step({
      procedureId: spec.procedureId,
      index: 7,
      phase: "close",
      title: "Close the incident",
      instruction: "Resolve the incident only after the observation window is complete and the operator has signed off every mandatory criterion.",
      rationale: "Closure is a guarded outcome of verified recovery, not a shortcut action.",
      preconditions: ["All mandatory steps are complete.", "All return-to-normal criteria pass."],
      evidenceRequired: ["Operator sign-off", "Completed recovery checklist"],
      completionCriteria: ["The incident is resolved and no incident-owned restriction remains."],
      capability: "resolve-simulation",
    }),
  ]);
}

function returnCriteria(spec: ProcedureSpec): readonly ReturnToNormalCriterion[] {
  return Object.freeze([
    Object.freeze({
      criterionId: "incident-condition-cleared",
      label: "Incident condition cleared",
      evidence: spec.targetNormalEvidence,
      required: true as const,
    }),
    Object.freeze({
      criterionId: "restrictions-cleared",
      label: "Incident restrictions cleared",
      evidence: "The digital twin reports no active restriction owned by this incident.",
      required: true as const,
    }),
    Object.freeze({
      criterionId: "service-observed",
      label: "Service recovery observed",
      evidence: spec.serviceNormalEvidence,
      required: true as const,
    }),
    Object.freeze({
      criterionId: "operator-signoff",
      label: "Operator sign-off recorded",
      evidence: "The operator records the applicable clearance and confirms the complete return-to-normal checklist.",
      required: true as const,
    }),
  ]);
}

const SPECS: readonly ProcedureSpec[] = [
  {
    procedureId: "ICC-PROC-RST-TRAIN-001",
    title: "Immobilised rolling-stock response",
    summary: "Protect a stopped train, establish a technical diagnosis, and restore movement under operator control.",
    incidentCodes: ["ICC-INC-RST-TRN-IMM-001"],
    targetType: "train",
    effects: ["stop-train"],
    protectedScope: "the immobilised train and its approach scope",
    assessmentInstruction: "Record train location, occupancy, delay, status, and the rolling-stock assessment.",
    assessmentEvidence: ["Train telemetry", "Passenger count", "Technical assessment"],
    clearanceRole: "rolling-stock technical role",
    recoveryInstruction: "Release the target train only after clearance, then monitor its first location change and following service gap.",
    recoveryEvidence: ["Technical clearance reference", "First movement telemetry"],
    normalObjective: "The train is moving or has a cleared alternate disposition, and following movements are stable.",
    targetNormalEvidence: "The target is no longer stopped by this incident and a subsequent location update is observed.",
    serviceNormalEvidence: "Following trains are not held by this incident for at least two consecutive telemetry updates.",
    maintenanceDispatch: {
      role: "rolling-stock maintenance coordinator",
      instruction: "Dispatch a rolling-stock maintenance team to the exact immobilised train, recording access constraints and a 5–60 minute intervention estimate before any technical release.",
      durationRangeSeconds: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
    },
  },
  {
    procedureId: "ICC-PROC-ONBOARD-001",
    title: "On-board passenger, staff, or external event",
    summary: "Protect a stopped service while the relevant competent authority assesses an on-board or crew event.",
    incidentCodes: ["ICC-INC-PAX-TRN-IMM-001", "ICC-INC-EXT-TRN-IMM-001", "ICC-INC-STF-TRN-IMM-001"],
    targetType: "train",
    effects: ["stop-train"],
    protectedScope: "the affected service and its operating scope",
    assessmentInstruction: "Record whether passenger assistance, security clearance, or qualified staff relief is required for the coded event.",
    assessmentEvidence: ["Target telemetry", "Passenger exposure", "Required assistance or relief role"],
    clearanceRole: "passenger, security, or crew-control role selected by the incident code",
    recoveryInstruction: "After the applicable clearance, release the train under monitoring or record its alternate service disposition.",
    recoveryEvidence: ["Authority clearance reference", "Updated train telemetry"],
    normalObjective: "The protected train has a cleared disposition and no event-owned hold remains.",
    targetNormalEvidence: "The required passenger, security, or staffing clearance is attached to the target train.",
    serviceNormalEvidence: "The train disposition and following service remain stable during the observation window.",
  },
  {
    procedureId: "ICC-PROC-STATION-CLOSURE-001",
    revision: "1.1",
    title: "Station closure and controlled reopening",
    summary: "Protect a closed station, coordinate passenger handling, and reopen only after explicit clearance.",
    incidentCodes: ["ICC-INC-PAX-STA-CLS-001", "ICC-INC-INF-STA-CLS-001", "ICC-INC-EXT-STA-CLS-001"],
    targetType: "station",
    effects: ["station-closure"],
    protectedScope: "the closed station and its adjacent operating scope",
    assessmentInstruction: "Record station availability, adjacent movement impact, passenger handling, and the authority responsible for reopening.",
    assessmentEvidence: ["Station state", "Adjacent interstations", "Passenger-information status"],
    clearanceRole: "station reopening authority",
    recoveryInstruction: "Remove the station restriction after clearance and monitor the first service calls.",
    recoveryEvidence: ["Reopening clearance", "First service-call telemetry"],
    normalObjective: "The station is available, adjacent restrictions are removed, and normal calls are observed.",
    targetNormalEvidence: "The station reports available and its reopening clearance is attached to the incident.",
    serviceNormalEvidence: "At least one train call is observed without an incident-owned hold.",
    maintenanceDispatch: {
      role: "station infrastructure maintenance coordinator",
      instruction: "When the coded cause is technical, dispatch station infrastructure maintenance to the exact station scope and record a 5–40 minute intervention estimate.",
      durationRangeSeconds: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 2_400 },
    },
  },
  {
    procedureId: "ICC-PROC-STATION-WORKS-CLOSURE-001",
    requiredEvidenceReferenceKind: "works-handback",
    title: "Planned station works closure and handback",
    summary: "Exclude a station under engineering possession, operate a mandatory split provisional service between flanking turnbacks, and reopen only after an explicit scoped handback.",
    incidentCodes: ["ICC-INC-WRK-STA-CLS-001"],
    targetType: "station",
    effects: ["station-closure"],
    protectedScope: "the station under engineering possession, both adjacent interstations, and every movement approaching the worksite limits",
    assessmentInstruction: "Verify the possession reference, exact station and worksite limits, adjacent interstations, approaching train dispositions, passenger impact, and graph-grounded stations that flank the excluded scope.",
    assessmentEvidence: [
      "Engineering possession reference and worksite limits",
      "Closed station and adjacent interstation IDs",
      "Approaching and affected train dispositions",
      "Graph-grounded flanking-station evidence",
      "Passenger-information and accessibility impact",
    ],
    clearanceRole: "engineering possession handback role",
    recoveryInstruction: "Keep both the turnbacks and split provisional service active until an explicit engineering handback covers the complete station and adjacent operating scope; then perform a monitored reopening without routing passenger service through the station until the first controlled traversal is accepted.",
    recoveryEvidence: [
      "Engineering handback reference and exact cleared limits",
      "Station, platform, and adjacent-route availability",
      "First controlled traversal telemetry",
      "Provisional-service withdrawal decision",
    ],
    normalObjective: "The engineering possession is handed back, the station and adjacent route are available, normal calls are observed, and the provisional service is withdrawn under operator control.",
    targetNormalEvidence: "An explicit engineering handback confirms the worksite clear and the station, platforms, passenger access, and adjacent operating scope available.",
    serviceNormalEvidence: "A controlled traversal and the first passenger calls complete without renewed restriction before the flanking turnbacks and provisional service are stood down.",
    coordinationDurationRangeSeconds: { minSeconds: 600, nominalSeconds: 900, maxSeconds: 2_400 },
    mandatoryProvisionalService: {
      turnbackInstruction: "Select the nearest eligible graph-grounded operating stations that flank the closed works scope, hold every approaching train outside that scope, and activate operator-approved turnbacks in both available directions; no train may enter, traverse, or call at the station under possession.",
      turnbackEvidence: [
        "Upstream and downstream graph-grounded flanking station IDs",
        "Approaching train hold or turnback dispositions",
        "Engineering possession limits",
        "Operator approval and turnback receipt",
      ],
      turnbackCompletion: "A persistent operator-approved receipt identifies the flanking turnback stations and every approaching train has a disposition outside the works scope.",
      turnbackDurationRangeSeconds: { minSeconds: 300, nominalSeconds: 600, maxSeconds: 1_200 },
      serviceInstruction: "Activate the split provisional service between the normal line termini and each approved flanking turnback, record the service pattern and reviewed headway on both sides, and publish that the closed station is neither served nor traversed.",
      serviceEvidence: [
        "Operator-approved turnback receipt",
        "Service pattern, train IDs, and target headway on each side",
        "Excluded station and interstation IDs",
        "Reviewed passenger-information message",
        "Operator approval and provisional-service receipt",
      ],
      serviceCompletion: "A persistent operator-approved receipt records an active provisional service on each operable side and excludes the station under works from every train path and stop pattern.",
      serviceDurationRangeSeconds: { minSeconds: 300, nominalSeconds: 600, maxSeconds: 1_800 },
    },
    observationWindowSeconds: 60,
  },
  {
    procedureId: "ICC-PROC-STATION-DWELL-001",
    title: "Extended station dwell management",
    summary: "Regulate a prolonged dwell event, monitor passenger-flow evidence, and recover the normal dwell profile.",
    incidentCodes: ["ICC-INC-PAX-STA-DWL-001", "ICC-INC-INF-STA-DWL-001", "ICC-INC-WRK-STA-DWL-001", "ICC-INC-EXT-STA-DWL-001"],
    targetType: "station",
    effects: ["station-dwell"],
    protectedScope: "arrivals into the affected station",
    assessmentInstruction: "Compare dwell duration, passenger count, affected trains, and propagated delay before changing regulation.",
    assessmentEvidence: ["Dwell duration", "Passenger exposure", "Affected train IDs"],
    clearanceRole: "station operations role",
    recoveryInstruction: "Remove the dwell extension progressively and observe two successive service calls.",
    recoveryEvidence: ["Two service-call dwell observations", "Following headway telemetry"],
    normalObjective: "Station dwell and following headways remain within the nominal operating profile.",
    targetNormalEvidence: "The station no longer applies the incident-owned dwell extension.",
    serviceNormalEvidence: "Two successive calls complete without new incident-attributable delay growth.",
    maintenanceDispatch: {
      role: "station systems maintenance coordinator",
      instruction: "When the coded cause is technical, dispatch station systems maintenance to the affected platform or equipment and record a 5–30 minute intervention estimate.",
      durationRangeSeconds: { minSeconds: 300, nominalSeconds: 600, maxSeconds: 1_800 },
    },
  },
  {
    procedureId: "ICC-PROC-INTERSTATION-BLOCK-001",
    title: "Unplanned interstation blockage",
    summary: "Protect an unavailable interstation, obtain scoped clearance, and prove the first restored traversal.",
    incidentCodes: ["ICC-INC-INF-INT-BLK-001", "ICC-INC-EXT-INT-BLK-001"],
    targetType: "interstation",
    effects: ["block-interstation"],
    protectedScope: "the exact interstation and approaching movements",
    assessmentInstruction: "Capture the infrastructure or external-event assessment and its exact geographic scope; never infer clearance from elapsed time.",
    assessmentEvidence: ["Interstation ID", "Restriction state", "Approaching train IDs"],
    clearanceRole: "technical or external authority selected by the incident code",
    recoveryInstruction: "Replace the block with one monitored degraded traversal, then observe the following movement.",
    recoveryEvidence: ["Scoped clearance", "Complete traversal telemetry"],
    normalObjective: "The interstation is available and complete traversals occur without renewed restriction.",
    targetNormalEvidence: "The responsible authority clears the exact interstation.",
    serviceNormalEvidence: "A complete traversal and one following movement occur without renewed blocking.",
    maintenanceDispatch: {
      role: "infrastructure maintenance coordinator",
      instruction: "Dispatch infrastructure maintenance to the exact blocked interstation, recording the protected access path and a 10–60 minute intervention estimate.",
      durationRangeSeconds: { minSeconds: 600, nominalSeconds: 1_200, maxSeconds: 3_600 },
    },
  },
  {
    procedureId: "ICC-PROC-WORKS-HANDBACK-001",
    requiredEvidenceReferenceKind: "works-handback",
    title: "Engineering possession handback",
    summary: "Maintain an engineering block until its possession reference and handback are explicitly verified.",
    incidentCodes: ["ICC-INC-WRK-INT-BLK-001"],
    targetType: "interstation",
    effects: ["block-interstation"],
    protectedScope: "the declared engineering worksite and possession limits",
    assessmentInstruction: "Verify that the possession reference, worksite limits, and completion state refer to the exact interstation.",
    assessmentEvidence: ["Possession reference", "Worksite limits", "Work completion state"],
    clearanceRole: "engineering handback role",
    recoveryInstruction: "After explicit handback, model one controlled traversal before restoring normal use.",
    recoveryEvidence: ["Engineering handback", "Worksite-clear confirmation", "First traversal telemetry"],
    normalObjective: "The possession is handed back and normal movement is observed through the former worksite.",
    targetNormalEvidence: "An explicit engineering handback covers the exact possession limits.",
    serviceNormalEvidence: "A controlled traversal and following movement complete without a works restriction.",
  },
  {
    procedureId: "ICC-PROC-INTERSTATION-SPEED-001",
    title: "Temporary interstation speed restriction",
    summary: "Apply, monitor, and withdraw a speed restriction using exact segment evidence.",
    incidentCodes: ["ICC-INC-INF-INT-SPD-001", "ICC-INC-WRK-INT-SPD-001", "ICC-INC-EXT-INT-SPD-001"],
    targetType: "interstation",
    effects: ["reduce-speed"],
    protectedScope: "the restricted interstation at the reviewed speed limit",
    assessmentInstruction: "Verify the segment, applicable limit, restriction owner, traversal speed, and resulting delay impact.",
    assessmentEvidence: ["Interstation ID", "Applicable speed limit", "Traversal and delay telemetry"],
    clearanceRole: "restriction withdrawal authority",
    recoveryInstruction: "After withdrawal clearance, remove the temporary limit and observe two complete traversals.",
    recoveryEvidence: ["Withdrawal clearance", "Two traversal observations"],
    normalObjective: "The restriction cause is cleared and normal traversal remains stable.",
    targetNormalEvidence: "A valid withdrawal clearance covers the exact interstation and restriction.",
    serviceNormalEvidence: "Two traversals complete without renewed restriction or incident delay growth.",
    maintenanceDispatch: {
      role: "infrastructure maintenance coordinator",
      instruction: "Dispatch infrastructure maintenance to the exact restricted interstation, recording access conditions and a 10–90 minute intervention estimate.",
      durationRangeSeconds: { minSeconds: 600, nominalSeconds: 1_800, maxSeconds: 5_400 },
    },
  },
  {
    procedureId: "ICC-PROC-POWER-DEGRADED-001",
    title: "Degraded traction-power operation",
    summary: "Protect the supplied scope, monitor electrical evidence, and recover nominal traction performance.",
    incidentCodes: ["ICC-INC-PWR-PWR-DEG-001", "ICC-INC-INF-PWR-DEG-001", "ICC-INC-EXT-PWR-DEG-001"],
    targetType: "power",
    effects: ["degrade-power"],
    protectedScope: "the affected electrical section, supplied circuits, and trains",
    assessmentInstruction: "Record voltage, load, supplied circuits, train impact, and the coded cause; do not infer switching instructions without verified evidence.",
    assessmentEvidence: ["Power-section telemetry", "Circuit IDs", "Affected train telemetry"],
    clearanceRole: "electrical control role",
    recoveryInstruction: "After explicit restoration clearance, return the section toward nominal supply and monitor the first affected movement.",
    recoveryEvidence: ["Electrical clearance", "Voltage and load telemetry", "First movement telemetry"],
    normalObjective: "Nominal supply and stable train performance are observed across the section.",
    targetNormalEvidence: "The section reports nominal voltage and load after electrical clearance.",
    serviceNormalEvidence: "Affected trains move without renewed power-attributable delay growth.",
    maintenanceDispatch: {
      role: "traction-power maintenance coordinator",
      instruction: "Dispatch traction-power maintenance to the exact degraded section without issuing switching instructions, and record a 5–60 minute intervention estimate.",
      durationRangeSeconds: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
    },
    observationWindowSeconds: 60,
  },
  {
    procedureId: "ICC-PROC-POWER-ISOLATION-001",
    title: "Isolated traction-power section",
    summary: "Hold supplied movements during isolation and restore them only after electrical clearance.",
    incidentCodes: ["ICC-INC-PWR-PWR-ISO-001", "ICC-INC-INF-PWR-ISO-001", "ICC-INC-EXT-PWR-ISO-001"],
    targetType: "power",
    effects: ["isolate-power"],
    protectedScope: "every movement supplied by the isolated electrical section",
    assessmentInstruction: "Record isolation scope, supplied circuits, affected train locations, and the named electrical authority without inferring switching instructions.",
    assessmentEvidence: ["Isolation state", "Circuit IDs", "Affected train locations"],
    clearanceRole: "electrical restoration role",
    recoveryInstruction: "After explicit clearance, restore supply and observe voltage, load, and the first affected movement.",
    recoveryEvidence: ["Electrical restoration clearance", "Voltage and load telemetry", "First movement telemetry"],
    normalObjective: "The section has nominal supply and affected trains have resumed.",
    targetNormalEvidence: "The section reports nominal voltage after explicit electrical clearance.",
    serviceNormalEvidence: "At least one affected movement and a following telemetry update remain stable.",
    maintenanceDispatch: {
      role: "traction-power maintenance coordinator",
      instruction: "Dispatch traction-power maintenance to the isolated section under the named electrical authority, and record a 5–60 minute intervention estimate.",
      durationRangeSeconds: { minSeconds: 300, nominalSeconds: 1_200, maxSeconds: 3_600 },
    },
    observationWindowSeconds: 60,
  },
  {
    procedureId: "ICC-PROC-POWER-WORKS-001",
    requiredEvidenceReferenceKind: "works-handback",
    title: "Electrical works possession and handback",
    summary: "Protect a degraded or isolated works section and require explicit electrical handback before restoration.",
    incidentCodes: ["ICC-INC-WRK-PWR-DEG-001", "ICC-INC-WRK-PWR-ISO-001"],
    targetType: "power",
    effects: ["degrade-power", "isolate-power"],
    protectedScope: "the electrical works section, supplied circuits, and affected movements",
    assessmentInstruction: "Verify the electrical works reference, exact section limits, supply state, and work completion evidence.",
    assessmentEvidence: ["Electrical works reference", "Section and circuit IDs", "Work completion state"],
    clearanceRole: "electrical works handback role",
    recoveryInstruction: "After explicit handback, restore the supply state and observe electrical telemetry and the first supplied movement.",
    recoveryEvidence: ["Electrical handback", "Section-clear confirmation", "Voltage/load and movement telemetry"],
    normalObjective: "The electrical works possession is handed back and supplied service is stable.",
    targetNormalEvidence: "A valid electrical handback covers the section and nominal supply is observed.",
    serviceNormalEvidence: "The first supplied movement completes and electrical telemetry remains stable.",
    maintenanceDispatch: {
      role: "traction-power works maintenance coordinator",
      instruction: "Dispatch the traction-power works team to the exact electrical possession limits and record a 10–90 minute intervention estimate before handback review.",
      durationRangeSeconds: { minSeconds: 600, nominalSeconds: 1_800, maxSeconds: 5_400 },
    },
    observationWindowSeconds: 60,
  },
  {
    procedureId: "ICC-PROC-SCADA-COMMUNICATION-001",
    title: "Line SCADA communication recovery",
    summary: "Protect a line during degraded or lost supervisory communication and coordinate a maintenance dispatch without inventing field evidence.",
    incidentCodes: ["ICC-INC-COM-LIN-DEG-001", "ICC-INC-COM-LIN-LOS-001"],
    targetType: "line",
    effects: ["communication-degraded", "communication-loss"],
    protectedScope: "the affected line and every movement whose safe supervision depends on the unavailable channel",
    assessmentInstruction: "Record SCADA heartbeat state, affected line, last trusted telemetry, and available independent communication evidence.",
    assessmentEvidence: ["Line SCADA state", "Last heartbeat timestamp", "Independent communication evidence"],
    clearanceRole: "communications maintenance and line control role",
    recoveryInstruction: "Dispatch the grounded maintenance intervention; keep protection until fresh telemetry and explicit communications clearance are observed.",
    recoveryEvidence: ["Maintenance dispatch receipt", "Fresh SCADA heartbeat", "Communications clearance"],
    normalObjective: "The line SCADA channel is nominal and fresh telemetry remains stable during the observation window.",
    targetNormalEvidence: "The affected line reports a fresh heartbeat and no active communication incident.",
    serviceNormalEvidence: "Movements remain controlled through at least two fresh telemetry updates.",
    recoveryCapability: "dispatch-maintenance",
    recoveryDurationRangeSeconds: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
    observationWindowSeconds: 60,
  },
  {
    procedureId: "ICC-PROC-ABANDONED-BAGGAGE-001",
    requiredEvidenceReferenceKind: "police-clearance",
    revision: "1.1",
    title: "Abandoned baggage and police clearance",
    summary: "Exclude the station from every train path and stop, operate a mandatory split provisional service between flanking turnbacks, and require explicit police clearance; the one-hour duration is a planning estimate, never an automatic release.",
    incidentCodes: ["ICC-INC-SEC-STA-BAG-001"],
    targetType: "station",
    effects: ["abandoned-baggage"],
    protectedScope: "the affected station, passenger routes, both adjacent interstations, and every movement that could enter, traverse, or call at the station",
    assessmentInstruction: "Record the exact object location, complete station and adjacent-route protection, all approaching train dispositions, passenger-flow impact, police notification reference, and graph-grounded stations that flank the excluded scope.",
    assessmentEvidence: [
      "Station and object location",
      "Adjacent interstation and approaching train IDs",
      "Passenger-flow evidence",
      "Police notification reference",
      "Graph-grounded flanking-station evidence",
    ],
    clearanceRole: "police/security authority",
    recoveryInstruction: "Keep the station excluded, with both turnbacks and the split provisional service active, until the police/security authority issues an explicit clearance covering the object, station, platforms, and adjacent operating scope; then perform a monitored reopening before withdrawing the provisional service.",
    recoveryEvidence: [
      "Police clearance reference and exact cleared scope",
      "Station, platform, passenger-route, and adjacent-route availability",
      "First controlled traversal and service-call telemetry",
      "Provisional-service withdrawal decision",
    ],
    normalObjective: "The police-cleared station and adjacent route are available, normal calls and passenger flows are stable, and the provisional service is withdrawn under operator control.",
    targetNormalEvidence: "An explicit police clearance confirms the object and exact station scope safe and confirms the platforms, passenger routes, and adjacent operating scope available.",
    serviceNormalEvidence: "A controlled traversal, a service call, and a passenger-flow update complete without renewed restriction before the flanking turnbacks and provisional service are stood down.",
    coordinationDurationRangeSeconds: { minSeconds: 1_800, nominalSeconds: 3_600, maxSeconds: 7_200 },
    mandatoryProvisionalService: {
      turnbackInstruction: "Select the nearest eligible graph-grounded operating stations that flank the excluded station, hold every approaching train outside both adjacent interstations, and activate operator-approved turnbacks in both available directions; no train may enter, pass through, or stop at the affected station before police clearance.",
      turnbackEvidence: [
        "Upstream and downstream graph-grounded flanking station IDs",
        "Approaching train hold or turnback dispositions",
        "Affected station and adjacent interstation IDs",
        "Operator approval and turnback receipt",
      ],
      turnbackCompletion: "A persistent operator-approved receipt identifies the flanking turnback stations and confirms a protected disposition for every approaching train outside the excluded scope.",
      turnbackDurationRangeSeconds: { minSeconds: 300, nominalSeconds: 600, maxSeconds: 1_200 },
      serviceInstruction: "Activate the split provisional service between the normal line termini and each approved flanking turnback, record the service pattern and reviewed headway on both sides, and publish that trains neither traverse nor serve the excluded station.",
      serviceEvidence: [
        "Operator-approved turnback receipt",
        "Service pattern, train IDs, and target headway on each side",
        "Excluded station and interstation IDs",
        "Reviewed passenger-information message",
        "Operator approval and provisional-service receipt",
      ],
      serviceCompletion: "A persistent operator-approved receipt records an active provisional service on each operable side and excludes the affected station from every train path and stop pattern.",
      serviceDurationRangeSeconds: { minSeconds: 300, nominalSeconds: 600, maxSeconds: 1_800 },
    },
    observationWindowSeconds: 60,
  },
  {
    procedureId: "ICC-PROC-ROLLING-STOCK-TOWING-001",
    title: "Rolling-stock towing response",
    summary: "Protect an immobilised train, ground the rescue path, and start a reviewed towing operation with a three-hour nominal planning duration.",
    incidentCodes: ["ICC-INC-RST-TRN-TOW-001"],
    targetType: "train",
    effects: ["tow-train"],
    protectedScope: "the immobilised train, rescue approach, and graph-grounded receiving terminal",
    assessmentInstruction: "Record train location, rescue compatibility, passenger disposition, route availability, and the grounded receiving terminal.",
    assessmentEvidence: ["Target train telemetry", "Rescue compatibility", "Graph-grounded route and terminal"],
    clearanceRole: "rolling-stock rescue and infrastructure control role",
    recoveryInstruction: "Start towing only after operator approval of the exact rescue train, path, and receiving terminal; monitor the full movement.",
    recoveryEvidence: ["Towing receipt", "Rescue path telemetry", "Receiving terminal evidence"],
    normalObjective: "The disabled train reaches its cleared disposition and the operating route returns to stable use.",
    targetNormalEvidence: "The towing receipt and final train location identify the grounded receiving terminal.",
    serviceNormalEvidence: "Following movements operate without a towing-owned restriction during the observation window.",
    recoveryCapability: "start-towing",
    recoveryDurationRangeSeconds: { minSeconds: 7_200, nominalSeconds: 10_800, maxSeconds: 14_400 },
    maintenanceDispatch: {
      role: "rolling-stock rescue coordinator",
      instruction: "Dispatch the compatible rescue and rolling-stock maintenance resources to the protected train, recording access constraints and a 10–60 minute mobilisation estimate.",
      durationRangeSeconds: { minSeconds: 600, nominalSeconds: 1_800, maxSeconds: 3_600 },
    },
    observationWindowSeconds: 60,
  },
] as const;

function buildProcedure(spec: ProcedureSpec): OperationalProcedure {
  const revision = spec.revision ?? "1.0";
  const procedure: ProcedureDraft = {
    schemaVersion: "paris-icc.operational-procedure.v1",
    procedureId: spec.procedureId,
    revision,
    title: spec.title,
    summary: spec.summary,
    effectiveFrom: EFFECTIVE_FROM,
    validUntil: null,
    source: Object.freeze({
      kind: "demo-authored",
      official: false,
      issuer: "Hackinvent / Paris ICC demo",
      documentReference: `${spec.procedureId}/${revision}`,
      authoredOn: "2026-08-29",
      notice: DEMO_NOTICE,
    }),
    applicability: Object.freeze({
      incidentCodes: Object.freeze([...spec.incidentCodes]),
      targetTypes: Object.freeze([spec.targetType]),
      effects: Object.freeze([...spec.effects]),
    }),
    steps: buildSteps(spec),
    returnToNormal: Object.freeze({
      objective: spec.normalObjective,
      observationWindowSeconds: spec.observationWindowSeconds ?? 30,
      criteria: returnCriteria(spec),
      operatorSignoffRequired: true,
    }),
  };
  return Object.freeze({ ...procedure, contentHash: procedureContentHash(procedure) });
}

export const OPERATIONAL_PROCEDURE_CATALOGUE: readonly OperationalProcedure[] =
  Object.freeze(SPECS.map(buildProcedure));

const catalogueFingerprint = OPERATIONAL_PROCEDURE_CATALOGUE
  .map(({ procedureId, revision, contentHash }) => ({ procedureId, revision, contentHash }))
  .sort((left, right) =>
    left.procedureId.localeCompare(right.procedureId) || left.revision.localeCompare(right.revision)
  );

export const OPERATIONAL_PROCEDURE_CATALOGUE_METADATA: OperationalProcedureCatalogueMetadata =
  Object.freeze({
    schemaVersion: "paris-icc.procedure-catalogue.v1",
    catalogueId: "paris-icc-operational-procedures",
    revision: PROCEDURE_CATALOG_REVISION,
    sourceKind: "demo-authored",
    official: false,
    notice: DEMO_NOTICE,
    procedureCount: OPERATIONAL_PROCEDURE_CATALOGUE.length,
    hashAlgorithm: "sha256",
    contentHash: canonicalSha256(catalogueFingerprint),
  });

export const PROCEDURE_CATALOGUE_METADATA = OPERATIONAL_PROCEDURE_CATALOGUE_METADATA;
export const DEMO_OPERATIONAL_PROCEDURES = OPERATIONAL_PROCEDURE_CATALOGUE;
