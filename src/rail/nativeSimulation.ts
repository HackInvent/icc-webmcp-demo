import {
  NATIVE_INTERSTATIONS,
  NATIVE_INTERSTATION_BY_ID,
  NATIVE_LINE_BY_CODE,
  NATIVE_LINE_COMPONENTS,
  NATIVE_LINES,
  NATIVE_STATION_BY_CODE,
  getNativeNeighbors,
  type NativeInterstation,
  type NativeLine,
  type NativeLineCode,
} from "./nativeNetwork";
import { classifyIncidentCode, UNKNOWN_INCIDENT_CODE } from "../procedures";
import {
  accumulateNativeStationPassengers,
  createNativeStationPassengerStates,
  nativeStationPassengerId,
  type NativeStationPassengerState,
} from "./passengerDemand";
import { getReferenceCapacity } from "./rollingStock";

export type { NativeStationPassengerState } from "./passengerDemand";

export const NATIVE_SIMULATION_STEP_MS = 1_000;
export const NATIVE_STATION_DWELL_MS = 20_000;
export const NATIVE_DEFAULT_TIMESTAMP = Date.UTC(2026, 7, 28, 6, 30, 0);

const NATIVE_STATION_DWELL_TICKS = Math.ceil(
  NATIVE_STATION_DWELL_MS / NATIVE_SIMULATION_STEP_MS,
);

export type NativeSimulationSpeed = 0 | 1 | 2 | 4;
export type NativeTrainStatus = "running" | "dwelling" | "held" | "stopped";
export type NativeTrainOperationalLocation =
  | Readonly<{ type: "station"; id: string }>
  | Readonly<{ type: "interstation"; id: string }>;
export type NativeIncidentSeverity = "low" | "medium" | "high" | "critical";
export type NativeIncidentType =
  | "infrastructure"
  | "passenger"
  | "rolling-stock"
  | "power"
  | "works"
  | "external"
  | "communications"
  | "security";
export type NativeIncidentStatus = "planned" | "active" | "resolved";
export type NativeRestrictionMode = "blocked" | "reduced-speed" | "none";
export type NativeIncidentTarget = Readonly<{
  type: "train" | "station" | "interstation" | "line";
  id: string;
}>;
export type NativeIncidentEffect =
  | "stop-train"
  | "station-closure"
  | "station-dwell"
  | "block-interstation"
  | "reduce-speed"
  | "communication-degraded"
  | "communication-loss"
  | "abandoned-baggage"
  | "tow-train";
export type NativeScenarioId =
  | "nominal"
  | "m13-works"
  | "rer-a-signal"
  | "m14-power"
  | "multi-event";

export interface NativeTrainState {
  id: string;
  circulationId: string;
  lineCode: NativeLineCode;
  mission: string;
  originStationCode: string;
  destinationStationCode: string;
  routeInterstationIds: readonly string[];
  routeIndex: number;
  direction: 1 | -1;
  currentInterstationId: string;
  fromStationCode: string;
  toStationCode: string;
  nextStationCode: string;
  location: NativeTrainOperationalLocation;
  progress: number;
  speedKmh: number;
  delaySeconds: number;
  status: NativeTrainStatus;
  dwellTicks: number;
  passengers: number;
  quality: "simulated";
}

export interface NativeIncident {
  id: string;
  incidentCode: string;
  title: string;
  summary: string;
  type: NativeIncidentType;
  severity: NativeIncidentSeverity;
  status: NativeIncidentStatus;
  target: NativeIncidentTarget;
  effect: NativeIncidentEffect;
  lineCode: NativeLineCode;
  location: string;
  affectedStationCodes: readonly string[];
  affectedInterstationIds: readonly string[];
  restrictionMode: NativeRestrictionMode;
  speedLimitKmh: number | null;
  startedAt: number;
  activatedAt: number | null;
  impactedTrainIds: readonly string[];
  responseStrategy: NativeResponseAction | null;
  owner: string;
}

export interface NativeRestriction {
  id: string;
  incidentId: string;
  lineCode: NativeLineCode;
  interstationId: string;
  mode: Exclude<NativeRestrictionMode, "none">;
  speedLimitKmh: number | null;
  active: true;
}

export interface NativeNetworkMetrics {
  fleetSize: number;
  activeIncidentCount: number;
  blockedInterstationCount: number;
  reducedSpeedInterstationCount: number;
  delayedTrainCount: number;
  heldTrainCount: number;
  averageDelaySeconds: number;
  maxDelaySeconds: number;
  networkPunctualityPercent: number;
}

export type NativeResponseAction = "protect-and-hold" | "degraded-operation" | "resolve-simulation";

export interface NativeResponseOption {
  id: string;
  action: NativeResponseAction;
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  estimatedCapacityPercent: number;
  estimatedDelayDeltaSeconds: number;
  constraints: readonly string[];
}

export interface NativeResponseEvaluation {
  id: string;
  incidentId: string;
  incidentTitle: string;
  decisionRevision: number;
  telemetryRevision: number;
  evaluatedAt: number;
  recommendedOptionId: string;
  options: readonly NativeResponseOption[];
  evidence: {
    lineCode: NativeLineCode;
    affectedInterstationIds: readonly string[];
    restrictionMode: NativeRestrictionMode;
    impactedTrainIds: readonly string[];
    upstreamHeldTrainIds: readonly string[];
    maxLineDelaySeconds: number;
  };
}

export interface NativeAppliedDecision {
  receiptId: string;
  evaluationId: string;
  incidentId: string;
  optionId: string;
  action: NativeResponseAction;
  appliedAt: number;
  decisionRevision: number;
  summary: string;
}

export interface NativeSimulationSnapshot {
  telemetryRevision: number;
  decisionRevision: number;
  timestamp: number;
  speed: NativeSimulationSpeed;
  scenarioId: NativeScenarioId;
  scenarioName: string;
  trains: readonly NativeTrainState[];
  stationPassengers: readonly NativeStationPassengerState[];
  incidents: readonly NativeIncident[];
  restrictions: readonly NativeRestriction[];
  metrics: NativeNetworkMetrics;
  lastDecision: NativeAppliedDecision | null;
}

export interface NativeSimulationConfigurationState {
  timestamp: number;
  speed: NativeSimulationSpeed;
  scenarioId: NativeScenarioId;
  scenarioName: string;
  trains: readonly NativeTrainState[];
  stationPassengers?: readonly NativeStationPassengerState[];
  incidents: readonly NativeIncident[];
}

export interface NativeIncidentInput {
  lineCode: NativeLineCode;
  incidentCode?: string;
  interstationId?: string;
  target?: NativeIncidentTarget;
  effect?: NativeIncidentEffect;
  occurrenceTime?: number;
  title: string;
  summary: string;
  type: NativeIncidentType;
  severity: NativeIncidentSeverity;
  restrictionMode?: Exclude<NativeRestrictionMode, "none">;
  speedLimitKmh?: number;
  owner?: string;
}

export interface NativeTrainInsertionInput {
  lineCode: NativeLineCode;
  stationId: string;
  direction?: 1 | -1;
}

export interface NativeTrainInsertionOption {
  stationId: string;
  destinationStationId: string;
  direction: 1 | -1;
  capacityDeltaPassengers: number;
}

export interface NativeTrainInsertionReceipt {
  train: NativeTrainState;
  stationId: string;
  direction: 1 | -1;
  capacityDeltaPassengers: number;
  decisionRevision: number;
}

export interface NativeScenarioDefinition {
  id: NativeScenarioId;
  name: string;
  description: string;
  incidentSeeds: readonly NativeIncidentInput[];
}

export interface NativeNetworkControllerOptions {
  scenarioId?: NativeScenarioId;
  speed?: NativeSimulationSpeed;
  startTimestamp?: number;
  /** Exact persisted operational state restored by the server runtime. */
  restoredSnapshot?: NativeSimulationSnapshot;
  /** Persisted reset point associated with restoredSnapshot. */
  baselineSnapshot?: NativeSimulationSnapshot;
}

export type NativeApplyBlockReason =
  | "unknown_evaluation"
  | "stale_decision"
  | "unknown_option"
  | "incident_not_active";

export type NativeApplyReviewedResult =
  | {
      ok: true;
      status: "applied";
      evaluationId: string;
      optionId: string;
      decisionRevision: number;
      receipt: NativeAppliedDecision;
      snapshot: NativeSimulationSnapshot;
    }
  | {
      ok: false;
      status: "blocked";
      reason: NativeApplyBlockReason;
      message: string;
      evaluationId: string;
      optionId: string;
      expectedDecisionRevision: number;
      currentDecisionRevision: number;
    };

export interface NativeNetworkController {
  getSnapshot: () => NativeSimulationSnapshot;
  subscribe: (listener: () => void) => () => void;
  tick: () => NativeSimulationSnapshot;
  reset: () => NativeSimulationSnapshot;
  setSpeed: (speed: NativeSimulationSpeed) => NativeSimulationSnapshot;
  activateScenario: (scenarioId: NativeScenarioId) => NativeSimulationSnapshot;
  loadConfiguration: (configuration: NativeSimulationConfigurationState) => NativeSimulationSnapshot;
  createIncident: (input: NativeIncidentInput) => NativeIncident;
  insertTrain: (input: NativeTrainInsertionInput) => NativeTrainInsertionReceipt;
  evaluateResponse: (input: { incidentId: string }) => NativeResponseEvaluation;
  applyReviewedOption: (input: {
    evaluationId: string;
    optionId: string;
    expectedDecisionRevision: number;
  }) => NativeApplyReviewedResult;
}

export class NativeSimulationError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_SCENARIO"
      | "UNKNOWN_LINE"
      | "UNKNOWN_INTERSTATION"
      | "LINE_MISMATCH"
      | "INVALID_INPUT"
      | "UNKNOWN_INCIDENT",
    message: string,
  ) {
    super(message);
    this.name = "NativeSimulationError";
  }
}

interface RouteEdge {
  interstationId: string;
  fromStationCode: string;
  toStationCode: string;
}

interface ScenarioSeed extends NativeIncidentInput {
  id: string;
}

const M13_WORKS_EDGE = "interstation-M13-71435--71474";
const RER_A_SIGNAL_EDGE = "interstation-RER_A-474151--478926";
const M14_POWER_EDGE = "interstation-M14-71264--73626";

const M13_WORKS_SEEDS: readonly ScenarioSeed[] = [
    {
      id: "INC-M13-WORKS",
      lineCode: "M13",
      interstationId: M13_WORKS_EDGE,
      title: "Engineering possession intruding into the operating window",
      summary: "A late worksite handback blocks the Place de Clichy–La Fourche interstation.",
      type: "works",
      severity: "high",
      restrictionMode: "blocked",
      owner: "Infrastructure control",
    },
];
const RER_A_SIGNAL_SEEDS: readonly ScenarioSeed[] = [
    {
      id: "INC-RERA-SIGNAL",
      lineCode: "RER_A",
      interstationId: RER_A_SIGNAL_EDGE,
      title: "Loss of train detection on the central trunk",
      summary: "Auber–Châtelet - Les Halles is protected while signalling diagnostics run.",
      type: "infrastructure",
      severity: "critical",
      restrictionMode: "blocked",
      owner: "RER A regulation",
    },
];
const M14_POWER_SEEDS: readonly ScenarioSeed[] = [
    {
      id: "INC-M14-POWER",
      lineCode: "M14",
      interstationId: M14_POWER_EDGE,
      title: "Traction power instability in the central section",
      summary: "Voltage instability affects Châtelet–Gare de Lyon and requires protected operation.",
      type: "power",
      severity: "high",
      restrictionMode: "blocked",
      owner: "Power control",
    },
];

const SCENARIO_SEEDS: Readonly<Record<Exclude<NativeScenarioId, "nominal">, readonly ScenarioSeed[]>> = {
  "m13-works": M13_WORKS_SEEDS,
  "rer-a-signal": RER_A_SIGNAL_SEEDS,
  "m14-power": M14_POWER_SEEDS,
  "multi-event": [...M13_WORKS_SEEDS, ...RER_A_SIGNAL_SEEDS, ...M14_POWER_SEEDS],
};

export const NATIVE_SCENARIOS: readonly NativeScenarioDefinition[] = Object.freeze([
  {
    id: "nominal",
    name: "Nominal network",
    description: "All 21 native schematic lines operate without an active restriction.",
    incidentSeeds: [],
  },
  {
    id: "m13-works",
    name: "M13 late worksite handback",
    description: "Protect Place de Clichy–La Fourche and evaluate degraded recovery options.",
    incidentSeeds: SCENARIO_SEEDS["m13-works"],
  },
  {
    id: "rer-a-signal",
    name: "RER A central-trunk detection failure",
    description: "Contain a critical Auber–Châtelet detection failure without entering the protected section.",
    incidentSeeds: SCENARIO_SEEDS["rer-a-signal"],
  },
  {
    id: "m14-power",
    name: "M14 traction power instability",
    description: "Protect Châtelet–Gare de Lyon while power control assesses degraded operation.",
    incidentSeeds: SCENARIO_SEEDS["m14-power"],
  },
  {
    id: "multi-event",
    name: "Paris morning multi-event",
    description: "Three concurrent infrastructure constraints demonstrate network-wide decision support.",
    incidentSeeds: SCENARIO_SEEDS["multi-event"],
  },
]);

const SCENARIO_BY_ID = new Map(NATIVE_SCENARIOS.map((scenario) => [scenario.id, scenario]));

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Native simulation invariant failed: ${message}`);
}

function stationName(stationCode: string): string {
  return NATIVE_STATION_BY_CODE.get(stationCode)?.name ?? stationCode;
}

function edgeLocation(edge: NativeInterstation): string {
  return `${stationName(edge.fromStationCode)} — ${stationName(edge.toStationCode)}`;
}

function shortestPath(
  lineCode: NativeLineCode,
  allowedStations: ReadonlySet<string>,
  start: string,
  destination: string,
): string[] | null {
  const previous = new Map<string, string | null>([[start, null]]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    if (current === destination) break;
    for (const neighbor of getNativeNeighbors(lineCode, current)) {
      if (!allowedStations.has(neighbor.neighborStationCode) || previous.has(neighbor.neighborStationCode)) {
        continue;
      }
      previous.set(neighbor.neighborStationCode, current);
      pending.push(neighbor.neighborStationCode);
    }
  }
  if (!previous.has(destination)) return null;
  const result: string[] = [];
  let cursor: string | null = destination;
  while (cursor !== null) {
    result.push(cursor);
    cursor = previous.get(cursor) ?? null;
  }
  return result.reverse();
}

function longestComponentPath(line: NativeLine): RouteEdge[] {
  const component = NATIVE_LINE_COMPONENTS.get(line.code)?.find(
    (candidate) => candidate.interstationIds.length > 0,
  );
  invariant(component, `${line.code} has no connected rendered component`);
  const allowed = new Set(component.stationCodes);
  const endpointCandidates = component.stationCodes.filter(
    (stationCode) => getNativeNeighbors(line.code, stationCode).filter(
      (entry) => allowed.has(entry.neighborStationCode),
    ).length <= 1,
  );
  const candidates = endpointCandidates.length >= 2 ? endpointCandidates : component.stationCodes;
  let bestPath: string[] | null = null;
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const path = shortestPath(line.code, allowed, candidates[leftIndex], candidates[rightIndex]);
      if (
        path &&
        (!bestPath || path.length > bestPath.length ||
          (path.length === bestPath.length && path.join("|").localeCompare(bestPath.join("|")) < 0))
      ) {
        bestPath = path;
      }
    }
  }
  invariant(bestPath && bestPath.length >= 2, `${line.code} cannot produce a deterministic route`);
  return bestPath.slice(0, -1).map((fromStationCode, index) => {
    const toStationCode = bestPath[index + 1];
    const adjacency = getNativeNeighbors(line.code, fromStationCode).find(
      (entry) => entry.neighborStationCode === toStationCode,
    );
    invariant(adjacency, `${line.code} route is missing ${fromStationCode}–${toStationCode}`);
    return { interstationId: adjacency.interstationId, fromStationCode, toStationCode };
  });
}

const ROUTES_BY_LINE: ReadonlyMap<NativeLineCode, readonly RouteEdge[]> = new Map(
  NATIVE_LINES.map((line) => [line.code, Object.freeze(longestComponentPath(line))]),
);

interface NativeTrainInsertionCandidate extends NativeTrainInsertionOption {
  routeIndex: number;
}

function trainInsertionCandidates(lineCode: NativeLineCode): readonly NativeTrainInsertionCandidate[] {
  const route = ROUTES_BY_LINE.get(lineCode);
  const line = NATIVE_LINE_BY_CODE.get(lineCode);
  if (!route || route.length === 0 || !line) return Object.freeze([]);
  const firstStationId = route[0].fromStationCode;
  const lastStationId = route.at(-1)!.toStationCode;
  const capacityDeltaPassengers = line.mode === "rer" ? 1_600 : 700;
  const candidates = route.flatMap((edge, routeIndex) => [
    {
      stationId: edge.fromStationCode,
      destinationStationId: lastStationId,
      direction: 1 as const,
      capacityDeltaPassengers,
      routeIndex,
    },
    {
      stationId: edge.toStationCode,
      destinationStationId: firstStationId,
      direction: -1 as const,
      capacityDeltaPassengers,
      routeIndex,
    },
  ]);
  return Object.freeze(candidates
    .filter((candidate, index) => candidates.findIndex((other) =>
      other.stationId === candidate.stationId && other.direction === candidate.direction
    ) === index)
    .sort((left, right) =>
      left.stationId.localeCompare(right.stationId) || right.direction - left.direction
    )
    .map((candidate) => Object.freeze(candidate)));
}

/**
 * Eligible manual operator insertion points on the deterministic main route.
 * This is deliberately broader than the terminal-only agent proposal surface:
 * an interior station exposes one option in each connected direction.
 */
export function nativeOperatorTrainInsertionOptions(
  lineCode: NativeLineCode,
): readonly NativeTrainInsertionOption[] {
  return Object.freeze(trainInsertionCandidates(lineCode).map(({
    stationId,
    destinationStationId,
    direction,
    capacityDeltaPassengers,
  }) => Object.freeze({
    stationId,
    destinationStationId,
    direction,
    capacityDeltaPassengers,
  })));
}

export function nativeTrainInsertionOptions(lineCode: NativeLineCode): readonly NativeTrainInsertionOption[] {
  const route = ROUTES_BY_LINE.get(lineCode);
  if (!route || route.length === 0) return Object.freeze([]);
  const endpoints = new Set([route[0].fromStationCode, route.at(-1)!.toStationCode]);
  return Object.freeze(nativeOperatorTrainInsertionOptions(lineCode)
    .filter((option) => endpoints.has(option.stationId)));
}

export function nativeTrainInsertionStationIds(lineCode: NativeLineCode): readonly string[] {
  return Object.freeze(nativeTrainInsertionOptions(lineCode).map((option) => option.stationId));
}

function orientedEdge(train: Pick<NativeTrainState, "routeInterstationIds" | "routeIndex" | "direction">) {
  const interstation = NATIVE_INTERSTATION_BY_ID.get(train.routeInterstationIds[train.routeIndex]);
  invariant(interstation, `missing current interstation at route index ${train.routeIndex}`);
  const route = ROUTES_BY_LINE.get(interstation.lineCode);
  invariant(route, `missing route for ${interstation.lineCode}`);
  const routeEdge = route[train.routeIndex];
  invariant(routeEdge?.interstationId === interstation.id, `route/interstation mismatch for ${interstation.id}`);
  return train.direction === 1
    ? { interstation, fromStationCode: routeEdge.fromStationCode, toStationCode: routeEdge.toStationCode }
    : { interstation, fromStationCode: routeEdge.toStationCode, toStationCode: routeEdge.fromStationCode };
}

export function nativeTrainOperationalLocation(
  train: Pick<NativeTrainState, "progress" | "fromStationCode" | "currentInterstationId">,
): NativeTrainOperationalLocation {
  return train.progress <= 0
    ? { type: "station", id: train.fromStationCode }
    : { type: "interstation", id: train.currentInterstationId };
}

function makeFleet(): NativeTrainState[] {
  const trains: NativeTrainState[] = [];
  for (const [lineIndex, line] of NATIVE_LINES.entries()) {
    const route = ROUTES_BY_LINE.get(line.code);
    invariant(route && route.length > 0, `${line.code} route is empty`);
    const passengerCapacity = getReferenceCapacity(line.code);
    const routeInterstationIds = Object.freeze(route.map((edge) => edge.interstationId));
    for (const trainIndex of [0, 1] as const) {
      const direction: 1 | -1 = trainIndex === 0 ? 1 : -1;
      const fraction = trainIndex === 0 ? 0.18 : 0.68;
      const routeIndex = Math.min(route.length - 1, Math.floor(route.length * fraction));
      const edge = route[routeIndex];
      const fromStationCode = direction === 1 ? edge.fromStationCode : edge.toStationCode;
      const toStationCode = direction === 1 ? edge.toStationCode : edge.fromStationCode;
      const originStationCode = direction === 1 ? route[0].fromStationCode : route.at(-1)!.toStationCode;
      const destinationStationCode = direction === 1 ? route.at(-1)!.toStationCode : route[0].fromStationCode;
      const suffix = String(trainIndex + 1).padStart(2, "0");
      trains.push({
        id: `${line.code.replace("RER_", "RER")}-T${suffix}`,
        circulationId: `${line.code}-SIM-${suffix}`,
        lineCode: line.code,
        mission: `${line.label}${String(lineIndex + 1).padStart(2, "0")}${trainIndex === 0 ? "A" : "R"}`,
        originStationCode,
        destinationStationCode,
        routeInterstationIds,
        routeIndex,
        direction,
        currentInterstationId: edge.interstationId,
        fromStationCode,
        toStationCode,
        nextStationCode: toStationCode,
        location: { type: "interstation", id: edge.interstationId },
        progress: trainIndex === 0 ? 0.22 : 0.57,
        speedKmh: 0,
        delaySeconds: (lineIndex * 17 + trainIndex * 43) % 190,
        status: "running",
        dwellTicks: 0,
        passengers: Math.min(
          passengerCapacity,
          210 + ((lineIndex * 97 + trainIndex * 151) % 790),
        ),
        quality: "simulated",
      });
    }
  }
  return trains.sort((left, right) => left.id.localeCompare(right.id));
}

interface ResolvedNativeIncidentInput {
  target: NativeIncidentTarget;
  effect: NativeIncidentEffect;
  location: string;
  affectedStationCodes: readonly string[];
  affectedInterstationIds: readonly string[];
  restrictionMode: NativeRestrictionMode;
  speedLimitKmh: number | null;
}

function validateIncidentInput(
  input: NativeIncidentInput,
  trains: readonly NativeTrainState[] = [],
): ResolvedNativeIncidentInput {
  if (!NATIVE_LINE_BY_CODE.has(input.lineCode)) {
    throw new NativeSimulationError("UNKNOWN_LINE", "Unknown native line " + input.lineCode + ".");
  }
  if (!input.title.trim() || !input.summary.trim() || input.title.length > 160 || input.summary.length > 600) {
    throw new NativeSimulationError("INVALID_INPUT", "Incident title and summary must be non-empty and bounded.");
  }
  if (!["infrastructure", "passenger", "rolling-stock", "power", "works", "external", "communications", "security"].includes(input.type)) {
    throw new NativeSimulationError("INVALID_INPUT", "Unknown native incident type.");
  }
  if (!["low", "medium", "high", "critical"].includes(input.severity)) {
    throw new NativeSimulationError("INVALID_INPUT", "Unknown native incident severity.");
  }
  if (input.occurrenceTime !== undefined && (!Number.isSafeInteger(input.occurrenceTime) || input.occurrenceTime < 0)) {
    throw new NativeSimulationError("INVALID_INPUT", "Incident occurrenceTime must be a non-negative epoch-millisecond safe integer.");
  }

  const legacyTarget: NativeIncidentTarget | null = input.interstationId
    ? { type: "interstation", id: input.interstationId }
    : null;
  const target = input.target ?? legacyTarget;
  if (!target) {
    throw new NativeSimulationError("INVALID_INPUT", "Incident target is required.");
  }
  if (!["train", "station", "interstation", "line"].includes(target.type)) {
    throw new NativeSimulationError("INVALID_INPUT", "Unknown native incident target type.");
  }
  const legacyEffect: NativeIncidentEffect = input.restrictionMode === "reduced-speed"
    ? "reduce-speed"
    : "block-interstation";
  const effect = input.effect ?? legacyEffect;

  if (target.type === "train") {
    const train = trains.find((candidate) => candidate.id === target.id);
    if (!train) throw new NativeSimulationError("INVALID_INPUT", "Unknown native train " + target.id + ".");
    if (train.lineCode !== input.lineCode) {
      throw new NativeSimulationError("LINE_MISMATCH", target.id + " belongs to " + train.lineCode + ", not " + input.lineCode + ".");
    }
    if (effect !== "stop-train" && effect !== "tow-train") {
      throw new NativeSimulationError("INVALID_INPUT", "A train incident must use stop-train or tow-train.");
    }
    const edge = NATIVE_INTERSTATION_BY_ID.get(train.currentInterstationId);
    return {
      target,
      effect,
      location: "Train " + train.circulationId,
      affectedStationCodes: train.location.type === "station" ? [train.location.id] : edge ? [edge.fromStationCode, edge.toStationCode] : [],
      affectedInterstationIds: train.location.type === "interstation" ? [train.location.id] : [],
      restrictionMode: "none",
      speedLimitKmh: null,
    };
  }

  if (target.type === "station") {
    const station = NATIVE_STATION_BY_CODE.get(target.id);
    if (!station) throw new NativeSimulationError("INVALID_INPUT", "Unknown native station " + target.id + ".");
    if (!station.lines.includes(input.lineCode)) {
      throw new NativeSimulationError("LINE_MISMATCH", station.name + " is not served by " + input.lineCode + ".");
    }
    if (effect !== "station-closure" && effect !== "station-dwell" && effect !== "abandoned-baggage") {
      throw new NativeSimulationError("INVALID_INPUT", "A station incident must use station-closure, station-dwell, or abandoned-baggage.");
    }
    const affectedInterstationIds = NATIVE_INTERSTATIONS
      .filter((edge) => edge.lineCode === input.lineCode && (edge.fromStationCode === target.id || edge.toStationCode === target.id))
      .map((edge) => edge.id)
      .sort();
    return {
      target,
      effect,
      location: station.name,
      affectedStationCodes: [station.code],
      affectedInterstationIds,
      restrictionMode: effect === "station-closure" || effect === "abandoned-baggage" ? "blocked" : "none",
      speedLimitKmh: null,
    };
  }

  if (target.type === "line") {
    const line = NATIVE_LINE_BY_CODE.get(input.lineCode);
    if (!line || target.id !== input.lineCode) {
      throw new NativeSimulationError("LINE_MISMATCH", "A line incident target must equal its lineCode.");
    }
    if (effect !== "communication-degraded" && effect !== "communication-loss") {
      throw new NativeSimulationError("INVALID_INPUT", "A line incident must use a communication effect.");
    }
    return {
      target,
      effect,
      location: line.label,
      affectedStationCodes: [...line.stationCodes],
      affectedInterstationIds: [...line.interstationIds],
      restrictionMode: "none",
      speedLimitKmh: null,
    };
  }

  const edge = NATIVE_INTERSTATION_BY_ID.get(target.id);
  if (!edge) {
    throw new NativeSimulationError("UNKNOWN_INTERSTATION", "Unknown native interstation " + target.id + ".");
  }
  if (edge.lineCode !== input.lineCode) {
    throw new NativeSimulationError("LINE_MISMATCH", target.id + " belongs to " + edge.lineCode + ", not " + input.lineCode + ".");
  }
  if (effect !== "block-interstation" && effect !== "reduce-speed") {
    throw new NativeSimulationError("INVALID_INPUT", "An interstation incident must block or reduce speed.");
  }
  const speedLimitKmh = effect === "reduce-speed" ? input.speedLimitKmh ?? 25 : null;
  if (speedLimitKmh !== null && (!Number.isFinite(speedLimitKmh) || speedLimitKmh <= 0 || speedLimitKmh > 90)) {
    throw new NativeSimulationError("INVALID_INPUT", "A reduced-speed incident needs a speed limit from 1 to 90 km/h.");
  }
  return {
    target,
    effect,
    location: edgeLocation(edge),
    affectedStationCodes: [edge.fromStationCode, edge.toStationCode],
    affectedInterstationIds: [edge.id],
    restrictionMode: effect === "reduce-speed" ? "reduced-speed" : "blocked",
    speedLimitKmh,
  };
}

function nativeIncidentCode(
  input: NativeIncidentInput,
  resolved: ResolvedNativeIncidentInput,
): string {
  if (input.incidentCode?.trim()) return input.incidentCode.trim();
  const classified = classifyIncidentCode({
    type: input.type,
    targetType: resolved.target.type,
    effect: resolved.effect,
  });
  if (classified !== UNKNOWN_INCIDENT_CODE) return classified;
  const fallbackType = resolved.target.type === "interstation"
    ? "infrastructure"
    : "external";
  return classifyIncidentCode({
    type: fallbackType,
    targetType: resolved.target.type,
    effect: resolved.effect,
  });
}

function incidentFromInput(
  input: NativeIncidentInput,
  id: string,
  timestamp: number,
  trains: readonly NativeTrainState[] = [],
): NativeIncident {
  const resolved = validateIncidentInput(input, trains);
  const occurrenceTime = input.occurrenceTime ?? timestamp;
  const active = occurrenceTime <= timestamp;
  return {
    id,
    incidentCode: nativeIncidentCode(input, resolved),
    title: input.title.trim(),
    summary: input.summary.trim(),
    type: input.type,
    severity: input.severity,
    status: active ? "active" : "planned",
    target: resolved.target,
    effect: resolved.effect,
    lineCode: input.lineCode,
    location: resolved.location,
    affectedStationCodes: Object.freeze([...resolved.affectedStationCodes]),
    affectedInterstationIds: Object.freeze([...resolved.affectedInterstationIds]),
    restrictionMode: resolved.restrictionMode,
    speedLimitKmh: resolved.speedLimitKmh,
    startedAt: occurrenceTime,
    activatedAt: active ? timestamp : null,
    impactedTrainIds: [],
    responseStrategy: null,
    owner: input.owner?.trim() || "ICC operations",
  };
}

function restrictionsFor(incidents: readonly NativeIncident[]): NativeRestriction[] {
  return incidents
    .filter((incident) => incident.status === "active" && incident.restrictionMode !== "none")
    .flatMap((incident) => incident.affectedInterstationIds.map((interstationId) => ({
      id: `RST-${incident.id}-${interstationId}`,
      incidentId: incident.id,
      lineCode: incident.lineCode,
      interstationId,
      mode: incident.restrictionMode as Exclude<NativeRestrictionMode, "none">,
      speedLimitKmh: incident.speedLimitKmh,
      active: true as const,
    })))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function metricsFor(
  trains: readonly NativeTrainState[],
  incidents: readonly NativeIncident[],
  restrictions: readonly NativeRestriction[],
): NativeNetworkMetrics {
  const delayed = trains.filter((train) => train.delaySeconds >= 120);
  const delayTotal = trains.reduce((total, train) => total + train.delaySeconds, 0);
  const maxDelaySeconds = Math.max(0, ...trains.map((train) => train.delaySeconds));
  return {
    fleetSize: trains.length,
    activeIncidentCount: incidents.filter((incident) => incident.status === "active").length,
    blockedInterstationCount: restrictions.filter((restriction) => restriction.mode === "blocked").length,
    reducedSpeedInterstationCount: restrictions.filter((restriction) => restriction.mode === "reduced-speed").length,
    delayedTrainCount: delayed.length,
    heldTrainCount: trains.filter((train) => train.status === "held" || train.status === "stopped").length,
    averageDelaySeconds: trains.length === 0 ? 0 : Math.round(delayTotal / trains.length),
    maxDelaySeconds,
    networkPunctualityPercent: trains.length === 0
      ? 100
      : Math.round(((trains.length - delayed.length) / trains.length) * 1000) / 10,
  };
}

function normalizedStationPassengerStates(
  snapshot: NativeSimulationSnapshot,
): NativeStationPassengerState[] {
  const configured = (snapshot as NativeSimulationSnapshot & {
    stationPassengers?: readonly NativeStationPassengerState[];
  }).stationPassengers;
  if (!Array.isArray(configured)) return createNativeStationPassengerStates();
  const defaults = new Map(createNativeStationPassengerStates().map((state) => [state.id, state]));
  return configured.map((state) => ({
    ...defaults.get(state.id),
    ...state,
    totalGeneratedPassengers: Number.isSafeInteger(state.totalGeneratedPassengers)
      ? state.totalGeneratedPassengers
      : 0,
    totalBoardedPassengers: Number.isSafeInteger(state.totalBoardedPassengers)
      ? state.totalBoardedPassengers
      : 0,
    totalAlightedPassengers: Number.isSafeInteger(state.totalAlightedPassengers)
      ? state.totalAlightedPassengers
      : 0,
    lastBoardedPassengers: Number.isSafeInteger(state.lastBoardedPassengers)
      ? state.lastBoardedPassengers
      : 0,
    lastAlightedPassengers: Number.isSafeInteger(state.lastAlightedPassengers)
      ? state.lastAlightedPassengers
      : 0,
    lastExchangeAt: typeof state.lastExchangeAt === "number" && Number.isFinite(state.lastExchangeAt)
      ? state.lastExchangeAt
      : null,
  }));
}

function withDerivedState(snapshot: NativeSimulationSnapshot): NativeSimulationSnapshot {
  const trains = snapshot.trains.map((train) => ({
    ...train,
    location: nativeTrainOperationalLocation(train),
  }));
  const incidents = snapshot.incidents.map((incident) => {
    let location = incident.location;
    let affectedStationCodes = [...incident.affectedStationCodes];
    let affectedInterstationIds = [...incident.affectedInterstationIds];
    if (incident.target.type === "train") {
      const targetTrain = trains.find((train) => train.id === incident.target.id);
      if (targetTrain) {
        const edge = NATIVE_INTERSTATION_BY_ID.get(targetTrain.currentInterstationId);
        location = "Train " + targetTrain.circulationId + " · " + (targetTrain.location.type === "station"
          ? stationName(targetTrain.location.id)
          : edge ? edgeLocation(edge) : targetTrain.location.id);
        affectedStationCodes = targetTrain.location.type === "station"
          ? [targetTrain.location.id]
          : edge ? [edge.fromStationCode, edge.toStationCode] : [];
        affectedInterstationIds = targetTrain.location.type === "interstation" ? [targetTrain.location.id] : [];
      }
    }
    const impactedTrainIds = incident.status !== "active" ? [] : trains
      .filter((train) => {
        if (train.lineCode !== incident.lineCode) return false;
        if (incident.target.type === "train") return train.id === incident.target.id;
        if (incident.target.type === "station") {
          if (train.location.type === "station" && train.location.id === incident.target.id) return true;
          return (incident.effect === "station-closure" || incident.effect === "abandoned-baggage") && affectedInterstationIds.includes(train.currentInterstationId);
        }
        if (incident.target.type === "line") return true;
        if (affectedInterstationIds.includes(train.currentInterstationId)) return true;
        const next = nextRoutePosition(train);
        return !next.reverses && train.status === "held" && affectedInterstationIds.includes(train.routeInterstationIds[next.routeIndex]);
      })
      .map((train) => train.id)
      .sort();
    return {
      ...incident,
      location,
      affectedStationCodes: Object.freeze(affectedStationCodes),
      affectedInterstationIds: Object.freeze(affectedInterstationIds),
      impactedTrainIds: Object.freeze(impactedTrainIds),
    };
  });
  const restrictions = restrictionsFor(incidents);
  const stationPassengers = normalizedStationPassengerStates(snapshot);
  return {
    ...snapshot,
    trains,
    stationPassengers,
    incidents,
    restrictions,
    metrics: metricsFor(trains, incidents, restrictions),
  };
}

function normalizePersistedTrainLoads(
  snapshot: NativeSimulationSnapshot,
): NativeSimulationSnapshot {
  const restored = structuredClone(snapshot);
  return {
    ...restored,
    trains: restored.trains.map((train) => {
      const capacity = getReferenceCapacity(train.lineCode);
      if (
        !Number.isSafeInteger(train.passengers) ||
        train.passengers < 0 ||
        train.passengers <= capacity
      ) {
        return train;
      }
      return {
        ...train,
        passengers: capacity,
      };
    }),
  };
}

function scenarioIncidents(scenario: NativeScenarioDefinition, timestamp: number): NativeIncident[] {
  return scenario.incidentSeeds.map((input, index) => {
    const seed = input as ScenarioSeed;
    return incidentFromInput(input, seed.id ?? `INC-SEED-${index + 1}`, timestamp);
  });
}

export function createNativeSimulationSnapshot(
  options: NativeNetworkControllerOptions = {},
): NativeSimulationSnapshot {
  const scenarioId = options.scenarioId ?? "multi-event";
  const scenario = SCENARIO_BY_ID.get(scenarioId);
  if (!scenario) throw new NativeSimulationError("UNKNOWN_SCENARIO", `Unknown scenario ${scenarioId}.`);
  const timestamp = options.startTimestamp ?? NATIVE_DEFAULT_TIMESTAMP;
  if (!Number.isFinite(timestamp)) {
    throw new NativeSimulationError("INVALID_INPUT", "Simulation startTimestamp must be finite.");
  }
  return withDerivedState({
    telemetryRevision: 0,
    decisionRevision: 0,
    timestamp,
    speed: options.speed ?? 1,
    scenarioId,
    scenarioName: scenario.name,
    trains: makeFleet(),
    stationPassengers: createNativeStationPassengerStates(),
    incidents: scenarioIncidents(scenario, timestamp),
    restrictions: [],
    metrics: metricsFor([], [], []),
    lastDecision: null,
  });
}

function normalizeConfiguredIncident(incident: NativeIncident): NativeIncident {
  const legacy = incident as NativeIncident & {
    incidentCode?: string;
    target?: NativeIncidentTarget;
    effect?: NativeIncidentEffect;
    activatedAt?: number | null;
  };
  const fallbackInterstationId = legacy.affectedInterstationIds[0];
  const target = legacy.target ?? (fallbackInterstationId
    ? { type: "interstation" as const, id: fallbackInterstationId }
    : null);
  if (!target) {
    throw new NativeSimulationError("INVALID_INPUT", "Configured incident " + legacy.id + " has no target.");
  }
  const effect = legacy.effect ?? (legacy.restrictionMode === "reduced-speed"
    ? "reduce-speed"
    : "block-interstation");
  return {
    ...legacy,
    incidentCode: legacy.incidentCode?.trim() || nativeIncidentCode({
      lineCode: legacy.lineCode,
      target,
      effect,
      title: legacy.title,
      summary: legacy.summary,
      type: legacy.type,
      severity: legacy.severity,
    }, {
      target,
      effect,
      location: legacy.location,
      affectedStationCodes: legacy.affectedStationCodes,
      affectedInterstationIds: legacy.affectedInterstationIds,
      restrictionMode: legacy.restrictionMode,
      speedLimitKmh: legacy.speedLimitKmh,
    }),
    target,
    effect,
    activatedAt: legacy.activatedAt ?? (legacy.status === "planned" ? null : legacy.startedAt),
  };
}

export function createNativeSimulationSnapshotFromConfiguration(
  configuration: NativeSimulationConfigurationState,
): NativeSimulationSnapshot {
  if (!SCENARIO_BY_ID.has(configuration.scenarioId)) {
    throw new NativeSimulationError("UNKNOWN_SCENARIO", "Unknown scenario " + configuration.scenarioId + ".");
  }
  if (!Number.isFinite(configuration.timestamp)) {
    throw new NativeSimulationError("INVALID_INPUT", "Simulation configuration timestamp must be finite.");
  }
  if (![0, 1, 2, 4].includes(configuration.speed)) {
    throw new NativeSimulationError("INVALID_INPUT", "Unsupported simulation speed " + configuration.speed + ".");
  }
  const snapshot = withDerivedState({
    telemetryRevision: 0,
    decisionRevision: 0,
    timestamp: configuration.timestamp,
    speed: configuration.speed,
    scenarioId: configuration.scenarioId,
    scenarioName: configuration.scenarioName.trim() || configuration.scenarioId,
    trains: configuration.trains.map((train) => ({
      ...train,
      routeInterstationIds: [...train.routeInterstationIds],
      location: { ...train.location },
    })),
    stationPassengers: configuration.stationPassengers
      ? configuration.stationPassengers.map((state) => ({ ...state }))
      : createNativeStationPassengerStates(),
    incidents: configuration.incidents.map((configuredIncident) => {
      const incident = normalizeConfiguredIncident(configuredIncident);
      return {
        ...incident,
        target: { ...incident.target },
        affectedStationCodes: [...incident.affectedStationCodes],
        affectedInterstationIds: [...incident.affectedInterstationIds],
        impactedTrainIds: [...incident.impactedTrainIds],
      };
    }),
    restrictions: [],
    metrics: metricsFor([], [], []),
    lastDecision: null,
  });
  assertNativeSimulationInvariants(snapshot);
  return snapshot;
}

function restrictionMap(snapshot: NativeSimulationSnapshot): Map<string, NativeRestriction> {
  return new Map(snapshot.restrictions.map((restriction) => [restriction.interstationId, restriction]));
}

function nextRoutePosition(train: NativeTrainState): {
  routeIndex: number;
  direction: 1 | -1;
  reverses: boolean;
} {
  const proposed = train.routeIndex + train.direction;
  if (proposed >= 0 && proposed < train.routeInterstationIds.length) {
    return { routeIndex: proposed, direction: train.direction, reverses: false };
  }
  return { routeIndex: train.routeIndex, direction: train.direction === 1 ? -1 : 1, reverses: true };
}

function incidentStatusForTarget(
  train: NativeTrainState,
  incidents: readonly NativeIncident[],
): NativeTrainStatus {
  return incidents.some((incident) =>
    incident.status === "active" && (incident.effect === "stop-train" || incident.effect === "tow-train") &&
    incident.target.type === "train" && incident.target.id === train.id
  ) ? "stopped" : "held";
}

function stationExclusionForTrain(
  train: NativeTrainState,
  incidents: readonly NativeIncident[],
): NativeIncident | undefined {
  return incidents.find((incident) =>
    incident.status === "active" &&
    incident.lineCode === train.lineCode &&
    incident.target.type === "station" &&
    (incident.effect === "station-closure" || incident.effect === "abandoned-baggage") &&
    incident.affectedInterstationIds.includes(train.currentInterstationId)
  );
}

/**
 * Return a train already engaged toward an excluded station to the station it
 * has just left. Progress is mirrored because it is always measured from the
 * oriented edge origin.
 */
function reverseOnCurrentInterstation(train: NativeTrainState): NativeTrainState {
  const reversed = {
    ...train,
    direction: (train.direction === 1 ? -1 : 1) as 1 | -1,
    progress: Math.max(0, Math.min(0.999_999, 1 - train.progress)),
    speedKmh: 0,
    status: "running" as const,
    dwellTicks: 0,
    delaySeconds: train.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
  };
  const edge = orientedEdge(reversed);
  return {
    ...reversed,
    fromStationCode: edge.fromStationCode,
    toStationCode: edge.toStationCode,
    nextStationCode: edge.toStationCode,
    location: nativeTrainOperationalLocation(reversed),
  };
}

/**
 * Establish a discrete turnback at the station immediately before a protected
 * station. If the adjacent station is itself the end of the route, the train
 * is retained there because there is no safe outbound edge.
 */
function turnBackBeforeExcludedStation(train: NativeTrainState): NativeTrainState {
  const routeIndex = train.routeIndex - train.direction;
  if (routeIndex < 0 || routeIndex >= train.routeInterstationIds.length) {
    return {
      ...train,
      speedKmh: 0,
      status: "held",
      dwellTicks: 0,
      delaySeconds: train.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
    };
  }
  const turned = {
    ...train,
    routeIndex,
    direction: (train.direction === 1 ? -1 : 1) as 1 | -1,
    currentInterstationId: train.routeInterstationIds[routeIndex],
    progress: 0,
    speedKmh: 0,
    status: "dwelling" as const,
    dwellTicks: NATIVE_STATION_DWELL_TICKS,
    delaySeconds: train.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
  };
  const edge = orientedEdge(turned);
  return {
    ...turned,
    fromStationCode: edge.fromStationCode,
    toStationCode: edge.toStationCode,
    nextStationCode: edge.toStationCode,
    location: { type: "station", id: edge.fromStationCode },
  };
}

/** Ten percent alight at an intermediate stop, rounded to the nearest passenger. */
export function nativeAlightingPassengerCount(
  passengers: number,
  terminus: boolean,
): number {
  return terminus ? passengers : Math.round(passengers * 0.1);
}

function exchangePassengersAtStation(
  train: NativeTrainState,
  stationId: string,
  terminus: boolean,
  exchangeAt: number,
  stationPassengersById: Map<string, NativeStationPassengerState>,
): NativeTrainState {
  const stateId = nativeStationPassengerId(train.lineCode, stationId);
  const stationState = stationPassengersById.get(stateId);
  invariant(stationState, `missing passenger state ${stateId}`);
  const capacity = getReferenceCapacity(train.lineCode);
  const alightingPassengers = nativeAlightingPassengerCount(train.passengers, terminus);
  const remainingPassengers = train.passengers - alightingPassengers;
  const availableCapacity = Math.max(0, capacity - remainingPassengers);
  const boardingPassengers = Math.min(stationState.waitingPassengers, availableCapacity);
  stationPassengersById.set(stateId, {
    ...stationState,
    waitingPassengers: stationState.waitingPassengers - boardingPassengers,
    totalBoardedPassengers: stationState.totalBoardedPassengers + boardingPassengers,
    totalAlightedPassengers: stationState.totalAlightedPassengers + alightingPassengers,
    lastBoardedPassengers: boardingPassengers,
    lastAlightedPassengers: alightingPassengers,
    lastExchangeAt: exchangeAt,
  });
  return {
    ...train,
    passengers: remainingPassengers + boardingPassengers,
  };
}

function stepTrain(
  train: NativeTrainState,
  restrictions: ReadonlyMap<string, NativeRestriction>,
  incidents: readonly NativeIncident[],
  stepTimestamp: number,
  stationPassengersById: Map<string, NativeStationPassengerState>,
): NativeTrainState {
  let current = orientedEdge(train);
  const targetedStop = incidents.some((incident) =>
    incident.status === "active" &&
    (((incident.effect === "stop-train" || incident.effect === "tow-train") && incident.target.type === "train" && incident.target.id === train.id) ||
      (incident.effect === "station-dwell" &&
        incident.target.type === "station" && train.location.type === "station" && train.location.id === incident.target.id))
  );
  if (targetedStop) {
    return {
      ...train,
      speedKmh: 0,
      status: incidentStatusForTarget(train, incidents),
      delaySeconds: train.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
    };
  }
  const stationExclusion = stationExclusionForTrain(train, incidents);
  const excludedStationId = stationExclusion?.target.type === "station"
    ? stationExclusion.target.id
    : null;
  if (excludedStationId && current.toStationCode === excludedStationId) {
    if (train.progress > 0) return reverseOnCurrentInterstation(train);
    return turnBackBeforeExcludedStation(train);
  }
  // A train which was already at the station when protection was established,
  // or one returning after a mid-interstation reversal, must clear the scope
  // without performing a dwell or passenger exchange at the excluded station.
  const clearingExcludedStation = Boolean(
    excludedStationId && current.fromStationCode === excludedStationId,
  );
  if (clearingExcludedStation && train.dwellTicks > 0) {
    train = { ...train, dwellTicks: 0 };
    current = orientedEdge(train);
  }
  const currentRestriction = restrictions.get(train.currentInterstationId);
  const currentRestrictionIncident = currentRestriction
    ? incidents.find((incident) => incident.id === currentRestriction.incidentId)
    : undefined;
  const loadedTrainMayReachStation = Boolean(
    currentRestriction?.mode === "blocked" &&
    train.passengers > 0 &&
    train.progress > 0 &&
    currentRestrictionIncident &&
    currentRestrictionIncident.target.type === "line" &&
      (currentRestrictionIncident.effect === "communication-degraded" || currentRestrictionIncident.effect === "communication-loss"),
  );
  if (currentRestriction?.mode === "blocked" && !loadedTrainMayReachStation && !clearingExcludedStation) {
    return {
      ...train,
      speedKmh: 0,
      status: train.progress <= 0 ? "held" : "stopped",
      delaySeconds: train.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
    };
  }
  if (train.dwellTicks > 1) {
    return {
      ...train,
      speedKmh: 0,
      status: "dwelling",
      dwellTicks: train.dwellTicks - 1,
    };
  }
  if (train.dwellTicks === 1) train = { ...train, dwellTicks: 0 };
  const line = NATIVE_LINE_BY_CODE.get(train.lineCode);
  invariant(line, `missing line ${train.lineCode}`);
  const nominalSpeed = line.mode === "rer" ? 82 : 54;
  const targetSpeed = currentRestriction?.mode === "reduced-speed"
    ? Math.min(nominalSpeed, currentRestriction.speedLimitKmh ?? nominalSpeed)
    : nominalSpeed;
  const distanceUnits = (line.mode === "rer" ? 5.8 : 4.2) *
    (NATIVE_SIMULATION_STEP_MS / 5_000) *
    (targetSpeed / nominalSpeed);
  const effectiveLength = Math.max(8, current.interstation.nativeLength);
  const nextProgress = train.progress + distanceUnits / effectiveLength;
  const nextPosition = nextRoutePosition(train);
  const nextInterstationId = train.routeInterstationIds[nextPosition.routeIndex];
  const nextRestriction = restrictions.get(nextInterstationId);
  const blockedAhead = !nextPosition.reverses && nextRestriction?.mode === "blocked";
  if (blockedAhead && nextProgress >= 1) {
    const positioned = {
      ...train,
      routeIndex: nextPosition.routeIndex,
      direction: nextPosition.direction,
      currentInterstationId: nextInterstationId,
      progress: 0,
      speedKmh: 0,
      status: "held" as const,
      dwellTicks: 0,
      delaySeconds: train.delaySeconds + NATIVE_SIMULATION_STEP_MS / 1_000,
    };
    const oriented = orientedEdge(positioned);
    return {
      ...positioned,
      fromStationCode: oriented.fromStationCode,
      toStationCode: oriented.toStationCode,
      nextStationCode: oriented.toStationCode,
    };
  }
  if (nextProgress < 1) {
    return {
      ...train,
      progress: nextProgress,
      speedKmh: targetSpeed,
      status: "running",
      delaySeconds: Math.max(0, train.delaySeconds - 1),
    };
  }
  const positioned = {
    ...train,
    routeIndex: nextPosition.routeIndex,
    direction: nextPosition.direction,
    currentInterstationId: nextInterstationId,
    progress: 0,
    speedKmh: 0,
    status: "dwelling" as const,
    dwellTicks: NATIVE_STATION_DWELL_TICKS,
  };
  const oriented = orientedEdge(positioned);
  const arrived = {
    ...positioned,
    fromStationCode: oriented.fromStationCode,
    toStationCode: oriented.toStationCode,
    nextStationCode: oriented.toStationCode,
  };
  return exchangePassengersAtStation(
    arrived,
    arrived.fromStationCode,
    nextPosition.reverses,
    stepTimestamp,
    stationPassengersById,
  );
}

function advanceOneStep(snapshot: NativeSimulationSnapshot): NativeSimulationSnapshot {
  const nextTimestamp = snapshot.timestamp + NATIVE_SIMULATION_STEP_MS;
  const hasDueIncident = snapshot.incidents.some(
    (incident) => incident.status === "planned" && incident.startedAt <= nextTimestamp,
  );
  const activated = hasDueIncident ? withDerivedState({
    ...snapshot,
    decisionRevision: snapshot.decisionRevision + 1,
    incidents: snapshot.incidents.map((incident) =>
      incident.status === "planned" && incident.startedAt <= nextTimestamp
        ? { ...incident, status: "active" as const, activatedAt: nextTimestamp }
        : incident,
    ),
  }) : snapshot;
  const restrictions = restrictionMap(activated);
  const accumulatedStationPassengers = accumulateNativeStationPassengers(
    activated.stationPassengers,
    NATIVE_SIMULATION_STEP_MS,
  );
  const stationPassengersById = new Map(
    accumulatedStationPassengers.map((state) => [state.id, state]),
  );
  const trains = [...activated.trains]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((train) => stepTrain(
      train,
      restrictions,
      activated.incidents,
      nextTimestamp,
      stationPassengersById,
    ));
  const stationPassengers = [...stationPassengersById.values()].sort((left, right) =>
    left.lineCode.localeCompare(right.lineCode) || left.stationId.localeCompare(right.stationId)
  );
  return withDerivedState({
    ...activated,
    telemetryRevision: activated.telemetryRevision + 1,
    timestamp: nextTimestamp,
    trains,
    stationPassengers,
  });
}

export function advanceNativeSimulation(snapshot: NativeSimulationSnapshot): NativeSimulationSnapshot {
  if (snapshot.speed === 0) return snapshot;
  let next = snapshot;
  for (let index = 0; index < snapshot.speed; index += 1) next = advanceOneStep(next);
  return next;
}

export function assertNativeSimulationInvariants(snapshot: NativeSimulationSnapshot): void {
  invariant(Number.isInteger(snapshot.telemetryRevision) && snapshot.telemetryRevision >= 0, "invalid telemetry revision");
  invariant(Number.isInteger(snapshot.decisionRevision) && snapshot.decisionRevision >= 0, "invalid decision revision");
  invariant(Number.isFinite(snapshot.timestamp), "invalid timestamp");
  invariant(snapshot.trains.length >= NATIVE_LINES.length * 2, "fleet must retain at least two trains per native line");
  invariant(new Set(snapshot.trains.map((train) => train.id)).size === snapshot.trains.length, "train IDs must be unique");
  for (const line of NATIVE_LINES) {
    invariant(snapshot.trains.filter((train) => train.lineCode === line.code).length >= 2, `${line.code} base fleet`);
  }
  for (const train of snapshot.trains) {
    invariant(Number.isFinite(train.progress) && train.progress >= 0 && train.progress < 1, `${train.id} progress`);
    invariant(Number.isFinite(train.speedKmh) && train.speedKmh >= 0, `${train.id} speed`);
    invariant(Number.isFinite(train.delaySeconds) && train.delaySeconds >= 0, `${train.id} delay`);
    invariant(Number.isSafeInteger(train.passengers) && train.passengers >= 0, `${train.id} passengers`);
    invariant(train.passengers <= getReferenceCapacity(train.lineCode), `${train.id} passenger capacity`);
    const expectedLocation = nativeTrainOperationalLocation(train);
    invariant(train.location.type === expectedLocation.type, `${train.id} location type`);
    invariant(train.location.id === expectedLocation.id, `${train.id} location id`);
    invariant(train.routeIndex >= 0 && train.routeIndex < train.routeInterstationIds.length, `${train.id} route index`);
    invariant(train.currentInterstationId === train.routeInterstationIds[train.routeIndex], `${train.id} route binding`);
    const edge = NATIVE_INTERSTATION_BY_ID.get(train.currentInterstationId);
    invariant(edge?.lineCode === train.lineCode, `${train.id} line binding`);
    const oriented = orientedEdge(train);
    invariant(oriented.fromStationCode === train.fromStationCode, `${train.id} from station`);
    invariant(oriented.toStationCode === train.toStationCode, `${train.id} to station`);
  }
  const expectedPassengerStateIds = new Set(NATIVE_LINES.flatMap((line) =>
    line.stationCodes.map((stationId) => nativeStationPassengerId(line.code, stationId))
  ));
  invariant(snapshot.stationPassengers.length === expectedPassengerStateIds.size, "passenger state coverage");
  invariant(new Set(snapshot.stationPassengers.map((state) => state.id)).size === snapshot.stationPassengers.length, "passenger state IDs");
  for (const state of snapshot.stationPassengers) {
    invariant(expectedPassengerStateIds.has(state.id), `${state.id} topology binding`);
    invariant(state.id === nativeStationPassengerId(state.lineCode, state.stationId), `${state.id} identity`);
    invariant(NATIVE_STATION_BY_CODE.get(state.stationId)?.lines.includes(state.lineCode), `${state.id} station line`);
    invariant(Number.isSafeInteger(state.waitingPassengers) && state.waitingPassengers >= 0, `${state.id} waiting passengers`);
    invariant(Number.isFinite(state.arrivalRemainder) && state.arrivalRemainder >= 0 && state.arrivalRemainder < 1, `${state.id} arrival remainder`);
    invariant(Number.isFinite(state.arrivalsPerSecond) && state.arrivalsPerSecond >= 0, `${state.id} arrival rate`);
    invariant(
      state.demandVolumeProvenance === "official-annual-passenger-journeys" ||
      state.demandVolumeProvenance === "official-daily-passenger-journeys",
      `${state.id} demand provenance`,
    );
    invariant(Number.isSafeInteger(state.referenceYear) && state.referenceYear >= 2000, `${state.id} reference year`);
    for (const [label, value] of [
      ["generated", state.totalGeneratedPassengers],
      ["boarded", state.totalBoardedPassengers],
      ["alighted", state.totalAlightedPassengers],
      ["last boarded", state.lastBoardedPassengers],
      ["last alighted", state.lastAlightedPassengers],
    ] as const) {
      invariant(Number.isSafeInteger(value) && value >= 0, `${state.id} ${label}`);
    }
    invariant(state.lastExchangeAt === null ||
      (Number.isFinite(state.lastExchangeAt) && state.lastExchangeAt <= snapshot.timestamp),
    `${state.id} last exchange`);
  }
  for (const incident of snapshot.incidents) {
    invariant(typeof incident.incidentCode === "string" && incident.incidentCode.length > 0, incident.id + " incident code");
    invariant(["planned", "active", "resolved"].includes(incident.status), incident.id + " status");
    invariant(Number.isFinite(incident.startedAt), incident.id + " occurrence time");
    invariant(incident.status === "planned" ? incident.activatedAt === null : Number.isFinite(incident.activatedAt), incident.id + " activation time");
    if (incident.target.type === "train") {
      invariant(snapshot.trains.some((train) => train.id === incident.target.id && train.lineCode === incident.lineCode), incident.id + " train target");
      invariant(incident.effect === "stop-train" || incident.effect === "tow-train", incident.id + " train effect");
    } else if (incident.target.type === "station") {
      invariant(NATIVE_STATION_BY_CODE.get(incident.target.id)?.lines.includes(incident.lineCode), incident.id + " station target");
      invariant(incident.effect === "station-closure" || incident.effect === "station-dwell" || incident.effect === "abandoned-baggage", incident.id + " station effect");
    } else if (incident.target.type === "line") {
      invariant(incident.target.id === incident.lineCode, incident.id + " line target");
      invariant(incident.effect === "communication-degraded" || incident.effect === "communication-loss", incident.id + " line communication effect");
    } else {
      invariant(NATIVE_INTERSTATION_BY_ID.get(incident.target.id)?.lineCode === incident.lineCode, incident.id + " interstation target");
      invariant(incident.effect === "block-interstation" || incident.effect === "reduce-speed", incident.id + " interstation effect");
    }
  }
  for (const restriction of snapshot.restrictions) {
    const edge = NATIVE_INTERSTATION_BY_ID.get(restriction.interstationId);
    invariant(edge?.lineCode === restriction.lineCode, `${restriction.id} topology binding`);
    invariant(snapshot.incidents.some((incident) => incident.id === restriction.incidentId), `${restriction.id} incident binding`);
  }
}

function responseOptions(incident: NativeIncident): readonly NativeResponseOption[] {
  const degradedSpeed = incident.lineCode.startsWith("RER") ? 35 : 20;
  const protect: NativeResponseOption = {
    id: `${incident.id}:protect-and-hold`,
    action: "protect-and-hold",
    title: "Maintain protection and meter trains upstream",
    summary: "Keep the affected interstation blocked while regulation controls the queue at the previous stations.",
    risk: "low",
    estimatedCapacityPercent: 0,
    estimatedDelayDeltaSeconds: 180,
    constraints: ["Restriction remains active", "No train may enter the protected interstation"],
  };
  const degraded: NativeResponseOption = {
    id: `${incident.id}:degraded-operation`,
    action: "degraded-operation",
    title: "Model supervised degraded operation",
    summary: `Replace the block with a ${degradedSpeed} km/h simulated speed restriction after technical authorization.`,
    risk: incident.severity === "critical" ? "high" : "medium",
    estimatedCapacityPercent: incident.lineCode.startsWith("RER") ? 45 : 55,
    estimatedDelayDeltaSeconds: 60,
    constraints: ["Simulation only", "Requires infrastructure and safety authorization before real-world use"],
  };
  const resolve: NativeResponseOption = {
    id: `${incident.id}:resolve-simulation`,
    action: "resolve-simulation",
    title: "Close the simulated incident",
    summary: "Mark the exercise incident resolved and remove its simulated restriction.",
    risk: "medium",
    estimatedCapacityPercent: 100,
    estimatedDelayDeltaSeconds: -120,
    constraints: ["Exercise state only", "Does not constitute a real infrastructure clearance"],
  };
  return Object.freeze([protect, degraded, resolve]);
}

function evaluationFor(
  snapshot: NativeSimulationSnapshot,
  incident: NativeIncident,
): NativeResponseEvaluation {
  const options = responseOptions(incident);
  const recommendedAction: NativeResponseAction = incident.severity === "critical"
    ? "protect-and-hold"
    : "degraded-operation";
  const lineTrains = snapshot.trains.filter((train) => train.lineCode === incident.lineCode);
  return {
    id: `EVAL-${incident.id}-D${snapshot.decisionRevision}`,
    incidentId: incident.id,
    incidentTitle: incident.title,
    decisionRevision: snapshot.decisionRevision,
    telemetryRevision: snapshot.telemetryRevision,
    evaluatedAt: snapshot.timestamp,
    recommendedOptionId: options.find((option) => option.action === recommendedAction)!.id,
    options,
    evidence: {
      lineCode: incident.lineCode,
      affectedInterstationIds: incident.affectedInterstationIds,
      restrictionMode: incident.restrictionMode,
      impactedTrainIds: incident.impactedTrainIds,
      upstreamHeldTrainIds: lineTrains
        .filter((train) => train.status === "held" || train.status === "stopped")
        .map((train) => train.id),
      maxLineDelaySeconds: Math.max(0, ...lineTrains.map((train) => train.delaySeconds)),
    },
  };
}

function applyOptionToIncident(
  incident: NativeIncident,
  option: NativeResponseOption,
): NativeIncident {
  if (option.action === "protect-and-hold") {
    return { ...incident, restrictionMode: "blocked", speedLimitKmh: null, responseStrategy: option.action };
  }
  if (option.action === "degraded-operation") {
    return {
      ...incident,
      restrictionMode: "reduced-speed",
      speedLimitKmh: incident.lineCode.startsWith("RER") ? 35 : 20,
      responseStrategy: option.action,
    };
  }
  return {
    ...incident,
    status: "resolved",
    restrictionMode: "none",
    speedLimitKmh: null,
    responseStrategy: option.action,
  };
}

function createInsertedTrain(
  snapshot: NativeSimulationSnapshot,
  input: NativeTrainInsertionInput,
): NativeTrainInsertionReceipt {
  const line = NATIVE_LINE_BY_CODE.get(input.lineCode);
  const route = ROUTES_BY_LINE.get(input.lineCode);
  if (!line || !route || route.length === 0) {
    throw new NativeSimulationError("UNKNOWN_LINE", `Unknown insertion line ${input.lineCode}.`);
  }
  const lineFleet = snapshot.trains.filter((train) => train.lineCode === input.lineCode);
  if (lineFleet.length >= 8) {
    throw new NativeSimulationError("INVALID_INPUT", "The bounded exercise fleet already contains the maximum trains for this line.");
  }
  const candidates = trainInsertionCandidates(input.lineCode).filter((candidate) =>
    candidate.stationId === input.stationId &&
    (input.direction === undefined || input.direction === candidate.direction));
  const insertion = candidates[0];
  if (!insertion) {
    throw new NativeSimulationError(
      "INVALID_INPUT",
      `Station ${input.stationId} is not a grounded insertion point for ${input.lineCode}.`,
    );
  }
  let sequence = 1;
  let id: string;
  do {
    id = `${input.lineCode.replace("RER_", "RER")}-I${String(sequence).padStart(2, "0")}`;
    sequence += 1;
  } while (snapshot.trains.some((train) => train.id === id));
  const routeInterstationIds = Object.freeze(route.map((edge) => edge.interstationId));
  const edge = route[insertion.routeIndex];
  const fromStationCode = insertion.direction === 1 ? edge.fromStationCode : edge.toStationCode;
  const toStationCode = insertion.direction === 1 ? edge.toStationCode : edge.fromStationCode;
  const destinationStationCode = insertion.destinationStationId;
  const train: NativeTrainState = {
    id,
    circulationId: `${input.lineCode}-INS-${String(sequence - 1).padStart(2, "0")}`,
    lineCode: input.lineCode,
    mission: `${line.label}I${String(sequence - 1).padStart(2, "0")}`,
    originStationCode: input.stationId,
    destinationStationCode,
    routeInterstationIds,
    routeIndex: insertion.routeIndex,
    direction: insertion.direction,
    currentInterstationId: edge.interstationId,
    fromStationCode,
    toStationCode,
    nextStationCode: toStationCode,
    location: { type: "station", id: input.stationId },
    progress: 0,
    speedKmh: 0,
    delaySeconds: 0,
    status: "dwelling",
    dwellTicks: NATIVE_STATION_DWELL_TICKS,
    passengers: 0,
    quality: "simulated",
  };
  return {
    train,
    stationId: input.stationId,
    direction: insertion.direction,
    capacityDeltaPassengers: line.mode === "rer" ? 1_600 : 700,
    decisionRevision: snapshot.decisionRevision + 1,
  };
}

class NativeNetworkControllerImplementation implements NativeNetworkController {
  private snapshot: NativeSimulationSnapshot;
  private initialSnapshot: NativeSimulationSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly evaluations = new Map<string, NativeResponseEvaluation>();
  private readonly initialOptions: Required<Pick<
    NativeNetworkControllerOptions,
    "scenarioId" | "speed" | "startTimestamp"
  >>;

  constructor(options: NativeNetworkControllerOptions) {
    this.initialOptions = {
      scenarioId: options.scenarioId ?? "multi-event",
      speed: options.speed ?? 1,
      startTimestamp: options.startTimestamp ?? NATIVE_DEFAULT_TIMESTAMP,
    };
    this.snapshot = options.restoredSnapshot
      ? withDerivedState(normalizePersistedTrainLoads(options.restoredSnapshot))
      : createNativeSimulationSnapshot(this.initialOptions);
    this.initialSnapshot = options.baselineSnapshot
      ? withDerivedState(normalizePersistedTrainLoads(options.baselineSnapshot))
      : this.snapshot;
    assertNativeSimulationInvariants(this.snapshot);
    assertNativeSimulationInvariants(this.initialSnapshot);
  }

  getSnapshot = (): NativeSimulationSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: NativeSimulationSnapshot): NativeSimulationSnapshot {
    if (next === this.snapshot) return this.snapshot;
    assertNativeSimulationInvariants(next);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
    return next;
  }

  tick = (): NativeSimulationSnapshot => this.publish(advanceNativeSimulation(this.snapshot));

  reset = (): NativeSimulationSnapshot => {
    const reset = createNativeSimulationSnapshotFromConfiguration({
      timestamp: this.initialSnapshot.timestamp,
      speed: this.initialSnapshot.speed,
      scenarioId: this.initialSnapshot.scenarioId,
      scenarioName: this.initialSnapshot.scenarioName,
      trains: this.initialSnapshot.trains,
      stationPassengers: this.initialSnapshot.stationPassengers,
      incidents: this.initialSnapshot.incidents,
    });
    this.evaluations.clear();
    return this.publish({
      ...reset,
      decisionRevision: this.snapshot.decisionRevision + 1,
      telemetryRevision: this.snapshot.telemetryRevision,
    });
  };

  setSpeed = (speed: NativeSimulationSpeed): NativeSimulationSnapshot => {
    if (![0, 1, 2, 4].includes(speed)) {
      throw new NativeSimulationError("INVALID_INPUT", `Unsupported simulation speed ${speed}.`);
    }
    if (speed === this.snapshot.speed) return this.snapshot;
    return this.publish({
      ...this.snapshot,
      speed,
      decisionRevision: this.snapshot.decisionRevision + 1,
    });
  };

  activateScenario = (scenarioId: NativeScenarioId): NativeSimulationSnapshot => {
    const scenario = SCENARIO_BY_ID.get(scenarioId);
    if (!scenario) throw new NativeSimulationError("UNKNOWN_SCENARIO", `Unknown scenario ${scenarioId}.`);
    const seeded = createNativeSimulationSnapshot({
      scenarioId,
      speed: this.snapshot.speed,
      startTimestamp: this.snapshot.timestamp,
    });
    this.evaluations.clear();
    return this.publish({
      ...seeded,
      telemetryRevision: this.snapshot.telemetryRevision,
      decisionRevision: this.snapshot.decisionRevision + 1,
    });
  };

  loadConfiguration = (configuration: NativeSimulationConfigurationState): NativeSimulationSnapshot => {
    const loaded = createNativeSimulationSnapshotFromConfiguration(configuration);
    this.initialSnapshot = loaded;
    this.evaluations.clear();
    return this.publish({
      ...loaded,
      telemetryRevision: this.snapshot.telemetryRevision,
      decisionRevision: this.snapshot.decisionRevision + 1,
    });
  };

  createIncident = (input: NativeIncidentInput): NativeIncident => {
    validateIncidentInput(input, this.snapshot.trains);
    const id = `INC-USER-${String(this.snapshot.decisionRevision + 1).padStart(4, "0")}-${String(
      this.snapshot.incidents.length + 1,
    ).padStart(2, "0")}`;
    const incident = incidentFromInput(input, id, this.snapshot.timestamp, this.snapshot.trains);
    const next = withDerivedState({
      ...this.snapshot,
      decisionRevision: this.snapshot.decisionRevision + 1,
      incidents: [incident, ...this.snapshot.incidents],
    });
    this.publish(next);
    return this.snapshot.incidents.find((candidate) => candidate.id === id)!;
  };

  insertTrain = (input: NativeTrainInsertionInput): NativeTrainInsertionReceipt => {
    const receipt = createInsertedTrain(this.snapshot, input);
    const stationPassengersById = new Map(
      this.snapshot.stationPassengers.map((state) => [state.id, state]),
    );
    const insertedTrain = exchangePassengersAtStation(
      receipt.train,
      receipt.stationId,
      false,
      this.snapshot.timestamp,
      stationPassengersById,
    );
    this.evaluations.clear();
    this.publish(withDerivedState({
      ...this.snapshot,
      decisionRevision: receipt.decisionRevision,
      trains: [...this.snapshot.trains, insertedTrain].sort((left, right) => left.id.localeCompare(right.id)),
      stationPassengers: [...stationPassengersById.values()].sort((left, right) =>
        left.lineCode.localeCompare(right.lineCode) || left.stationId.localeCompare(right.stationId)
      ),
    }));
    return {
      ...receipt,
      train: this.snapshot.trains.find((train) => train.id === receipt.train.id)!,
    };
  };

  evaluateResponse = (input: { incidentId: string }): NativeResponseEvaluation => {
    const incident = this.snapshot.incidents.find((candidate) => candidate.id === input.incidentId);
    if (!incident) {
      throw new NativeSimulationError("UNKNOWN_INCIDENT", `Unknown incident ${input.incidentId}.`);
    }
    if (incident.status !== "active") {
      throw new NativeSimulationError("INVALID_INPUT", `Incident ${input.incidentId} is already resolved.`);
    }
    const evaluation = evaluationFor(this.snapshot, incident);
    this.evaluations.set(evaluation.id, evaluation);
    return evaluation;
  };

  /**
   * Evaluations are deterministic projections of an incident at one decision
   * revision. Rebuild a missing projection from the restored operational
   * snapshot so a reviewed receipt remains applicable after a process restart
   * (or after an in-memory rollback recreated this controller).
   */
  private evaluationById(evaluationId: string): NativeResponseEvaluation | undefined {
    const cached = this.evaluations.get(evaluationId);
    if (cached) return cached;
    for (const incident of this.snapshot.incidents) {
      if (incident.status !== "active") continue;
      const candidate = evaluationFor(this.snapshot, incident);
      if (candidate.id !== evaluationId) continue;
      this.evaluations.set(candidate.id, candidate);
      return candidate;
    }
    return undefined;
  }

  applyReviewedOption = (input: {
    evaluationId: string;
    optionId: string;
    expectedDecisionRevision: number;
  }): NativeApplyReviewedResult => {
    const block = (reason: NativeApplyBlockReason, message: string): NativeApplyReviewedResult => ({
      ok: false,
      status: "blocked",
      reason,
      message,
      evaluationId: input.evaluationId,
      optionId: input.optionId,
      expectedDecisionRevision: input.expectedDecisionRevision,
      currentDecisionRevision: this.snapshot.decisionRevision,
    });
    const evaluation = this.evaluationById(input.evaluationId);
    if (!evaluation) return block("unknown_evaluation", "The reviewed evaluation does not exist in this controller.");
    if (
      input.expectedDecisionRevision !== this.snapshot.decisionRevision ||
      evaluation.decisionRevision !== this.snapshot.decisionRevision
    ) {
      return block("stale_decision", "Operational decisions changed after this evaluation; evaluate the incident again.");
    }
    const option = evaluation.options.find((candidate) => candidate.id === input.optionId);
    if (!option) return block("unknown_option", "The requested option was not part of the reviewed evaluation.");
    const incident = this.snapshot.incidents.find((candidate) => candidate.id === evaluation.incidentId);
    if (!incident || incident.status !== "active") {
      return block("incident_not_active", "The evaluated incident is no longer active.");
    }
    const nextDecisionRevision = this.snapshot.decisionRevision + 1;
    const receipt: NativeAppliedDecision = {
      receiptId: `DEC-${nextDecisionRevision}-${evaluation.incidentId}`,
      evaluationId: evaluation.id,
      incidentId: incident.id,
      optionId: option.id,
      action: option.action,
      appliedAt: this.snapshot.timestamp,
      decisionRevision: nextDecisionRevision,
      summary: option.summary,
    };
    const next = withDerivedState({
      ...this.snapshot,
      decisionRevision: nextDecisionRevision,
      incidents: this.snapshot.incidents.map((candidate) =>
        candidate.id === incident.id ? applyOptionToIncident(candidate, option) : candidate
      ),
      lastDecision: receipt,
    });
    this.publish(next);
    return {
      ok: true,
      status: "applied",
      evaluationId: evaluation.id,
      optionId: option.id,
      decisionRevision: nextDecisionRevision,
      receipt,
      snapshot: this.snapshot,
    };
  };
}

export function createNativeNetworkController(
  options: NativeNetworkControllerOptions = {},
): NativeNetworkController {
  return new NativeNetworkControllerImplementation(options);
}
