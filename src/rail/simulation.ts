import type {
  CircuitClosureReason,
  CircuitClosureRejectionReason,
  CircuitClosureResult,
  Direction,
  Incident,
  IncidentEffect,
  IncidentStatus,
  IncidentTarget,
  NewIncidentInput,
  PowerSection,
  RailEvent,
  RailSnapshot,
  SimulationState,
  TrainView,
} from "./domain";
import type { SimulatorIncidentDraft } from "./simulatorIncident";
import { classifyIncidentCode } from "../procedures";
import { createInitialSnapshot } from "./scenario";
import { emptyCircuitViews, routeFor } from "./topology";

export const STEP_MS = 1_000;
const STEP_SECONDS = STEP_MS / 1_000;
export const STATION_DWELL_MS = 20_000;
const DWELL_TICKS = Math.ceil(STATION_DWELL_MS / STEP_MS);
const REGULATION_HOLD_MS = 36_000;
const REGULATION_HOLD_TICKS = Math.ceil(REGULATION_HOLD_MS / STEP_MS);
const STOP_MARGIN_METERS = 25;

export const MAX_CIRCUIT_CLOSURE_NOTE_LENGTH = 180;
export const MAX_CIRCUIT_CLOSURE_REFERENCE_LENGTH = 64;

type PowerIncidentEffect = "degrade-power" | "isolate-power";

export type DetailedIncidentWithOptionalCode =
  Omit<Incident, "incidentCode"> & { incidentCode?: string };

function targetTypeForEffect(effect: IncidentEffect): IncidentTarget["type"] {
  if (effect === "stop-train") return "train";
  if (effect === "station-closure" || effect === "station-dwell") return "station";
  if (effect === "degrade-power" || effect === "isolate-power") return "power";
  return "interstation";
}

function defaultTargetTypeForIncident(
  type: Incident["type"],
): IncidentTarget["type"] {
  if (type === "rolling-stock" || type === "staff") return "train";
  if (type === "passenger") return "station";
  if (type === "power") return "power";
  return "interstation";
}

function defaultEffectForTarget(
  targetType: IncidentTarget["type"],
): IncidentEffect {
  if (targetType === "train") return "stop-train";
  if (targetType === "station") return "station-closure";
  if (targetType === "power") return "degrade-power";
  return "block-interstation";
}

function detailedIncidentClassification(
  incident: Pick<Incident, "type" | "target" | "effect">,
): {
  targetType: IncidentTarget["type"];
  effect: IncidentEffect;
} {
  const targetType = incident.target?.type ??
    (incident.effect
      ? targetTypeForEffect(incident.effect)
      : defaultTargetTypeForIncident(incident.type));
  return {
    targetType,
    effect: incident.effect ?? defaultEffectForTarget(targetType),
  };
}

/**
 * Upgrade imported detailed incidents without mutating the parsed configuration.
 * Existing codes are preserved; legacy records are classified from structured
 * target/effect metadata or conservative type defaults.
 */
export function normalizeDetailedIncidentCode(
  incident: DetailedIncidentWithOptionalCode,
): Incident {
  const existing = incident.incidentCode?.trim();
  if (existing) return { ...incident, incidentCode: existing };
  const classification = detailedIncidentClassification(incident);
  return {
    ...incident,
    incidentCode: classifyIncidentCode({
      type: incident.type,
      targetType: classification.targetType,
      effect: classification.effect,
    }),
  };
}


function isPowerIncidentEffect(effect: string | undefined): effect is PowerIncidentEffect {
  return effect === "degrade-power" || effect === "isolate-power";
}

function boundedIncidentText(value: string, fallback: string, maxLength: number): string {
  const normalized = value.trim();
  return (normalized || fallback).slice(0, maxLength);
}

function powerSectionWithEffect(
  section: PowerSection,
  effect: PowerIncidentEffect,
  activatedAt: number,
): PowerSection {
  if (section.status === "isolated" && effect === "degrade-power") {
    return section;
  }
  const isolated = effect === "isolate-power";
  return {
    ...section,
    status: isolated ? "isolated" : "degraded",
    voltage: isolated ? 0 : Math.round(section.nominalVoltage * 0.89),
    currentAmps: isolated ? 0 : Math.max(1, Math.round(section.currentAmps * 0.92)),
    loadPercent: isolated ? 0 : Math.max(section.loadPercent, 82),
    updatedAt: activatedAt,
  };
}

function impactedTrainsForPowerSection(
  snapshot: RailSnapshot,
  section: PowerSection,
): string[] {
  const circuitIds = new Set(section.circuitIds);
  return snapshot.trains
    .filter((train) => circuitIds.has(train.circuitId))
    .map((train) => train.id)
    .sort((left, right) => left.localeCompare(right));
}

function nextPowerIncidentId(snapshot: RailSnapshot): string {
  let sequence = 1;
  while (
    snapshot.incidents.some(
      (incident) =>
        incident.id === "INC-SIM-PWR-" + String(sequence).padStart(3, "0"),
    )
  ) {
    sequence += 1;
  }
  return "INC-SIM-PWR-" + String(sequence).padStart(3, "0");
}

function validatePowerIncidentDraft(
  snapshot: RailSnapshot,
  draft: SimulatorIncidentDraft,
): { section: PowerSection; targetId: string; effect: PowerIncidentEffect; type: Incident["type"] } {
  if (snapshot.source !== "simulation") {
    throw new Error("Incidents can only be scheduled in the local simulation.");
  }
  if (draft.targetType !== "power") {
    throw new Error("The detailed simulator only accepts power-section incidents.");
  }
  const targetId = draft.targetId.trim();
  const section = snapshot.powerSections.find((candidate) => candidate.id === targetId);
  if (!section) throw new Error("Unknown power section: " + (targetId || "(empty)") + ".");
  if (!section.lineIds.some((lineId) => lineId === draft.lineCode)) {
    throw new Error(
      "Power section " + targetId + " does not belong to line " + draft.lineCode + ".",
    );
  }
  if (!isPowerIncidentEffect(draft.effect)) {
    throw new Error("Power incidents require either degrade-power or isolate-power.");
  }
  if (draft.type === "communications" || draft.type === "security") {
    throw new Error("A detailed power incident requires a power-compatible incident type.");
  }
  if (!Number.isFinite(draft.occurrenceTime)) {
    throw new Error("Incident occurrence time must be a finite simulation timestamp.");
  }
  return { section, targetId, effect: draft.effect, type: draft.type };
}

function activateDuePowerIncidents(
  snapshot: RailSnapshot,
  nextTimestamp: number,
): RailSnapshot {
  const due = snapshot.incidents.filter(
    (incident) =>
      incident.status === "planned" &&
      incident.target?.type === "power" &&
      isPowerIncidentEffect(incident.effect) &&
      Number.isFinite(incident.startedAt) &&
      incident.startedAt <= nextTimestamp &&
      snapshot.powerSections.some((section) => section.id === incident.target?.id),
  );
  if (due.length === 0) return snapshot;

  const dueIds = new Set(due.map((incident) => incident.id));
  const strongestEffectBySection = new Map<string, PowerIncidentEffect>();
  for (const incident of due) {
    const sectionId = incident.target?.id;
    if (!sectionId || !isPowerIncidentEffect(incident.effect)) continue;
    const existing = strongestEffectBySection.get(sectionId);
    if (existing !== "isolate-power") {
      strongestEffectBySection.set(sectionId, incident.effect);
    }
  }
  const powerSections = snapshot.powerSections.map((section) => {
    const effect = strongestEffectBySection.get(section.id);
    return effect ? powerSectionWithEffect(section, effect, nextTimestamp) : section;
  });
  const incidents = snapshot.incidents.map((incident) => {
    if (!dueIds.has(incident.id) || !incident.target || !isPowerIncidentEffect(incident.effect)) {
      return incident;
    }
    const section = snapshot.powerSections.find(
      (candidate) => candidate.id === incident.target?.id,
    );
    if (!section) return incident;
    return {
      ...incident,
      status: "active" as const,
      activatedAt: nextTimestamp,
      blockedCircuitIds:
        incident.effect === "isolate-power" ? [...section.circuitIds] : [],
      impactedTrainIds: impactedTrainsForPowerSection(snapshot, section),
    };
  });
  const activationEvents = due.map((incident, index) =>
    event(
      snapshot,
      "power",
      incident.id + " activated",
      incident.location +
        " / " +
        incident.effect?.replaceAll("-", " ") +
        " / simulation only",
      incident.severity,
      nextTimestamp,
      index,
    ),
  );

  return {
    ...snapshot,
    decisionRevision: snapshot.decisionRevision + 1,
    incidents,
    powerSections,
    events: [...activationEvents, ...snapshot.events].slice(0, 16),
  };
}

export function createSimulationState(): SimulationState {
  return { snapshot: createInitialSnapshot(), speed: 1 };
}

function reverseDirection(direction: Direction): Direction {
  return direction === 1 ? -1 : 1;
}

function blockedCircuitIds(snapshot: RailSnapshot): Set<string> {
  return new Set(
    snapshot.incidents
      .filter((incident) => incident.status === "active" || incident.status === "acknowledged")
      .flatMap((incident) => incident.blockedCircuitIds),
  );
}

function manuallyClosedCircuitIds(snapshot: RailSnapshot): Set<string> {
  return new Set(
    snapshot.circuits
      .filter((circuit) => circuit.closure !== null)
      .map((circuit) => circuit.id),
  );
}

function isolatedCircuitIds(snapshot: RailSnapshot): Set<string> {
  return new Set(
    snapshot.powerSections
      .filter((section) => section.status === "isolated")
      .flatMap((section) => section.circuitIds),
  );
}

function stepTrain(
  train: TrainView,
  snapshot: RailSnapshot,
  occupiedAtStart: Set<string>,
  claimed: Set<string>,
): TrainView {
  const blocked = blockedCircuitIds(snapshot);
  const isolated = isolatedCircuitIds(snapshot);
  const manuallyClosed = manuallyClosedCircuitIds(snapshot);
  const route = routeFor(train.lineId, train.direction);
  const currentCircuit = route[train.routeIndex];

  if (!currentCircuit || currentCircuit.id !== train.circuitId) {
    throw new Error(`Route mismatch for ${train.id}`);
  }

  if (train.status === "dwelling" && train.holdTicks > 1) {
    claimed.add(train.circuitId);
    return {
      ...train,
      holdTicks: train.holdTicks - 1,
      speedKmh: 0,
      status: "dwelling",
    };
  }

  if (train.holdTicks > 1) {
    claimed.add(train.circuitId);
    return {
      ...train,
      holdTicks: train.holdTicks - 1,
      speedKmh: 0,
      status: "held",
      delaySeconds: train.delaySeconds + STEP_SECONDS,
    };
  }
  if (train.holdTicks === 1) train = { ...train, holdTicks: 0 };

  if (blocked.has(train.circuitId) || isolated.has(train.circuitId) || manuallyClosed.has(train.circuitId)) {
    claimed.add(train.circuitId);
    return {
      ...train,
      speedKmh: 0,
      status: "stopped",
      delaySeconds: train.delaySeconds + STEP_SECONDS,
    };
  }

  const lineBaseSpeedKmh = train.lineId.startsWith("RER") ? 74 : 52;
  const powerSection = snapshot.powerSections.find(
    (section) => section.id === currentCircuit.electricalSectionId,
  );
  const powerAdjustedSpeedKmh =
    powerSection?.status === "degraded" ? lineBaseSpeedKmh * 0.72 : lineBaseSpeedKmh;
  const targetSpeedKmh = Math.min(currentCircuit.speedLimitKmh, powerAdjustedSpeedKmh);
  const distanceMeters = (targetSpeedKmh / 3.6) * STEP_SECONDS;
  const nextProgress = train.progress + distanceMeters / currentCircuit.lengthMeters;

  if (nextProgress < 1) {
    claimed.add(train.circuitId);
    const recovery = train.status === "running" && train.delaySeconds > 0 ? 1 : 0;
    return {
      ...train,
      progress: nextProgress,
      speedKmh: Math.round(targetSpeedKmh),
      status: "running",
      delaySeconds: Math.max(0, train.delaySeconds - recovery),
    };
  }

  const atCorridorBoundary = train.routeIndex + 1 >= route.length;
  const nextDirection = atCorridorBoundary
    ? reverseDirection(train.direction)
    : train.direction;
  const nextRoute = atCorridorBoundary ? routeFor(train.lineId, nextDirection) : route;
  const nextRouteIndex = atCorridorBoundary ? 0 : train.routeIndex + 1;
  const nextCircuit = nextRoute[nextRouteIndex];

  // The supervised map is a condensed corridor. At either boundary the two
  // directional lanes share the same physical station, so the visual recurrence
  // uses a modelled turnaround instead of jumping across the absent outer branch.
  // Mission and real branch termini remain unchanged; direction follows the lane.
  if (nextCircuit && nextCircuit.fromStation !== currentCircuit.toStation) {
    throw new Error(
      `Discontinuous route transition for ${train.id}: ${currentCircuit.id} → ${nextCircuit.id}`,
    );
  }

  const cannotEnter =
    !nextCircuit ||
    occupiedAtStart.has(nextCircuit.id) ||
    claimed.has(nextCircuit.id) ||
    blocked.has(nextCircuit.id) ||
    isolated.has(nextCircuit.id) ||
    manuallyClosed.has(nextCircuit.id);

  if (cannotEnter) {
    const stopLineProgress = Math.max(
      train.progress,
      1 - STOP_MARGIN_METERS / currentCircuit.lengthMeters,
    );
    claimed.add(train.circuitId);
    return {
      ...train,
      progress: Math.min(0.999, stopLineProgress),
      speedKmh: 0,
      status: "held",
      delaySeconds: train.delaySeconds + STEP_SECONDS,
    };
  }

  const overshootMeters = Math.max(0, (nextProgress - 1) * currentCircuit.lengthMeters);
  claimed.add(nextCircuit.id);
  return {
    ...train,
    direction: nextDirection,
    routeIndex: nextRouteIndex,
    circuitId: nextCircuit.id,
    progress: Math.min(0.999, overshootMeters / nextCircuit.lengthMeters),
    speedKmh: 0,
    status: "dwelling",
    holdTicks: DWELL_TICKS,
    nextStop: nextCircuit.toStation,
  };
}

function rebuildCircuits(snapshot: RailSnapshot, trains: TrainView[]) {
  const occupied = new Map(trains.map((train) => [train.circuitId, train]));
  const blocked = blockedCircuitIds(snapshot);
  const isolated = isolatedCircuitIds(snapshot);
  const closures = new Map(
    snapshot.circuits.map((circuit) => [circuit.id, circuit.closure] as const),
  );

  return emptyCircuitViews().map((circuit) => {
    const train = occupied.get(circuit.id);
    const closure = closures.get(circuit.id) ?? null;
    const unavailable = closure !== null || blocked.has(circuit.id) || isolated.has(circuit.id);
    return {
      ...circuit,
      state: train ? "occupied" as const : unavailable ? "blocked" as const : "free" as const,
      occupiedBy: train?.id ?? null,
      circulationId: train?.circulationId ?? null,
      reservedBy: null,
      closure,
    };
  });
}

export function advanceSnapshot(snapshot: RailSnapshot): RailSnapshot {
  const nextTimestamp = snapshot.timestamp + STEP_MS;
  const operationalSnapshot = activateDuePowerIncidents(snapshot, nextTimestamp);
  const occupiedAtStart = new Set(
    operationalSnapshot.trains.map((train) => train.circuitId),
  );
  const claimed = new Set<string>();
  const trains = [...operationalSnapshot.trains]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((train) => stepTrain(train, operationalSnapshot, occupiedAtStart, claimed));

  const nextSnapshot = {
    ...operationalSnapshot,
    revision: snapshot.revision + 1,
    timestamp: nextTimestamp,
    trains,
  };

  return {
    ...nextSnapshot,
    circuits: rebuildCircuits(nextSnapshot, trains),
    powerSections: nextSnapshot.powerSections.map((section) => {
      if (section.status === "isolated") return { ...section, voltage: 0, currentAmps: 0, updatedAt: nextSnapshot.timestamp };
      const wave = Math.round(Math.sin(nextSnapshot.revision / 4 + section.loadPercent) * 7);
      return {
        ...section,
        currentAmps: Math.max(0, section.currentAmps + wave),
        loadPercent: Math.min(96, Math.max(38, section.loadPercent + Math.sign(wave))),
        updatedAt: nextSnapshot.timestamp,
      };
    }),
  };
}

export function advanceSimulation(state: SimulationState): SimulationState {
  if (state.speed === 0) return state;
  let snapshot = state.snapshot;
  for (let step = 0; step < state.speed; step += 1) snapshot = advanceSnapshot(snapshot);
  return { ...state, snapshot };
}

export function setSimulationSpeed(state: SimulationState, speed: SimulationState["speed"]): SimulationState {
  if (state.speed === speed) return state;
  return {
    ...state,
    speed,
    snapshot: {
      ...state.snapshot,
      decisionRevision: state.snapshot.decisionRevision + 1,
    },
  };
}

function event(
  snapshot: RailSnapshot,
  kind: RailEvent["kind"],
  title: string,
  detail: string,
  severity: RailEvent["severity"],
  timestamp = snapshot.timestamp,
  sequenceOffset = 0,
): RailEvent {
  return {
    id: `EVT-${snapshot.revision}-${snapshot.events.length + sequenceOffset + 1}`,
    timestamp,
    kind,
    title,
    detail,
    severity,
  };
}

function closureFailure(
  state: SimulationState,
  action: "close" | "reopen",
  circuitId: string,
  reason: CircuitClosureRejectionReason,
  message: string,
): CircuitClosureResult {
  return { ok: false, action, reason, circuitId, message, nextState: state };
}

function normalizeClosureField(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function closeCircuit(
  state: SimulationState,
  circuitId: string,
  reason: CircuitClosureReason,
  note?: string,
  reference?: string,
): CircuitClosureResult {
  if (state.snapshot.source !== "simulation") {
    return closureFailure(
      state,
      "close",
      circuitId,
      "live_forbidden",
      "CDV closures are available in the simulation only.",
    );
  }

  const circuit = state.snapshot.circuits.find((candidate) => candidate.id === circuitId);
  if (!circuit) {
    return closureFailure(state, "close", circuitId, "not_found", `Unknown CDV: ${circuitId}.`);
  }
  if (circuit.closure !== null) {
    return closureFailure(
      state,
      "close",
      circuitId,
      "already_closed",
      `${circuitId} already has a manual ${circuit.closure.reason} closure.`,
    );
  }

  const occupyingTrain =
    circuit.occupiedBy ??
    state.snapshot.trains.find((train) => train.circuitId === circuitId)?.id ??
    null;
  if (occupyingTrain !== null) {
    return closureFailure(
      state,
      "close",
      circuitId,
      "occupied",
      `${circuitId} is occupied by ${occupyingTrain}; the closure was not applied.`,
    );
  }
  if (circuit.state === "blocked" || circuit.state === "reserved" || circuit.reservedBy !== null) {
    return closureFailure(
      state,
      "close",
      circuitId,
      "blocked",
      `${circuitId} is already unavailable through an active incident, power isolation, or reservation.`,
    );
  }

  const normalizedNote = normalizeClosureField(note);
  if (normalizedNote !== null && normalizedNote.length > MAX_CIRCUIT_CLOSURE_NOTE_LENGTH) {
    return closureFailure(
      state,
      "close",
      circuitId,
      "invalid_note",
      `The closure note must not exceed ${MAX_CIRCUIT_CLOSURE_NOTE_LENGTH} characters.`,
    );
  }
  const normalizedReference = normalizeClosureField(reference);
  if (
    normalizedReference !== null &&
    normalizedReference.length > MAX_CIRCUIT_CLOSURE_REFERENCE_LENGTH
  ) {
    return closureFailure(
      state,
      "close",
      circuitId,
      "invalid_reference",
      `The closure reference must not exceed ${MAX_CIRCUIT_CLOSURE_REFERENCE_LENGTH} characters.`,
    );
  }

  const closure = {
    reason,
    note: normalizedNote,
    reference: normalizedReference,
    closedAt: state.snapshot.timestamp,
  };
  const detail = [
    reason === "works" ? "Engineering possession" : "Operational incident",
    normalizedReference === null ? null : `Reference ${normalizedReference}`,
    normalizedNote,
    "simulation only",
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const snapshotWithClosure: RailSnapshot = {
    ...state.snapshot,
    decisionRevision: state.snapshot.decisionRevision + 1,
    revision: state.snapshot.revision + 1,
    circuits: state.snapshot.circuits.map((candidate) =>
      candidate.id === circuitId ? { ...candidate, closure } : candidate,
    ),
    events: [
      event(
        state.snapshot,
        "circuit",
        `CDV ${circuitId} manually closed`,
        detail,
        reason === "incident" ? "high" : "medium",
      ),
      ...state.snapshot.events,
    ].slice(0, 16),
  };
  const updatedSnapshot: RailSnapshot = {
    ...snapshotWithClosure,
    circuits: rebuildCircuits(snapshotWithClosure, snapshotWithClosure.trains),
  };
  const nextState: SimulationState = { ...state, snapshot: updatedSnapshot };

  return {
    ok: true,
    action: "close",
    outcome: "closed",
    circuitId,
    message: `${circuitId} closed for ${reason} in the simulation.`,
    nextState,
  };
}

export function reopenCircuit(
  state: SimulationState,
  circuitId: string,
): CircuitClosureResult {
  if (state.snapshot.source !== "simulation") {
    return closureFailure(
      state,
      "reopen",
      circuitId,
      "live_forbidden",
      "CDV closures are available in the simulation only.",
    );
  }

  const circuit = state.snapshot.circuits.find((candidate) => candidate.id === circuitId);
  if (!circuit) {
    return closureFailure(state, "reopen", circuitId, "not_found", `Unknown CDV: ${circuitId}.`);
  }
  if (circuit.closure === null) {
    return closureFailure(
      state,
      "reopen",
      circuitId,
      "already_open",
      `${circuitId} has no manual closure to remove.`,
    );
  }

  const closure = circuit.closure;
  const remainsBlocked =
    blockedCircuitIds(state.snapshot).has(circuitId) ||
    isolatedCircuitIds(state.snapshot).has(circuitId);
  const snapshotWithoutClosure: RailSnapshot = {
    ...state.snapshot,
    decisionRevision: state.snapshot.decisionRevision + 1,
    revision: state.snapshot.revision + 1,
    circuits: state.snapshot.circuits.map((candidate) =>
      candidate.id === circuitId ? { ...candidate, closure: null } : candidate,
    ),
    events: [
      event(
        state.snapshot,
        "circuit",
        `CDV ${circuitId} manually reopened`,
        [
          `${closure.reason} closure removed`,
          closure.reference === null ? null : `Reference ${closure.reference}`,
          remainsBlocked ? "scenario constraint remains active" : "available for movement",
          "simulation only",
        ]
          .filter((part): part is string => part !== null)
          .join(" · "),
        remainsBlocked ? "medium" : "low",
      ),
      ...state.snapshot.events,
    ].slice(0, 16),
  };
  const updatedSnapshot: RailSnapshot = {
    ...snapshotWithoutClosure,
    circuits: rebuildCircuits(snapshotWithoutClosure, snapshotWithoutClosure.trains),
  };
  const nextState: SimulationState = { ...state, snapshot: updatedSnapshot };

  return {
    ok: true,
    action: "reopen",
    outcome: "reopened",
    circuitId,
    message: remainsBlocked
      ? `${circuitId} manual closure removed; a scenario constraint still blocks the CDV.`
      : `${circuitId} reopened in the simulation.`,
    nextState,
  };
}

export function updateIncidentStatus(
  state: SimulationState,
  incidentId: string,
  status: IncidentStatus,
): SimulationState {
  const incident = state.snapshot.incidents.find((candidate) => candidate.id === incidentId);
  if (!incident) return state;
  const updatedSnapshot = {
    ...state.snapshot,
    decisionRevision: state.snapshot.decisionRevision + 1,
    revision: state.snapshot.revision + 1,
    incidents: state.snapshot.incidents.map((candidate) =>
      candidate.id === incidentId ? { ...candidate, status } : candidate,
    ),
    events: [
      event(
        state.snapshot,
        "incident",
        `${incident.id} · ${status}`,
        incident.title,
        status === "resolved" ? "low" : incident.severity,
      ),
      ...state.snapshot.events,
    ].slice(0, 16),
  };
  return {
    ...state,
    snapshot: { ...updatedSnapshot, circuits: rebuildCircuits(updatedSnapshot, updatedSnapshot.trains) },
  };
}

export function setPowerStatus(
  state: SimulationState,
  sectionId: string,
  status: "energized" | "isolated",
): SimulationState {
  const section = state.snapshot.powerSections.find((candidate) => candidate.id === sectionId);
  if (!section) return state;
  const updatedSnapshot = {
    ...state.snapshot,
    decisionRevision: state.snapshot.decisionRevision + 1,
    revision: state.snapshot.revision + 1,
    powerSections: state.snapshot.powerSections.map((candidate) =>
      candidate.id === sectionId
        ? {
            ...candidate,
            status,
            voltage: status === "isolated" ? 0 : Math.round(candidate.nominalVoltage * 0.98),
            currentAmps: status === "isolated" ? 0 : 1080,
            updatedAt: state.snapshot.timestamp,
          }
        : candidate,
    ),
    events: [
      event(
        state.snapshot,
        "power",
        `Simulated ${status === "isolated" ? "isolation" : "restoration"}`,
        section.name,
        status === "isolated" ? "high" : "low",
      ),
      ...state.snapshot.events,
    ].slice(0, 16),
  };
  return {
    ...state,
    snapshot: { ...updatedSnapshot, circuits: rebuildCircuits(updatedSnapshot, updatedSnapshot.trains) },
  };
}

export function schedulePowerIncident(
  state: SimulationState,
  draft: SimulatorIncidentDraft,
): SimulationState {
  const { section, targetId, effect, type } = validatePowerIncidentDraft(
    state.snapshot,
    draft,
  );
  const occurrenceTime = Math.trunc(draft.occurrenceTime);
  const planned = occurrenceTime > state.snapshot.timestamp;
  const id = nextPowerIncidentId(state.snapshot);
  const impactedTrainIds = planned
    ? []
    : impactedTrainsForPowerSection(state.snapshot, section);
  const incident: Incident = {
    id,
    incidentCode: classifyIncidentCode({
      type,
      targetType: "power",
      effect,
    }),
    title: boundedIncidentText(
      draft.title,
      effect === "isolate-power"
        ? "Traction power isolation"
        : "Traction voltage degradation",
      160,
    ),
    type,
    severity: draft.severity,
    status: planned ? "planned" : "active",
    lineIds: [...section.lineIds],
    location: section.name,
    startedAt: occurrenceTime,
    blockedCircuitIds:
      effect === "isolate-power" ? [...section.circuitIds] : [],
    impactedTrainIds,
    owner: "Power duty manager",
    summary: boundedIncidentText(
      draft.summary,
      "Power incident submitted from the simulation control view.",
      500,
    ),
    actions: planned
      ? [
          "Activation queued on the simulation clock",
          "Power and traffic impacts will be applied at occurrence time",
        ]
      : effect === "isolate-power"
        ? [
            "Traction isolation applied",
            "Affected trains held by the simulation",
          ]
        : [
            "Degraded traction voltage applied",
            "Reduced-speed model enabled for the affected section",
          ],
    target: { type: "power", id: targetId },
    effect,
    ...(planned ? {} : { activatedAt: state.snapshot.timestamp }),
  };
  const powerSections = planned
    ? state.snapshot.powerSections
    : state.snapshot.powerSections.map((candidate) =>
        candidate.id === targetId
          ? powerSectionWithEffect(candidate, effect, state.snapshot.timestamp)
          : candidate,
      );
  const occurrenceIso = new Date(occurrenceTime).toISOString();
  const updatedSnapshot: RailSnapshot = {
    ...state.snapshot,
    decisionRevision: state.snapshot.decisionRevision + 1,
    revision: state.snapshot.revision + 1,
    incidents: [incident, ...state.snapshot.incidents],
    powerSections,
    events: [
      event(
        state.snapshot,
        "power",
        id + (planned ? " scheduled" : " activated"),
        section.name +
          " / " +
          effect.replaceAll("-", " ") +
          " / occurrence " +
          occurrenceIso +
          " / simulation only",
        draft.severity,
      ),
      ...state.snapshot.events,
    ].slice(0, 16),
  };
  return {
    ...state,
    snapshot: {
      ...updatedSnapshot,
      circuits: rebuildCircuits(updatedSnapshot, updatedSnapshot.trains),
    },
  };
}

export function applyRegulation(
  state: SimulationState,
  trainId: string,
  action: "priority" | "hold" | "turnback",
): SimulationState {
  const train = state.snapshot.trains.find((candidate) => candidate.id === trainId);
  if (!train) return state;

  if (action === "priority") {
    const currentCircuit = state.snapshot.circuits.find((candidate) => candidate.id === train.circuitId);
    const powerSection = currentCircuit
      ? state.snapshot.powerSections.find((candidate) => candidate.id === currentCircuit.electricalSectionId)
      : undefined;
    const rejectionReason = train.delaySeconds <= 0
      ? "no modelled delay remains to recover"
      : train.status === "held" || train.status === "stopped"
        ? `train is ${train.status}; resolve the blocking constraint first`
        : powerSection?.status === "isolated"
          ? `traction section ${powerSection.id} is isolated`
          : null;
    if (rejectionReason) {
      const updatedSnapshot: RailSnapshot = {
        ...state.snapshot,
        decisionRevision: state.snapshot.decisionRevision + 1,
        revision: state.snapshot.revision + 1,
        events: [
          event(
            state.snapshot,
            "regulation",
            "Action priority rejected",
            `${train.circulationId} · ${rejectionReason} · simulation only`,
            "medium",
          ),
          ...state.snapshot.events,
        ].slice(0, 16),
      };
      return { ...state, snapshot: updatedSnapshot };
    }
  }

  if (action === "turnback") {
    const currentRoute = routeFor(train.lineId, train.direction);
    const currentRouteCircuit = currentRoute[train.routeIndex];
    const atModelledTurnbackPoint =
      currentRouteCircuit?.id === train.circuitId &&
      train.routeIndex === currentRoute.length - 1 &&
      train.progress >= 0.9;

    if (!atModelledTurnbackPoint) {
      const updatedSnapshot: RailSnapshot = {
        ...state.snapshot,
        decisionRevision: state.snapshot.decisionRevision + 1,
        revision: state.snapshot.revision + 1,
        events: [
          event(
            state.snapshot,
            "regulation",
            "Action turnback rejected",
            `${train.circulationId} · not at a modelled turnback point · simulation only`,
            "medium",
          ),
          ...state.snapshot.events,
        ].slice(0, 16),
      };
      return { ...state, snapshot: updatedSnapshot };
    }

    const targetRoute = routeFor(train.lineId, reverseDirection(train.direction));
    const targetCircuit = targetRoute[0];
    const targetView = targetCircuit === undefined
      ? undefined
      : state.snapshot.circuits.find((circuit) => circuit.id === targetCircuit.id);
    const occupiedByOtherTrain =
      targetCircuit !== undefined &&
      state.snapshot.trains.some(
        (candidate) => candidate.id !== trainId && candidate.circuitId === targetCircuit.id,
      );
    if (
      targetCircuit === undefined ||
      targetView === undefined ||
      targetView.closure !== null ||
      targetView.state !== "free" ||
      occupiedByOtherTrain
    ) {
      const targetId = targetCircuit?.id ?? "unknown";
      const updatedSnapshot: RailSnapshot = {
        ...state.snapshot,
        decisionRevision: state.snapshot.decisionRevision + 1,
        revision: state.snapshot.revision + 1,
        events: [
          event(
            state.snapshot,
            "regulation",
            "Action turnback rejected",
            `${train.circulationId} · target CDV ${targetId} unavailable · simulation only`,
            "medium",
          ),
          ...state.snapshot.events,
        ].slice(0, 16),
      };
      return { ...state, snapshot: updatedSnapshot };
    }
  }
  const turnbackCirculationId = `TB-${train.circulationId}`.slice(0, 32);

  const trains = state.snapshot.trains.map((candidate) => {
    if (candidate.id !== trainId) return candidate;
    if (action === "priority") return { ...candidate, delaySeconds: Math.max(0, candidate.delaySeconds - 120) };
    if (action === "hold") return {
      ...candidate,
      holdTicks: REGULATION_HOLD_TICKS,
      speedKmh: 0,
      status: "held" as const,
    };
    const direction = reverseDirection(candidate.direction);
    const route = routeFor(candidate.lineId, direction);
    const sourceRoute = routeFor(candidate.lineId, candidate.direction);
    const sourceCircuit = sourceRoute[candidate.routeIndex];
    const distanceFromTurnbackMeters = Math.max(0, 1 - candidate.progress) * sourceCircuit.lengthMeters;
    const turnbackProgress = Math.min(
      0.1,
      distanceFromTurnbackMeters / route[0].lengthMeters,
    );
    return {
      ...candidate,
      circulationId: turnbackCirculationId,
      mission: "TURNBACK",
      origin: route[0].fromStation,
      destination: route.at(-1)?.toStation ?? route[0].toStation,
      direction,
      routeIndex: 0,
      circuitId: route[0].id,
      progress: turnbackProgress,
      speedKmh: 0,
      nextStop: route[0].toStation,
      status: "dwelling" as const,
      holdTicks: DWELL_TICKS,
    };
  });

  const updatedSnapshot = {
    ...state.snapshot,
    decisionRevision: state.snapshot.decisionRevision + 1,
    revision: state.snapshot.revision + 1,
    trains,
    events: [
      event(
        state.snapshot,
        "regulation",
        action === "turnback" ? "Simulated turnback applied" : `Action ${action} applied`,
        action === "turnback"
          ? `${train.circulationId} → ${turnbackCirculationId} · TURNBACK mission · simulation only`
          : `${train.circulationId} · simulation only`,
        action === "turnback" ? "medium" : "low",
      ),
      ...state.snapshot.events,
    ].slice(0, 16),
  };

  return {
    ...state,
    snapshot: { ...updatedSnapshot, circuits: rebuildCircuits(updatedSnapshot, trains) },
  };
}

export function resetSimulation(previousState?: SimulationState): SimulationState {
  const reset = createSimulationState();
  if (!previousState) return reset;
  return {
    ...reset,
    snapshot: {
      ...reset.snapshot,
      decisionRevision: previousState.snapshot.decisionRevision + 1,
    },
  };
}

export function addDemoIncident(
  state: SimulationState,
  input: NewIncidentInput = {
    type: "infrastructure",
    severity: "medium",
    lineId: "RER_A",
    location: "Auber — track 2",
    summary: "Report requires assessment. Field verification requested.",
  },
): SimulationState {
  let sequence = 1;
  while (state.snapshot.incidents.some((incident) => incident.id === `INC-OPS-${String(sequence).padStart(2, "0")}`)) {
    sequence += 1;
  }
  const id = `INC-OPS-${String(sequence).padStart(2, "0")}`;
  const location = input.location.trim().slice(0, 120) || "Location pending confirmation";
  const summary = input.summary.trim().slice(0, 500) || "Report requires assessment.";
  const typeLabel = input.type === "rolling-stock"
    ? "Rolling-stock"
    : `${input.type[0].toUpperCase()}${input.type.slice(1)}`;
  const classification = detailedIncidentClassification({
    type: input.type,
    target: undefined,
    effect: undefined,
  });
  const incident: Incident = {
    id,
    incidentCode: classifyIncidentCode({
      type: input.type,
      targetType: classification.targetType,
      effect: classification.effect,
    }),
    title: `${typeLabel} report pending assessment`,
    type: input.type,
    severity: input.severity,
    status: "active" as const,
    lineIds: [input.lineId],
    location,
    startedAt: state.snapshot.timestamp,
    blockedCircuitIds: [],
    impactedTrainIds: [],
    owner: `${input.lineId.replace("_", " ")} traffic controller`,
    summary,
    actions: ["Operations log opened", "On-site inspection requested"],
    target: { type: classification.targetType, id: location },
    effect: classification.effect,
  };
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      decisionRevision: state.snapshot.decisionRevision + 1,
      revision: state.snapshot.revision + 1,
      incidents: [incident, ...state.snapshot.incidents],
      events: [
        event(state.snapshot, "incident", `${id} reported`, incident.location, input.severity),
        ...state.snapshot.events,
      ].slice(0, 16),
    },
  };
}

export function assertSnapshotInvariants(snapshot: RailSnapshot): void {
  if (!Number.isInteger(snapshot.decisionRevision) || snapshot.decisionRevision < 1) {
    throw new Error(`Invalid decision revision: ${snapshot.decisionRevision}`);
  }
  for (const incident of snapshot.incidents) {
    if (typeof incident.incidentCode !== "string" || !incident.incidentCode.trim()) {
      throw new Error(`Missing incident code for ${incident.id}`);
    }
  }
  const occupancy = new Set<string>();
  for (const train of snapshot.trains) {
    if (occupancy.has(train.circuitId)) throw new Error(`Duplicate occupation: ${train.circuitId}`);
    occupancy.add(train.circuitId);
    if (!Number.isFinite(train.progress) || train.progress < 0 || train.progress > 1)
      throw new Error(`Invalid progress for ${train.id}`);
    const circuit = snapshot.circuits.find((candidate) => candidate.id === train.circuitId);
    if (!circuit) throw new Error(`Missing circuit for ${train.id}`);
    const routeCircuit = routeFor(train.lineId, train.direction)[train.routeIndex];
    if (routeCircuit?.id !== train.circuitId) throw new Error(`Route mismatch for ${train.id}`);
    if (!Number.isFinite(train.speedKmh) || train.speedKmh < 0 || train.speedKmh > circuit.speedLimitKmh)
      throw new Error(`Invalid speed for ${train.id} on ${train.circuitId}`);
    if (train.status === "dwelling" && train.speedKmh !== 0)
      throw new Error(`Dwelling train ${train.id} must have zero speed`);
    if (circuit.closure !== null)
      throw new Error(`Train ${train.id} occupies manually closed CDV ${train.circuitId}`);
    if (circuit.occupiedBy !== train.id) throw new Error(`Missing occupation for ${train.id}`);
  }
}
