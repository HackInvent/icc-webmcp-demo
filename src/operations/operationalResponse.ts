import type { NativeLineCode } from "../rail/nativeNetwork";
import {
  nativeTrainInsertionOptions,
  nativeTrainInsertionStationIds,
} from "../rail/nativeSimulation";
import { OPERATIONAL_PROCEDURE_CATALOGUE } from "../procedures";
import type { OperationalProcedure, ProcedureCapability } from "../procedures";
import {
  RAIL_GRAPH_INTERSTATIONS,
  RAIL_GRAPH_LINES,
  RAIL_GRAPH_STATION_CONNECTIONS,
  RAIL_GRAPH_STATIONS,
  RAIL_GRAPH_TRANSFERS,
  findRailRoute,
} from "../rail/interdependenceGraph";

export const OPERATIONAL_RESPONSE_SCHEMA = "paris-icc-operational-response-v1" as const;

export const OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS = Object.freeze({
  passengerInformation: 15 * 60,
  connections: 15 * 60,
  provisionalService: 25 * 60,
  turnbacks: 25 * 60,
  shuttleBus: 60 * 60,
});

export type OperationalResponseCapability =
  | "publish-passenger-information"
  | "protect-connections"
  | "dispatch-maintenance"
  | "activate-provisional-service"
  | "activate-turnbacks"
  | "activate-shuttle-bus"
  | "insert-train"
  | "start-towing";

export type OperationalResponseMilestoneCode =
  | "passenger-information"
  | "connections"
  | "provisional-service"
  | "turnbacks"
  | "shuttle-bus";

export interface LineScadaState {
  lineCode: NativeLineCode;
  status: "nominal" | "degraded" | "unavailable";
  lastHeartbeatAt: number;
  communicationIncidentId: string | null;
}

export interface OperationalDurationRange {
  minSeconds: number;
  nominalSeconds: number;
  maxSeconds: number;
}

export interface OperationalEtaRange {
  earliestAt: number;
  expectedAt: number;
  latestAt: number;
}

export interface ProcedureDurationPrediction extends OperationalDurationRange {
  basis: "mandatory-procedure-steps";
  procedureId: string;
  procedureRevision: string;
  calculatedAt: number;
  eta: OperationalEtaRange;
}

export interface OperationalResponseMilestone {
  code: OperationalResponseMilestoneCode;
  thresholdSeconds: number;
  capability: OperationalResponseCapability;
  status: "pending" | "due" | "applied";
  dueAt: number | null;
  dueBasis: "predicted-duration" | "elapsed-duration" | null;
  appliedAt: number | null;
  receiptId: string | null;
}

export interface OperationalIncidentCase {
  incidentId: string;
  incidentCode: string;
  lineCodes: readonly NativeLineCode[];
  openedAt: number;
  status: "active" | "resolved";
  resolvedAt: number | null;
  /** Exact unavailable station scope, distinct from adjacent regulation points. */
  protectedStationIds: readonly string[];
  /** Stations immediately outside the protected scope where trains may turn back. */
  continuityBoundaryStationIds: readonly string[];
  affectedStationIds: readonly string[];
  affectedInterstationIds: readonly string[];
  connectionIds: readonly string[];
  terminalStationIds: readonly string[];
  insertionStationIds: readonly string[];
  predictedDuration: ProcedureDurationPrediction | null;
  milestones: readonly OperationalResponseMilestone[];
}

export interface MaintenancePlan {
  team: "communications" | "infrastructure" | "traction-power" | "rolling-stock";
  targetStationIds: readonly string[];
  estimatedDuration: OperationalDurationRange;
  eta: OperationalEtaRange;
  basisProcedureId: string | null;
  basisProcedureRevision: string | null;
}

export interface MaintenanceDispatch {
  dispatchId: string;
  incidentId: string;
  lineCode: NativeLineCode;
  targetType: string;
  targetId: string;
  status: "proposed" | "dispatched" | "completed";
  proposedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
  receiptId: string | null;
  plan: MaintenancePlan;
}

export type ContinuityMeasureKind =
  | "provisional-service"
  | "turnback"
  | "shuttle-bus"
  | "train-insertion"
  | "towing"
  | "passenger-information"
  | "connection-protection";

export interface DirectedServiceLeg {
  direction: "outbound" | "inbound";
  fromStationId: string;
  toStationId: string;
}

export interface ProvisionalServiceSegment {
  terminalStationIds: readonly [string, string];
  turnbackStationId: string;
  directions: readonly [DirectedServiceLeg, DirectedServiceLeg];
  graphInterstationIds: readonly string[];
}

export interface ShuttleBusCycle {
  phase: "awaiting-approval" | "outbound" | "at-destination" | "inbound" | "at-origin";
  direction: "outbound" | "inbound" | null;
  atStationId: string | null;
  cycleIndex: number;
  phaseStartedAt: number;
  nextTransitionAt: number | null;
}

export type ContinuityMeasurePlan =
  | {
      kind: "shuttle-bus";
      terminusStationIds: readonly [string, string];
      directions: readonly [DirectedServiceLeg, DirectedServiceLeg];
      fleetSize: number;
      headwaySeconds: number;
      vehicleCapacityPassengers: number;
      capacityPerHour: number;
      routeTravelSeconds: number;
      layoverSeconds: number;
      graphInterstationIds: readonly string[];
      cycle: ShuttleBusCycle;
    }
  | {
      kind: "train-insertion";
      stationId: string;
      destinationStationId: string;
      direction: 1 | -1;
      capacityDeltaPassengers: number;
    }
  | {
      kind: "towing";
      receivingTerminalStationId: string;
      direction: "toward-receiving-terminal";
      estimatedDuration: OperationalDurationRange;
      eta: OperationalEtaRange;
      basisProcedureId: string | null;
      basisProcedureRevision: string | null;
    }
  | {
      kind: "provisional-service";
      terminusStationIds: readonly [string, string];
      directions: readonly [DirectedServiceLeg, DirectedServiceLeg];
      targetHeadwaySeconds: number;
      protectedStationIds?: readonly string[];
      turnbackStationIds?: readonly string[];
      serviceSegments?: readonly ProvisionalServiceSegment[];
    }
  | {
      kind: "turnback";
      turnbackStationIds: readonly string[];
      directions: readonly DirectedServiceLeg[];
      protectedStationIds?: readonly string[];
      serviceSegments?: readonly ProvisionalServiceSegment[];
    };

export interface ContinuityMeasure {
  measureId: string;
  incidentId: string;
  kind: ContinuityMeasureKind;
  lineCodes: readonly NativeLineCode[];
  status: "proposed" | "active" | "completed";
  proposedAt: number;
  approvedAt: number | null;
  approvedBy: string | null;
  completedAt: number | null;
  stationIds: readonly string[];
  connectionIds: readonly string[];
  receiptId: string | null;
  /** Shuttle buses are represented as a bidirectional service, never a one-way placeholder. */
  directions: readonly ("outbound" | "inbound")[];
  plan: ContinuityMeasurePlan | null;
}

export interface StationCrowdingState {
  stationId: string;
  lineCodes: readonly NativeLineCode[];
  estimatedPassengers: number;
  level: "normal" | "elevated" | "high" | "critical";
  contributingIncidentIds: readonly string[];
  updatedAt: number;
}

export interface OperationalResponseReceipt {
  receiptId: string;
  incidentId: string;
  capability: OperationalResponseCapability;
  operatorId: string;
  appliedAt: number;
  affectedEntityIds: readonly string[];
}

export interface OperationalResponseState {
  schema: typeof OPERATIONAL_RESPONSE_SCHEMA;
  revision: number;
  updatedAt: number;
  lineScada: readonly LineScadaState[];
  incidentCases: readonly OperationalIncidentCase[];
  dispatches: readonly MaintenanceDispatch[];
  continuityMeasures: readonly ContinuityMeasure[];
  crowding: readonly StationCrowdingState[];
  receipts: readonly OperationalResponseReceipt[];
}

export interface OperationalIncidentEvidence {
  id: string;
  incidentCode: string;
  status: "planned" | "active" | "resolved" | string;
  startedAt: number;
  activatedAt?: number | null;
  lineCode: NativeLineCode;
  type: string;
  effect: string;
  target: { type: string; id: string };
  affectedStationCodes?: readonly string[];
  affectedInterstationIds?: readonly string[];
  impactedTrainIds?: readonly string[];
}

export interface OperationalTrainEvidence {
  id: string;
  lineCode: NativeLineCode;
  passengers: number;
  location: { type: "station" | "interstation"; id: string };
}

export interface AdvanceOperationalResponseResult {
  state: OperationalResponseState;
  decisionChanged: boolean;
  transitions: readonly string[];
}

export class OperationalResponseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OperationalResponseError";
  }
}

const MILESTONE_SPECS: readonly Readonly<{
  code: OperationalResponseMilestoneCode;
  thresholdSeconds: number;
  capability: OperationalResponseCapability;
}>[] = Object.freeze([
  { code: "passenger-information", thresholdSeconds: OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS.passengerInformation, capability: "publish-passenger-information" },
  { code: "connections", thresholdSeconds: OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS.connections, capability: "protect-connections" },
  { code: "provisional-service", thresholdSeconds: OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS.provisionalService, capability: "activate-provisional-service" },
  { code: "turnbacks", thresholdSeconds: OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS.turnbacks, capability: "activate-turnbacks" },
  { code: "shuttle-bus", thresholdSeconds: OPERATIONAL_RESPONSE_THRESHOLDS_SECONDS.shuttleBus, capability: "activate-shuttle-bus" },
]);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function boundedTimestampAdd(timestamp: number, seconds: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, timestamp + Math.max(0, seconds) * 1_000);
}

function etaFrom(timestamp: number, duration: OperationalDurationRange): OperationalEtaRange {
  return {
    earliestAt: boundedTimestampAdd(timestamp, duration.minSeconds),
    expectedAt: boundedTimestampAdd(timestamp, duration.nominalSeconds),
    latestAt: boundedTimestampAdd(timestamp, duration.maxSeconds),
  };
}

function procedureForIncidentCode(
  incidentCode: string,
  timestamp: number,
  catalogue: readonly OperationalProcedure[] = OPERATIONAL_PROCEDURE_CATALOGUE,
): OperationalProcedure | null {
  return [...catalogue]
    .filter((procedure) =>
      procedure.applicability.incidentCodes.includes(incidentCode as never) &&
      procedure.effectiveFrom <= timestamp &&
      (procedure.validUntil === null || timestamp <= procedure.validUntil)
    )
    .sort((left, right) =>
      right.effectiveFrom - left.effectiveFrom ||
      right.revision.localeCompare(left.revision) ||
      left.procedureId.localeCompare(right.procedureId)
    )[0] ?? null;
}

function sumMandatoryProcedureDuration(
  procedure: OperationalProcedure | null,
  calculatedAt: number,
  etaAnchor: number,
): ProcedureDurationPrediction | null {
  if (!procedure) return null;
  // Optional continuity steps are deliberately excluded: including them would
  // allow threshold-generated proposals to inflate their own prediction.
  const mandatory = procedure.steps.filter((step) => step.mandatory);
  const duration = mandatory.reduce<OperationalDurationRange>((total, step) => ({
    minSeconds: total.minSeconds + step.durationRangeSeconds.minSeconds,
    nominalSeconds: total.nominalSeconds + step.durationRangeSeconds.nominalSeconds,
    maxSeconds: total.maxSeconds + step.durationRangeSeconds.maxSeconds,
  }), { minSeconds: 0, nominalSeconds: 0, maxSeconds: 0 });
  return {
    ...duration,
    basis: "mandatory-procedure-steps",
    procedureId: procedure.procedureId,
    procedureRevision: procedure.revision,
    calculatedAt,
    eta: etaFrom(etaAnchor, duration),
  };
}

function durationForCapability(
  procedure: OperationalProcedure | null,
  capability: ProcedureCapability,
  fallback: ProcedureDurationPrediction | null,
): OperationalDurationRange {
  const step = procedure?.steps.find((candidate) => candidate.capability === capability);
  if (step) return { ...step.durationRangeSeconds };
  if (fallback) return {
    minSeconds: fallback.minSeconds,
    nominalSeconds: fallback.nominalSeconds,
    maxSeconds: fallback.maxSeconds,
  };
  return { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 };
}

function graphInterstationsForReferences(references: readonly string[]): typeof RAIL_GRAPH_INTERSTATIONS {
  const wanted = new Set(references);
  return RAIL_GRAPH_INTERSTATIONS.filter((interstation) =>
    wanted.has(interstation.id) ||
    wanted.has(interstation.sourceEdgeId) ||
    wanted.has(interstation.svg.interstationObjectId ?? "") ||
    interstation.svg.pathIds.some((pathId) => wanted.has(pathId))
  );
}

function graphStationIdsForReferences(references: readonly string[]): string[] {
  const wanted = new Set(references);
  return RAIL_GRAPH_STATIONS
    .filter((station) =>
      wanted.has(station.id) ||
      wanted.has(station.name) ||
      wanted.has(station.svg.primaryObjectId ?? "") ||
      station.svg.objectIds.some((objectId) => wanted.has(objectId))
    )
    .map((station) => station.id)
    .sort();
}

function stationIdsForIncident(incident: OperationalIncidentEvidence): string[] {
  const references = new Set(incident.affectedStationCodes ?? []);
  if (incident.target.type === "station") references.add(incident.target.id);
  const interstationReferences = unique([
    ...(incident.affectedInterstationIds ?? []),
    ...(incident.target.type === "interstation" ? [incident.target.id] : []),
  ]);
  const interstationStationIds = graphInterstationsForReferences(interstationReferences)
    .flatMap((interstation) => [interstation.fromStationId, interstation.toStationId]);
  return unique([
    ...graphStationIdsForReferences([...references]),
    ...interstationStationIds,
  ]).sort();
}

function graphContext(incident: OperationalIncidentEvidence) {
  const line = RAIL_GRAPH_LINES.find((candidate) => candidate.id === incident.lineCode);
  const affectedStationIds = stationIdsForIncident(incident);
  const protectedStationIds = incident.target.type === "station"
    ? graphStationIdsForReferences([incident.target.id])
    : [];
  const protectedSet = new Set(protectedStationIds);
  const incidentInterstations = graphInterstationsForReferences(unique([
    ...(incident.affectedInterstationIds ?? []),
    ...(incident.target.type === "interstation" ? [incident.target.id] : []),
  ])).filter((interstation) => interstation.lineCode === incident.lineCode);
  const continuityBoundaryStationIds = unique(
    incident.target.type === "station"
      ? RAIL_GRAPH_INTERSTATIONS
          .filter((interstation) =>
            interstation.lineCode === incident.lineCode &&
            (protectedSet.has(interstation.fromStationId) || protectedSet.has(interstation.toStationId))
          )
          .flatMap((interstation) => [interstation.fromStationId, interstation.toStationId])
          .filter((stationId) => !protectedSet.has(stationId))
      : incident.target.type === "interstation"
        ? incidentInterstations.flatMap((interstation) => [interstation.fromStationId, interstation.toStationId])
        : [],
  ).sort();
  const affectedSet = new Set(affectedStationIds);
  const connectionIds = unique([
    ...RAIL_GRAPH_TRANSFERS.filter((transfer) => affectedSet.has(transfer.stationId)).map((transfer) => transfer.id),
    ...RAIL_GRAPH_STATION_CONNECTIONS
      .filter((connection) => affectedSet.has(connection.fromStationId) || affectedSet.has(connection.toStationId))
      .map((connection) => connection.id),
  ]).sort();
  const terminalStationIds = [...(line?.terminalStationIds ?? [])].sort();
  const nativeInsertionStations = new Set(nativeTrainInsertionStationIds(incident.lineCode));
  const insertionStationIds = terminalStationIds.filter((stationId) => nativeInsertionStations.has(stationId));
  return {
    protectedStationIds,
    continuityBoundaryStationIds,
    affectedStationIds,
    connectionIds,
    terminalStationIds,
    insertionStationIds,
  };
}

function constrainedLineRoute(
  lineCode: NativeLineCode,
  fromStationId: string,
  toStationId: string,
  blocked: {
    stationIds?: readonly string[];
    interstationIds?: readonly string[];
  } = {},
) {
  try {
    return findRailRoute(fromStationId, toStationId, {
      maxTransfers: 0,
      stationConnectionPolicy: "none",
      blockedStationIds: blocked.stationIds,
      blockedInterstationIds: blocked.interstationIds,
      disabledLineCodes: RAIL_GRAPH_LINES
        .map((line) => line.id)
        .filter((candidate) => candidate !== lineCode),
    });
  } catch {
    return null;
  }
}

function terminalPair(incidentCase: Pick<OperationalIncidentCase, "lineCodes" | "terminalStationIds">): [string, string] | null {
  const terminals = unique(incidentCase.terminalStationIds).sort();
  if (terminals.length < 2) return null;
  const lineCode = incidentCase.lineCodes[0];
  let selected: { pair: [string, string]; seconds: number; key: string } | null = null;
  for (let left = 0; left < terminals.length; left += 1) {
    for (let right = left + 1; right < terminals.length; right += 1) {
      const pair: [string, string] = [terminals[left], terminals[right]];
      const route = lineCode ? constrainedLineRoute(lineCode, pair[0], pair[1]) : null;
      if (!route) continue;
      const key = pair.join("|");
      if (!selected || route.estimatedTravelSeconds > selected.seconds ||
        (route.estimatedTravelSeconds === selected.seconds && key.localeCompare(selected.key) < 0)) {
        selected = { pair, seconds: route.estimatedTravelSeconds, key };
      }
    }
  }
  return selected?.pair ?? [terminals[0], terminals.at(-1)!];
}

function serviceDirections(pair: readonly [string, string]): [DirectedServiceLeg, DirectedServiceLeg] {
  return [
    { direction: "outbound", fromStationId: pair[0], toStationId: pair[1] },
    { direction: "inbound", fromStationId: pair[1], toStationId: pair[0] },
  ];
}

function serviceSegmentForBoundary(
  incidentCase: OperationalIncidentCase,
  boundaryStationId: string,
): ProvisionalServiceSegment | null {
  const lineCode = incidentCase.lineCodes[0];
  if (!lineCode) return null;
  const routeCandidates = incidentCase.terminalStationIds
    .filter((terminalStationId) =>
      terminalStationId !== boundaryStationId &&
      !incidentCase.protectedStationIds.includes(terminalStationId)
    )
    .map((terminalStationId) => {
      const route = constrainedLineRoute(lineCode, terminalStationId, boundaryStationId, {
        stationIds: incidentCase.protectedStationIds,
        interstationIds: incidentCase.affectedInterstationIds,
      });
      return route ? { terminalStationId, route } : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) =>
      right.route.estimatedTravelSeconds - left.route.estimatedTravelSeconds ||
      left.terminalStationId.localeCompare(right.terminalStationId)
    );
  const selected = routeCandidates[0];
  if (!selected) return null;
  const pair: [string, string] = [selected.terminalStationId, boundaryStationId];
  return {
    terminalStationIds: pair,
    turnbackStationId: boundaryStationId,
    directions: serviceDirections(pair),
    graphInterstationIds: [...selected.route.interstationIds],
  };
}

function provisionalServiceSegments(
  incidentCase: OperationalIncidentCase,
): ProvisionalServiceSegment[] {
  return incidentCase.continuityBoundaryStationIds
    .map((boundaryStationId) => serviceSegmentForBoundary(incidentCase, boundaryStationId))
    .filter((segment): segment is ProvisionalServiceSegment => segment !== null)
    .sort((left, right) => left.turnbackStationId.localeCompare(right.turnbackStationId));
}

function continuityPair(
  incidentCase: OperationalIncidentCase,
  segments: readonly ProvisionalServiceSegment[],
): [string, string] | null {
  const boundaries = unique(incidentCase.continuityBoundaryStationIds).sort();
  if (boundaries.length >= 2) return [boundaries[0], boundaries[1]];
  if (segments[0]) return [...segments[0].terminalStationIds];
  if (boundaries[0] && incidentCase.protectedStationIds[0]) {
    return [boundaries[0], incidentCase.protectedStationIds[0]];
  }
  return terminalPair(incidentCase);
}

function busCycle(
  pair: readonly [string, string],
  approvedAt: number | null,
  timestamp: number,
  routeTravelSeconds: number,
  layoverSeconds: number,
): ShuttleBusCycle {
  if (approvedAt === null) {
    return {
      phase: "awaiting-approval",
      direction: null,
      atStationId: pair[0],
      cycleIndex: 0,
      phaseStartedAt: timestamp,
      nextTransitionAt: null,
    };
  }
  const legMs = routeTravelSeconds * 1_000;
  const layoverMs = layoverSeconds * 1_000;
  const cycleMs = Math.max(1, 2 * legMs + 2 * layoverMs);
  const elapsed = Math.max(0, timestamp - approvedAt);
  const cycleIndex = Math.floor(elapsed / cycleMs);
  const within = elapsed % cycleMs;
  const cycleStart = approvedAt + cycleIndex * cycleMs;
  if (within < legMs) {
    return { phase: "outbound", direction: "outbound", atStationId: null, cycleIndex, phaseStartedAt: cycleStart, nextTransitionAt: cycleStart + legMs };
  }
  if (within < legMs + layoverMs) {
    return { phase: "at-destination", direction: null, atStationId: pair[1], cycleIndex, phaseStartedAt: cycleStart + legMs, nextTransitionAt: cycleStart + legMs + layoverMs };
  }
  if (within < 2 * legMs + layoverMs) {
    return { phase: "inbound", direction: "inbound", atStationId: null, cycleIndex, phaseStartedAt: cycleStart + legMs + layoverMs, nextTransitionAt: cycleStart + 2 * legMs + layoverMs };
  }
  return { phase: "at-origin", direction: null, atStationId: pair[0], cycleIndex, phaseStartedAt: cycleStart + 2 * legMs + layoverMs, nextTransitionAt: cycleStart + cycleMs };
}

function closestInsertionPlan(incidentCase: OperationalIncidentCase): ContinuityMeasurePlan | null {
  const lineCode = incidentCase.lineCodes[0];
  if (!lineCode) return null;
  const focusStationId = incidentCase.affectedStationIds[0];
  const options = nativeTrainInsertionOptions(lineCode).map((option) => {
    const route = focusStationId ? constrainedLineRoute(lineCode, option.stationId, focusStationId) : null;
    return { option, seconds: route?.estimatedTravelSeconds ?? Number.MAX_SAFE_INTEGER };
  }).sort((left, right) =>
    left.seconds - right.seconds || left.option.stationId.localeCompare(right.option.stationId)
  );
  const selected = options[0]?.option;
  return selected ? {
    kind: "train-insertion",
    stationId: selected.stationId,
    destinationStationId: selected.destinationStationId,
    direction: selected.direction,
    capacityDeltaPassengers: selected.capacityDeltaPassengers,
  } : null;
}

function towingTerminal(incidentCase: OperationalIncidentCase): string | null {
  const lineCode = incidentCase.lineCodes[0];
  const focusStationId = incidentCase.affectedStationIds[0];
  if (!lineCode) return incidentCase.terminalStationIds[0] ?? null;
  return incidentCase.terminalStationIds.map((stationId) => ({
    stationId,
    seconds: focusStationId
      ? constrainedLineRoute(lineCode, focusStationId, stationId)?.estimatedTravelSeconds ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER,
  })).sort((left, right) => left.seconds - right.seconds || left.stationId.localeCompare(right.stationId))[0]?.stationId ?? null;
}

function buildContinuityPlan(
  incidentCase: OperationalIncidentCase,
  kind: ContinuityMeasureKind,
  timestamp: number,
  approvedAt: number | null = null,
): ContinuityMeasurePlan | null {
  const serviceSegments = provisionalServiceSegments(incidentCase);
  const pair = continuityPair(incidentCase, serviceSegments);
  const lineCode = incidentCase.lineCodes[0];
  if (kind === "train-insertion") return closestInsertionPlan(incidentCase);
  if (kind === "provisional-service" && pair) {
    const turnbackStationIds = serviceSegments.length > 0
      ? serviceSegments.map((segment) => segment.turnbackStationId)
      : [...pair];
    const directions: readonly [DirectedServiceLeg, DirectedServiceLeg] = serviceSegments.length >= 2
      ? serviceSegments[0].directions
      : serviceSegments[0]?.directions ?? serviceDirections(pair);
    return {
      kind,
      terminusStationIds: pair,
      directions,
      targetHeadwaySeconds: 6 * 60,
      protectedStationIds: [...incidentCase.protectedStationIds],
      turnbackStationIds,
      serviceSegments,
    };
  }
  if (kind === "turnback" && pair) {
    const turnbackStationIds = serviceSegments.length > 0
      ? serviceSegments.map((segment) => segment.turnbackStationId)
      : [...pair];
    return {
      kind,
      turnbackStationIds,
      directions: serviceSegments.length > 0
        ? serviceSegments.flatMap((segment) => segment.directions)
        : serviceDirections(pair),
      protectedStationIds: [...incidentCase.protectedStationIds],
      serviceSegments,
    };
  }
  if (kind === "shuttle-bus" && pair && lineCode) {
    const route = constrainedLineRoute(lineCode, pair[0], pair[1]);
    const routeTravelSeconds = Math.max(300, Math.min(7_200, route?.estimatedTravelSeconds ?? 1_800));
    const headwaySeconds = 10 * 60;
    const layoverSeconds = 5 * 60;
    const fleetSize = Math.max(4, Math.min(24, Math.ceil((2 * routeTravelSeconds + 2 * layoverSeconds) / headwaySeconds)));
    const vehicleCapacityPassengers = 80;
    return {
      kind,
      terminusStationIds: pair,
      directions: serviceDirections(pair),
      fleetSize,
      headwaySeconds,
      vehicleCapacityPassengers,
      capacityPerHour: Math.round(fleetSize * vehicleCapacityPassengers * 3_600 / headwaySeconds),
      routeTravelSeconds,
      layoverSeconds,
      graphInterstationIds: [...(route?.interstationIds ?? [])].slice(0, 120),
      cycle: busCycle(pair, approvedAt, timestamp, routeTravelSeconds, layoverSeconds),
    };
  }
  if (kind === "towing") {
    const terminal = towingTerminal(incidentCase);
    if (!terminal) return null;
    const procedure = procedureForIncidentCode(incidentCase.incidentCode, timestamp);
    const estimate = durationForCapability(procedure, "start-towing", incidentCase.predictedDuration);
    return {
      kind,
      receivingTerminalStationId: terminal,
      direction: "toward-receiving-terminal",
      estimatedDuration: estimate,
      eta: etaFrom(approvedAt ?? timestamp, estimate),
      basisProcedureId: procedure?.procedureId ?? null,
      basisProcedureRevision: procedure?.revision ?? null,
    };
  }
  return null;
}

function maintenanceTeam(incidentCode: string): MaintenancePlan["team"] {
  if (incidentCode.includes("-COM-")) return "communications";
  if (incidentCode.includes("-PWR-")) return "traction-power";
  if (incidentCode.includes("-RST-")) return "rolling-stock";
  return "infrastructure";
}

function maintenancePlan(incidentCase: OperationalIncidentCase, timestamp: number): MaintenancePlan {
  const procedure = procedureForIncidentCode(incidentCase.incidentCode, timestamp);
  const duration = durationForCapability(procedure, "dispatch-maintenance", incidentCase.predictedDuration);
  return {
    team: maintenanceTeam(incidentCase.incidentCode),
    targetStationIds: [...incidentCase.affectedStationIds].slice(0, 12),
    estimatedDuration: duration,
    eta: etaFrom(timestamp, duration),
    basisProcedureId: procedure?.procedureId ?? null,
    basisProcedureRevision: procedure?.revision ?? null,
  };
}

function initialMilestones(): OperationalResponseMilestone[] {
  return MILESTONE_SPECS.map((item) => ({
    ...item,
    status: "pending",
    dueAt: null,
    dueBasis: null,
    appliedAt: null,
    receiptId: null,
  }));
}

export function createOperationalResponseState(timestamp = 0): OperationalResponseState {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError("timestamp must be a non-negative epoch-millisecond safe integer");
  return {
    schema: OPERATIONAL_RESPONSE_SCHEMA,
    revision: 1,
    updatedAt: timestamp,
    lineScada: RAIL_GRAPH_LINES.map((line) => ({
      lineCode: line.id,
      status: "nominal",
      lastHeartbeatAt: timestamp,
      communicationIncidentId: null,
    })),
    incidentCases: [],
    dispatches: [],
    continuityMeasures: [],
    crowding: [],
    receipts: [],
  };
}

export function migrateOperationalResponseState(
  value: unknown,
  timestamp = 0,
): OperationalResponseState {
  if (!value || typeof value !== "object" || (value as { schema?: unknown }).schema !== OPERATIONAL_RESPONSE_SCHEMA) {
    return createOperationalResponseState(timestamp);
  }
  const state = structuredClone(value) as OperationalResponseState;
  state.incidentCases = (state.incidentCases ?? []).map((incidentCase) => {
    const predictedDuration = incidentCase.predictedDuration ?? sumMandatoryProcedureDuration(
      procedureForIncidentCode(incidentCase.incidentCode, timestamp),
      timestamp,
      incidentCase.openedAt,
    );
    return {
      ...incidentCase,
      protectedStationIds: [...(incidentCase.protectedStationIds ?? [])],
      continuityBoundaryStationIds: [...(
        incidentCase.continuityBoundaryStationIds ??
        incidentCase.affectedStationIds.filter((stationId) =>
          !(incidentCase.protectedStationIds ?? []).includes(stationId)
        )
      )],
      predictedDuration,
      milestones: (incidentCase.milestones ?? initialMilestones()).map((milestone) => ({
        ...milestone,
        dueBasis: milestone.dueBasis ?? (milestone.dueAt === null ? null : "elapsed-duration"),
      })),
    };
  });
  const casesById = new Map(state.incidentCases.map((incidentCase) => [incidentCase.incidentId, incidentCase]));
  state.dispatches = (state.dispatches ?? []).map((dispatch) => {
    const incidentCase = casesById.get(dispatch.incidentId);
    const anchor = dispatch.dispatchedAt ?? dispatch.proposedAt ?? timestamp;
    return {
      ...dispatch,
      plan: dispatch.plan ?? (incidentCase ? maintenancePlan(incidentCase, anchor) : {
        team: "infrastructure",
        targetStationIds: [],
        estimatedDuration: { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 },
        eta: etaFrom(anchor, { minSeconds: 300, nominalSeconds: 900, maxSeconds: 3_600 }),
        basisProcedureId: null,
        basisProcedureRevision: null,
      }),
    };
  });
  state.continuityMeasures = (state.continuityMeasures ?? []).map((measure) => {
    const incidentCase = casesById.get(measure.incidentId);
    const approvedAt = measure.approvedAt ?? null;
    const rebuiltPlan = incidentCase
      ? buildContinuityPlan(incidentCase, measure.kind, timestamp, approvedAt)
      : null;
    let plan = measure.plan ?? rebuiltPlan;
    if (
      measure.plan?.kind === "provisional-service" &&
      rebuiltPlan?.kind === "provisional-service"
    ) {
      plan = {
        ...rebuiltPlan,
        ...measure.plan,
        protectedStationIds: measure.plan.protectedStationIds ?? rebuiltPlan.protectedStationIds,
        turnbackStationIds: measure.plan.turnbackStationIds ?? rebuiltPlan.turnbackStationIds,
        serviceSegments: measure.plan.serviceSegments ?? rebuiltPlan.serviceSegments,
      };
    } else if (
      measure.plan?.kind === "turnback" &&
      rebuiltPlan?.kind === "turnback"
    ) {
      plan = {
        ...rebuiltPlan,
        ...measure.plan,
        protectedStationIds: measure.plan.protectedStationIds ?? rebuiltPlan.protectedStationIds,
        serviceSegments: measure.plan.serviceSegments ?? rebuiltPlan.serviceSegments,
      };
    }
    return {
      ...measure,
      plan,
    };
  });
  assertOperationalResponseInvariants(state);
  return state;
}

function measureKind(capability: OperationalResponseCapability): ContinuityMeasureKind | null {
  switch (capability) {
    case "publish-passenger-information": return "passenger-information";
    case "protect-connections": return "connection-protection";
    case "activate-provisional-service": return "provisional-service";
    case "activate-turnbacks": return "turnback";
    case "activate-shuttle-bus": return "shuttle-bus";
    case "insert-train": return "train-insertion";
    case "start-towing": return "towing";
    default: return null;
  }
}

function proposedMeasure(
  incidentCase: OperationalIncidentCase,
  capability: OperationalResponseCapability,
  timestamp: number,
): ContinuityMeasure | null {
  const kind = measureKind(capability);
  if (!kind) return null;
  const plan = buildContinuityPlan(incidentCase, kind, timestamp);
  const plannedStationIds = plan?.kind === "train-insertion"
    ? [plan.stationId]
    : plan?.kind === "provisional-service" && (plan.serviceSegments?.length ?? 0) > 0
      ? unique(plan.serviceSegments!.flatMap((segment) => segment.terminalStationIds)).sort()
    : plan?.kind === "shuttle-bus" || plan?.kind === "provisional-service"
      ? [...plan.terminusStationIds]
      : plan?.kind === "turnback"
        ? [...plan.turnbackStationIds]
      : plan?.kind === "towing"
        ? [plan.receivingTerminalStationId]
        : kind === "connection-protection"
          ? [...incidentCase.affectedStationIds]
          : kind === "train-insertion"
            ? [...incidentCase.insertionStationIds]
            : [...incidentCase.terminalStationIds];
  return {
    measureId: `MEASURE:${incidentCase.incidentId}:${kind}`,
    incidentId: incidentCase.incidentId,
    kind,
    lineCodes: [...incidentCase.lineCodes],
    status: "proposed",
    proposedAt: timestamp,
    approvedAt: null,
    approvedBy: null,
    completedAt: null,
    stationIds: plannedStationIds,
    connectionIds: kind === "connection-protection" ? [...incidentCase.connectionIds] : [],
    receiptId: null,
    directions:
      kind === "shuttle-bus" || kind === "provisional-service" || kind === "turnback"
        ? ["outbound", "inbound"]
        : [],
    plan,
  };
}

function crowdingFrom(
  incidents: readonly OperationalIncidentEvidence[],
  trains: readonly OperationalTrainEvidence[],
  timestamp: number,
): StationCrowdingState[] {
  const result = new Map<string, { lineCodes: NativeLineCode[]; passengers: number; incidentIds: string[] }>();
  for (const incident of incidents.filter((item) => item.status === "active")) {
    const stationIds = stationIdsForIncident(incident);
    if (stationIds.length === 0) continue;
    const impacted = new Set(incident.impactedTrainIds ?? []);
    const passengerCount = trains
      .filter((train) => impacted.has(train.id))
      .reduce((sum, train) => sum + Math.max(0, train.passengers), 0);
    const passengersPerStation = stationIds.length === 0
      ? 0
      : Math.ceil(passengerCount / stationIds.length);
    for (const stationId of stationIds) {
      const current = result.get(stationId) ?? { lineCodes: [], passengers: 0, incidentIds: [] };
      current.lineCodes.push(incident.lineCode);
      current.passengers += passengersPerStation;
      current.incidentIds.push(incident.id);
      result.set(stationId, current);
    }
  }
  return [...result.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([stationId, item]) => ({
    stationId,
    lineCodes: unique(item.lineCodes).sort(),
    estimatedPassengers: item.passengers,
    level: item.passengers >= 2_000 ? "critical" : item.passengers >= 1_000 ? "high" : item.passengers >= 400 ? "elevated" : "normal",
    contributingIncidentIds: unique(item.incidentIds).sort(),
    updatedAt: timestamp,
  }));
}

export function advanceOperationalResponse(
  previous: OperationalResponseState,
  incidents: readonly OperationalIncidentEvidence[],
  trains: readonly OperationalTrainEvidence[],
  timestamp: number,
  procedureCatalogue: readonly OperationalProcedure[] = OPERATIONAL_PROCEDURE_CATALOGUE,
): AdvanceOperationalResponseResult {
  const next = migrateOperationalResponseState(previous, timestamp);
  const transitions: string[] = [];
  const byId = new Map(next.incidentCases.map((item) => [item.incidentId, item]));
  const measures = [...next.continuityMeasures];
  const dispatches = [...next.dispatches];

  for (const incident of incidents) {
    if (incident.status !== "active" && incident.status !== "resolved") continue;
    let incidentCase = byId.get(incident.id);
    if (!incidentCase && incident.status === "active") {
      const context = graphContext(incident);
      const openedAt = incident.activatedAt ?? incident.startedAt;
      const predictedDuration = sumMandatoryProcedureDuration(
        procedureForIncidentCode(incident.incidentCode, timestamp, procedureCatalogue),
        timestamp,
        openedAt,
      );
      incidentCase = {
        incidentId: incident.id,
        incidentCode: incident.incidentCode,
        lineCodes: [incident.lineCode],
        openedAt,
        status: "active",
        resolvedAt: null,
        protectedStationIds: context.protectedStationIds,
        continuityBoundaryStationIds: context.continuityBoundaryStationIds,
        affectedStationIds: context.affectedStationIds,
        affectedInterstationIds: [...(incident.affectedInterstationIds ?? [])],
        connectionIds: context.connectionIds,
        terminalStationIds: context.terminalStationIds,
        insertionStationIds: context.insertionStationIds,
        predictedDuration,
        milestones: initialMilestones(),
      };
      next.incidentCases = [...next.incidentCases, incidentCase];
      byId.set(incident.id, incidentCase);
      transitions.push(`incident_case_opened:${incident.id}`);
      const insertion = proposedMeasure(incidentCase, "insert-train", timestamp);
      if (insertion) measures.push(insertion);
      if (
        incident.target.type === "station" &&
        (incident.effect === "station-closure" || incident.effect === "abandoned-baggage")
      ) {
        for (const capability of ["activate-provisional-service", "activate-turnbacks"] as const) {
          const continuity = proposedMeasure(incidentCase, capability, timestamp);
          if (continuity) measures.push(continuity);
        }
      }
      if (incident.effect === "tow-train" || (incident.type === "rolling-stock" && incident.effect === "stop-train")) {
        const towing = proposedMeasure(incidentCase, "start-towing", timestamp);
        if (towing) measures.push(towing);
      }
      if (
        ["infrastructure", "rolling-stock", "power"].includes(incident.type) ||
        incident.target.type === "power" ||
        incident.effect.includes("communication")
      ) {
        dispatches.push({
          dispatchId: `DISPATCH:${incident.id}`,
          incidentId: incident.id,
          lineCode: incident.lineCode,
          targetType: incident.target.type,
          targetId: incident.target.id,
          status: "proposed",
          proposedAt: timestamp,
          dispatchedAt: null,
          completedAt: null,
          receiptId: null,
          plan: maintenancePlan(incidentCase, timestamp),
        });
      }
    }
    if (!incidentCase) continue;
    if (incident.status === "resolved" && incidentCase.status !== "resolved") {
      incidentCase.status = "resolved";
      incidentCase.resolvedAt = timestamp;
      for (const measure of measures.filter((item) => item.incidentId === incident.id && item.status !== "completed")) {
        measure.status = "completed";
        measure.completedAt = timestamp;
      }
      for (const dispatch of dispatches.filter((item) => item.incidentId === incident.id && item.status !== "completed")) {
        dispatch.status = "completed";
        dispatch.completedAt = timestamp;
      }
      transitions.push(`incident_case_resolved:${incident.id}`);
    }
    if (incidentCase.status === "active") {
      const elapsedSeconds = Math.max(0, Math.floor((timestamp - incidentCase.openedAt) / 1_000));
      for (const milestone of incidentCase.milestones) {
        // Thresholds remain strict. A catalogue prediction can make the response
        // due before elapsed time, but the measure is still only a proposal.
        const predictionExceedsThreshold =
          (incidentCase.predictedDuration?.nominalSeconds ?? 0) > milestone.thresholdSeconds;
        const elapsedExceedsThreshold = elapsedSeconds > milestone.thresholdSeconds;
        if (milestone.status === "pending" && (predictionExceedsThreshold || elapsedExceedsThreshold)) {
          milestone.status = "due";
          milestone.dueAt = timestamp;
          milestone.dueBasis = predictionExceedsThreshold ? "predicted-duration" : "elapsed-duration";
          transitions.push(`milestone_due:${incident.id}:${milestone.code}:${milestone.dueBasis}`);
          if (!measures.some((item) => item.incidentId === incident.id && item.kind === measureKind(milestone.capability))) {
            const proposal = proposedMeasure(incidentCase, milestone.capability, timestamp);
            if (proposal) measures.push(proposal);
          }
        }
      }
    }
  }

  for (const scada of next.lineScada) {
    const communicationIncident = incidents.find((incident) =>
      incident.status === "active" && incident.lineCode === scada.lineCode && incident.effect.includes("communication")
    );
    const status = communicationIncident
      ? communicationIncident.effect.includes("loss") || communicationIncident.effect.includes("unavailable") ? "unavailable" : "degraded"
      : "nominal";
    if (scada.status !== status || scada.communicationIncidentId !== (communicationIncident?.id ?? null)) {
      scada.status = status;
      scada.communicationIncidentId = communicationIncident?.id ?? null;
      transitions.push(`scada:${scada.lineCode}:${status}`);
    }
    if (status === "nominal") scada.lastHeartbeatAt = timestamp;
  }

  for (const measure of measures) {
    if (measure.status !== "active" || measure.kind !== "shuttle-bus" || measure.plan?.kind !== "shuttle-bus") continue;
    const previousCycle = measure.plan.cycle;
    const nextCycle = busCycle(
      measure.plan.terminusStationIds,
      measure.approvedAt,
      timestamp,
      measure.plan.routeTravelSeconds,
      measure.plan.layoverSeconds,
    );
    measure.plan.cycle = nextCycle;
    if (previousCycle.phase !== nextCycle.phase || previousCycle.cycleIndex !== nextCycle.cycleIndex) {
      transitions.push(`shuttle_cycle:${measure.incidentId}:${nextCycle.phase}:${nextCycle.cycleIndex}`);
    }
  }

  next.dispatches = dispatches;
  next.continuityMeasures = measures;
  next.crowding = crowdingFrom(incidents, trains, timestamp);
  if (transitions.length > 0) next.revision += 1;
  next.updatedAt = timestamp;
  assertOperationalResponseInvariants(next);
  return { state: next, decisionChanged: transitions.length > 0, transitions };
}

export function applyOperationalResponseCapability(
  previous: OperationalResponseState,
  input: {
    incidentId: string;
    capability: OperationalResponseCapability;
    operatorId: string;
    timestamp: number;
  },
): { state: OperationalResponseState; receipt: OperationalResponseReceipt } {
  const next = migrateOperationalResponseState(previous, input.timestamp);
  const incidentCase = next.incidentCases.find((item) => item.incidentId === input.incidentId);
  if (!incidentCase || incidentCase.status !== "active") {
    throw new OperationalResponseError("INCIDENT_NOT_ACTIVE", "An active grounded incident case is required.");
  }
  if (!input.operatorId.trim()) throw new OperationalResponseError("OPERATOR_REQUIRED", "Operator approval identity is required.");
  let affectedEntityIds: string[] = [];
  if (input.capability === "dispatch-maintenance") {
    const dispatch = next.dispatches.find((item) => item.incidentId === input.incidentId);
    if (!dispatch || dispatch.status !== "proposed") {
      throw new OperationalResponseError("CAPABILITY_NOT_DUE", "No proposed maintenance dispatch is available.");
    }
    dispatch.status = "dispatched";
    dispatch.dispatchedAt = input.timestamp;
    dispatch.plan = {
      ...dispatch.plan,
      eta: etaFrom(input.timestamp, dispatch.plan.estimatedDuration),
    };
    affectedEntityIds = unique([dispatch.targetId, ...dispatch.plan.targetStationIds]);
  } else {
    const kind = measureKind(input.capability);
    const measure = next.continuityMeasures.find((item) => item.incidentId === input.incidentId && item.kind === kind);
    if (!measure || measure.status !== "proposed") {
      throw new OperationalResponseError("CAPABILITY_NOT_DUE", "The response measure is not due or was already applied.");
    }
    if ((kind === "turnback" || kind === "train-insertion" || kind === "provisional-service" || kind === "shuttle-bus") && measure.stationIds.length === 0) {
      throw new OperationalResponseError("NO_GROUNDED_ENTITY", "The interdependence graph contains no eligible station for this measure.");
    }
    if (kind === "train-insertion") {
      const nativeStations = new Set(
        incidentCase.lineCodes.flatMap((lineCode) => nativeTrainInsertionStationIds(lineCode)),
      );
      const plannedStationId = measure.plan?.kind === "train-insertion" ? measure.plan.stationId : null;
      const selectedStationId = plannedStationId && nativeStations.has(plannedStationId)
        ? plannedStationId
        : measure.stationIds.find((stationId) => nativeStations.has(stationId));
      if (!selectedStationId) {
        throw new OperationalResponseError("NO_GROUNDED_ENTITY", "No graph terminal maps to a native insertion station.");
      }
      measure.stationIds = [selectedStationId];
    }
    measure.status = "active";
    measure.approvedAt = input.timestamp;
    measure.approvedBy = input.operatorId;
    if (kind === "shuttle-bus" || kind === "towing") {
      measure.plan = buildContinuityPlan(incidentCase, kind, input.timestamp, input.timestamp);
    }
    affectedEntityIds = unique([...measure.stationIds, ...measure.connectionIds]);
  }
  const receipt: OperationalResponseReceipt = {
    receiptId: `OPRESP:${input.incidentId}:${input.capability}:${next.revision + 1}`,
    incidentId: input.incidentId,
    capability: input.capability,
    operatorId: input.operatorId,
    appliedAt: input.timestamp,
    affectedEntityIds,
  };
  const milestone = incidentCase.milestones.find((item) => item.capability === input.capability);
  if (milestone) {
    milestone.status = "applied";
    milestone.appliedAt = input.timestamp;
    milestone.receiptId = receipt.receiptId;
  }
  const dispatch = next.dispatches.find((item) => item.incidentId === input.incidentId && item.status === "dispatched" && item.receiptId === null);
  if (input.capability === "dispatch-maintenance" && dispatch) dispatch.receiptId = receipt.receiptId;
  const measure = next.continuityMeasures.find((item) => item.incidentId === input.incidentId && item.kind === measureKind(input.capability));
  if (measure) measure.receiptId = receipt.receiptId;
  next.receipts = [...next.receipts, receipt];
  next.revision += 1;
  next.updatedAt = input.timestamp;
  assertOperationalResponseInvariants(next);
  return { state: next, receipt };
}

function assertDurationRange(duration: OperationalDurationRange, label: string): void {
  if (![duration.minSeconds, duration.nominalSeconds, duration.maxSeconds].every((value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 86_400
  ) || duration.minSeconds > duration.nominalSeconds || duration.nominalSeconds > duration.maxSeconds) {
    throw new Error(`Invalid ${label} duration range`);
  }
}

export function assertOperationalResponseInvariants(state: OperationalResponseState): void {
  if (state.schema !== OPERATIONAL_RESPONSE_SCHEMA) throw new Error("Invalid operational response schema");
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) throw new Error("Invalid operational response revision");
  if (state.lineScada.length !== 21 || new Set(state.lineScada.map((item) => item.lineCode)).size !== 21) {
    throw new Error("Operational response must expose one SCADA state for each of the 21 lines");
  }
  const caseIds = new Set(state.incidentCases.map((item) => item.incidentId));
  if (caseIds.size !== state.incidentCases.length) throw new Error("Duplicate operational incident case");
  for (const incidentCase of state.incidentCases) {
    if (incidentCase.predictedDuration) {
      assertDurationRange(incidentCase.predictedDuration, "procedure prediction");
      if (incidentCase.predictedDuration.basis !== "mandatory-procedure-steps") {
        throw new Error("Procedure prediction must exclude optional response steps");
      }
    }
    for (const milestone of incidentCase.milestones) {
      if (milestone.status === "due" && milestone.dueBasis === null) {
        throw new Error("A due response milestone must expose its due basis");
      }
    }
  }
  for (const item of [...state.dispatches, ...state.continuityMeasures, ...state.receipts]) {
    if (!caseIds.has(item.incidentId)) throw new Error(`Orphan operational response record for ${item.incidentId}`);
  }
  for (const dispatch of state.dispatches) {
    assertDurationRange(dispatch.plan.estimatedDuration, "maintenance");
  }
  for (const measure of state.continuityMeasures) {
    if (measure.kind === "shuttle-bus" && measure.directions.join(",") !== "outbound,inbound") {
      throw new Error("A shuttle-bus measure must cover both directions");
    }
    if (measure.plan && measure.plan.kind !== measure.kind) {
      throw new Error(`Continuity plan kind mismatch for ${measure.measureId}`);
    }
    if (measure.plan?.kind === "shuttle-bus") {
      if (measure.plan.terminusStationIds.length !== 2 || measure.plan.terminusStationIds[0] === measure.plan.terminusStationIds[1]) {
        throw new Error("A shuttle-bus plan requires two distinct graph termini");
      }
      if (measure.plan.directions.map((item) => item.direction).join(",") !== "outbound,inbound") {
        throw new Error("A shuttle-bus plan requires outbound and inbound legs");
      }
      if (!Number.isSafeInteger(measure.plan.cycle.cycleIndex) || measure.plan.cycle.cycleIndex < 0) {
        throw new Error("Invalid shuttle-bus cycle index");
      }
    }
    if (measure.plan?.kind === "towing") {
      assertDurationRange(measure.plan.estimatedDuration, "towing");
    }
    if (measure.plan?.kind === "provisional-service" || measure.plan?.kind === "turnback") {
      const protectedStations = new Set(measure.plan.protectedStationIds ?? []);
      for (const segment of measure.plan.serviceSegments ?? []) {
        if (segment.terminalStationIds[0] === segment.terminalStationIds[1]) {
          throw new Error("A provisional service segment requires two distinct termini");
        }
        if (!segment.terminalStationIds.includes(segment.turnbackStationId)) {
          throw new Error("A provisional service turnback must terminate its service segment");
        }
        if (protectedStations.has(segment.turnbackStationId)) {
          throw new Error("A provisional service may not turn back inside the protected station scope");
        }
        if (segment.directions.map((direction) => direction.direction).join(",") !== "outbound,inbound") {
          throw new Error("A provisional service segment must operate in both directions");
        }
      }
    }
    if (measure.plan?.kind === "train-insertion" && ![1, -1].includes(measure.plan.direction)) {
      throw new Error("Invalid train-insertion direction");
    }
  }
}
