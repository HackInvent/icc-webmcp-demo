import {
  NATIVE_INTERSTATION_BY_ID,
  NATIVE_LINE_BY_CODE,
  NATIVE_LINE_COMPONENTS,
  NATIVE_STATION_BY_CODE,
  type NativeInterstation,
  type NativeLineCode,
} from "./nativeNetwork";
import type {
  NativeIncident,
  NativeSimulationSnapshot,
  NativeTrainState,
} from "./nativeSimulation";
import {
  estimateTractionByLoad,
  getReferenceAssignment,
  getReferenceCapacity,
  getRollingStockFamily,
} from "./rollingStock";

export type NativeRegulationAxisCell =
  | Readonly<{
      type: "station";
      id: string;
      label: string;
      primaryOccurrence: boolean;
      junction: boolean;
    }>
  | Readonly<{
      type: "interstation";
      id: string;
      label: string;
      fromStationCode: string;
      toStationCode: string;
    }>;

export type NativeRegulationLaneKind = "main" | "branch" | "detached" | "isolated";

export interface NativeRegulationLane {
  id: string;
  label: string;
  kind: NativeRegulationLaneKind;
  componentIndex: number;
  cells: readonly NativeRegulationAxisCell[];
}

export interface NativeLineSynoptic {
  lineCode: NativeLineCode;
  lanes: readonly NativeRegulationLane[];
  uniqueStationCount: number;
  uniqueInterstationCount: number;
}

export type NativeCrowdingLevel = "quiet" | "moderate" | "busy" | "high" | "critical";

export interface NativeOperationalCellCrowding {
  cellType: NativeRegulationAxisCell["type"];
  cellId: string;
  passengerPressure: number;
  referencePlaces: number;
  loadPercent: number;
  contributingTrainCount: number;
  level: NativeCrowdingLevel;
  basis: "exact-occupation" | "station-and-approaching-flow";
}

export interface NativeShiftWindow {
  name: "Early" | "Late" | "Night";
  startLabel: "06:00" | "14:00" | "22:00";
  elapsedMinutes: number;
  durationMinutes: 480;
  asOfLabel: string;
}

export interface NativeLineRegulationMetrics {
  trainCount: number;
  cumulativeDelaySeconds: number;
  productionRatePercent: number;
  crowdingPercent: number;
  punctualityPercent: number;
  estimatedEnergyIndex: number;
  estimatedShiftEnergyIndex: number;
  passengerCount: number;
  referenceCapacityPerTrain: number;
  referenceFamilyName: string;
  activeIncidentCount: number;
  highestObjectCrowdingPercent: number;
  highCrowdingObjectCount: number;
  shiftWindow: NativeShiftWindow;
}

export type NativeRegulationQueueKind = "incident" | "held-train" | "delay" | "crowding";

export interface NativeRegulationQueueItem {
  id: string;
  kind: NativeRegulationQueueKind;
  score: number;
  title: string;
  detail: string;
  evidence: string;
  trainId?: string;
  incidentId?: string;
}

type RawAxisCell =
  | Readonly<{ type: "station"; id: string; label: string; junction: boolean }>
  | Readonly<{
      type: "interstation";
      id: string;
      label: string;
      fromStationCode: string;
      toStationCode: string;
    }>;

interface RawLane {
  componentIndex: number;
  cells: readonly RawAxisCell[];
}

function stationName(stationCode: string): string {
  return NATIVE_STATION_BY_CODE.get(stationCode)?.name ?? stationCode;
}

function oppositeStation(edge: NativeInterstation, stationCode: string): string {
  return edge.fromStationCode === stationCode ? edge.toStationCode : edge.fromStationCode;
}

function laneEdgeCount(lane: RawLane): number {
  return lane.cells.filter((cell) => cell.type === "interstation").length;
}

function laneSortKey(lane: RawLane): string {
  return lane.cells.map((cell) => `${cell.type}:${cell.id}`).join("|");
}

function decomposeComponent(
  lineCode: NativeLineCode,
  componentIndex: number,
  stationCodes: readonly string[],
  interstationIds: readonly string[],
): RawLane[] {
  const edges = interstationIds.flatMap((id) => {
    const edge = NATIVE_INTERSTATION_BY_ID.get(id);
    return edge?.lineCode === lineCode ? [edge] : [];
  });
  if (edges.length === 0) {
    return stationCodes.map((stationCode) => ({
      componentIndex,
      cells: [{
        type: "station" as const,
        id: stationCode,
        label: stationName(stationCode),
        junction: false,
      }],
    }));
  }

  const adjacency = new Map<string, NativeInterstation[]>();
  for (const stationCode of stationCodes) adjacency.set(stationCode, []);
  for (const edge of edges) {
    adjacency.set(edge.fromStationCode, [...(adjacency.get(edge.fromStationCode) ?? []), edge]);
    adjacency.set(edge.toStationCode, [...(adjacency.get(edge.toStationCode) ?? []), edge]);
  }
  for (const entries of adjacency.values()) entries.sort((left, right) => left.id.localeCompare(right.id));

  const usedEdges = new Set<string>();
  const lanes: RawLane[] = [];
  const walk = (startStationCode: string, firstEdge: NativeInterstation): RawLane => {
    const cells: RawAxisCell[] = [{
      type: "station",
      id: startStationCode,
      label: stationName(startStationCode),
      junction: (adjacency.get(startStationCode)?.length ?? 0) > 2,
    }];
    let cursor = startStationCode;
    let edge: NativeInterstation | undefined = firstEdge;
    while (edge && !usedEdges.has(edge.id)) {
      usedEdges.add(edge.id);
      const next = oppositeStation(edge, cursor);
      cells.push({
        type: "interstation",
        id: edge.id,
        label: `${stationName(cursor)} — ${stationName(next)}`,
        fromStationCode: cursor,
        toStationCode: next,
      });
      cells.push({
        type: "station",
        id: next,
        label: stationName(next),
        junction: (adjacency.get(next)?.length ?? 0) > 2,
      });
      cursor = next;
      const connected = adjacency.get(cursor) ?? [];
      if (connected.length !== 2) break;
      edge = connected.find((candidate) => !usedEdges.has(candidate.id));
    }
    return { componentIndex, cells };
  };

  const boundaryStations = [...adjacency.entries()]
    .filter(([, connected]) => connected.length !== 2)
    .map(([stationCode]) => stationCode)
    .sort((left, right) => stationName(left).localeCompare(stationName(right)) || left.localeCompare(right));
  for (const stationCode of boundaryStations) {
    for (const edge of adjacency.get(stationCode) ?? []) {
      if (!usedEdges.has(edge.id)) lanes.push(walk(stationCode, edge));
    }
  }

  for (const firstEdge of [...edges].sort((left, right) => left.id.localeCompare(right.id))) {
    if (usedEdges.has(firstEdge.id)) continue;
    const start = [firstEdge.fromStationCode, firstEdge.toStationCode]
      .sort((left, right) => stationName(left).localeCompare(stationName(right)) || left.localeCompare(right))[0];
    lanes.push(walk(start, firstEdge));
  }

  return lanes.sort((left, right) =>
    laneEdgeCount(right) - laneEdgeCount(left) || laneSortKey(left).localeCompare(laneSortKey(right))
  );
}

export function buildNativeLineSynoptic(lineCode: NativeLineCode): NativeLineSynoptic {
  const line = NATIVE_LINE_BY_CODE.get(lineCode);
  if (!line) return { lineCode, lanes: [], uniqueStationCount: 0, uniqueInterstationCount: 0 };
  const components = NATIVE_LINE_COMPONENTS.get(lineCode) ?? [];
  const rawLanes = components.flatMap((component, componentIndex) =>
    decomposeComponent(
      lineCode,
      componentIndex,
      component.stationCodes,
      component.interstationIds,
    )
  );
  const seenStations = new Set<string>();
  let branchSequence = 0;
  let detachedSequence = 0;
  const lanes = rawLanes.map((rawLane, index): NativeRegulationLane => {
    const edgeCount = laneEdgeCount(rawLane);
    let kind: NativeRegulationLaneKind;
    let label: string;
    if (edgeCount === 0) {
      kind = "isolated";
      const station = rawLane.cells.find((cell) => cell.type === "station");
      label = `Detached terminus · ${station?.label ?? "native object"}`;
    } else if (rawLane.componentIndex > 0) {
      kind = "detached";
      detachedSequence += 1;
      label = `Detached section ${detachedSequence}`;
    } else if (index === 0) {
      kind = "main";
      label = "Main section";
    } else {
      kind = "branch";
      branchSequence += 1;
      label = `Branch ${branchSequence}`;
    }
    const cells = rawLane.cells.map((cell): NativeRegulationAxisCell => {
      if (cell.type === "interstation") return cell;
      const primaryOccurrence = !seenStations.has(cell.id);
      seenStations.add(cell.id);
      return { ...cell, primaryOccurrence };
    });
    return {
      id: `${lineCode}:component-${rawLane.componentIndex}:lane-${index}`,
      label,
      kind,
      componentIndex: rawLane.componentIndex,
      cells,
    };
  });
  return {
    lineCode,
    lanes,
    uniqueStationCount: line.stationCodes.length,
    uniqueInterstationCount: line.interstationIds.length,
  };
}

/** Compatibility helper for consumers that need a flattened exhaustive axis. */
export function buildNativeLineAxis(
  _snapshot: NativeSimulationSnapshot,
  lineCode: NativeLineCode,
): readonly NativeRegulationAxisCell[] {
  return buildNativeLineSynoptic(lineCode).lanes.flatMap((lane) => lane.cells);
}

export function trainsAtOperationalCell(
  trains: readonly NativeTrainState[],
  cell: Pick<NativeRegulationAxisCell, "type" | "id"> & { primaryOccurrence?: boolean },
): readonly NativeTrainState[] {
  if (cell.type === "station" && cell.primaryOccurrence === false) return [];
  return trains.filter((train) => train.location.type === cell.type && train.location.id === cell.id);
}

export function incidentsAtOperationalCell(
  incidents: readonly NativeIncident[],
  cell: Pick<NativeRegulationAxisCell, "type" | "id"> & { primaryOccurrence?: boolean },
): readonly NativeIncident[] {
  if (cell.type === "station" && cell.primaryOccurrence === false) return [];
  return incidents.filter((incident) =>
    incident.status === "active" && (
      incident.target.type === cell.type && incident.target.id === cell.id ||
      cell.type === "station" && incident.affectedStationCodes.includes(cell.id) ||
      cell.type === "interstation" && incident.affectedInterstationIds.includes(cell.id)
    )
  );
}

function crowdingLevel(loadPercent: number): NativeCrowdingLevel {
  if (loadPercent >= 110) return "critical";
  if (loadPercent >= 90) return "high";
  if (loadPercent >= 65) return "busy";
  if (loadPercent >= 35) return "moderate";
  return "quiet";
}

export function calculateOperationalCellCrowding(
  trains: readonly NativeTrainState[],
  cell: Pick<NativeRegulationAxisCell, "type" | "id"> & { primaryOccurrence?: boolean },
  lineCode: NativeLineCode,
): NativeOperationalCellCrowding {
  const lineTrains = trains.filter((train) => train.lineCode === lineCode);
  const exact = trainsAtOperationalCell(lineTrains, cell);
  const approaching = cell.type === "station" && cell.primaryOccurrence !== false
    ? lineTrains.filter((train) =>
        train.location.type === "interstation" && train.toStationCode === cell.id
      )
    : [];
  const exactPassengers = exact.reduce((sum, train) => sum + train.passengers, 0);
  const approachingPressure = approaching.reduce(
    (sum, train) => sum + Math.round(train.passengers * 0.35),
    0,
  );
  const passengerPressure = exactPassengers + approachingPressure;
  const contributingTrainCount = exact.length + approaching.length;
  const capacityPerTrain = getReferenceCapacity(lineCode);
  const referencePlaces = capacityPerTrain * Math.max(1, contributingTrainCount);
  const loadPercent = referencePlaces ? Math.round(passengerPressure / referencePlaces * 100) : 0;
  return {
    cellType: cell.type,
    cellId: cell.id,
    passengerPressure,
    referencePlaces,
    loadPercent,
    contributingTrainCount,
    level: crowdingLevel(loadPercent),
    basis: cell.type === "station" ? "station-and-approaching-flow" : "exact-occupation",
  };
}

export function deriveNativeShiftWindow(timestamp: number): NativeShiftWindow {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  const hour = part("hour");
  const minute = part("minute");
  let name: NativeShiftWindow["name"];
  let startLabel: NativeShiftWindow["startLabel"];
  let elapsedMinutes: number;
  if (hour >= 6 && hour < 14) {
    name = "Early";
    startLabel = "06:00";
    elapsedMinutes = (hour - 6) * 60 + minute;
  } else if (hour >= 14 && hour < 22) {
    name = "Late";
    startLabel = "14:00";
    elapsedMinutes = (hour - 14) * 60 + minute;
  } else {
    name = "Night";
    startLabel = "22:00";
    elapsedMinutes = hour >= 22 ? (hour - 22) * 60 + minute : (hour + 2) * 60 + minute;
  }
  return {
    name,
    startLabel,
    elapsedMinutes,
    durationMinutes: 480,
    asOfLabel: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date),
  };
}

export function calculateNativeLineMetrics(
  snapshot: NativeSimulationSnapshot,
  lineCode: NativeLineCode,
): NativeLineRegulationMetrics {
  const trains = snapshot.trains.filter((train) => train.lineCode === lineCode);
  const referenceAssignment = getReferenceAssignment(lineCode);
  const referenceFamily = getRollingStockFamily(referenceAssignment.familyId);
  const referenceCapacityPerTrain = getReferenceCapacity(lineCode);
  const passengerCount = trains.reduce((sum, train) => sum + train.passengers, 0);
  const totalCapacity = referenceCapacityPerTrain * trains.length;
  const operating = trains.filter((train) => train.status === "running" || train.status === "dwelling").length;
  const punctual = trains.filter((train) => train.delaySeconds < 180).length;
  const estimatedEnergyIndex = trains.reduce((sum, train) => sum + estimateTractionByLoad({
    familyId: referenceAssignment.familyId,
    formationUnits: referenceAssignment.referenceUnits,
    passengers: train.passengers,
  }).relativeTractionIndexPerTrainKm, 0);
  const shiftWindow = deriveNativeShiftWindow(snapshot.timestamp);
  const line = NATIVE_LINE_BY_CODE.get(lineCode);
  const crowdingObservations = [
    ...(line?.stationCodes ?? []).map((id) => calculateOperationalCellCrowding(
      trains,
      { type: "station", id, primaryOccurrence: true },
      lineCode,
    )),
    ...(line?.interstationIds ?? []).map((id) => calculateOperationalCellCrowding(
      trains,
      { type: "interstation", id },
      lineCode,
    )),
  ];
  return {
    trainCount: trains.length,
    cumulativeDelaySeconds: trains.reduce((sum, train) => sum + train.delaySeconds, 0),
    productionRatePercent: trains.length ? Math.round(operating / trains.length * 100) : 0,
    crowdingPercent: totalCapacity ? Math.round(passengerCount / totalCapacity * 100) : 0,
    punctualityPercent: trains.length ? Math.round(punctual / trains.length * 100) : 0,
    estimatedEnergyIndex: Number(estimatedEnergyIndex.toFixed(1)),
    estimatedShiftEnergyIndex: Number((estimatedEnergyIndex * shiftWindow.elapsedMinutes / 60).toFixed(1)),
    passengerCount,
    referenceCapacityPerTrain,
    referenceFamilyName: referenceFamily.name,
    activeIncidentCount: snapshot.incidents.filter(
      (incident) => incident.lineCode === lineCode && incident.status === "active",
    ).length,
    highestObjectCrowdingPercent: crowdingObservations.reduce(
      (highest, observation) => Math.max(highest, observation.loadPercent),
      0,
    ),
    highCrowdingObjectCount: crowdingObservations.filter(
      (observation) => observation.level === "high" || observation.level === "critical",
    ).length,
    shiftWindow,
  };
}

const SEVERITY_SCORE = { low: 25, medium: 45, high: 70, critical: 95 } as const;

export function buildNativeRegulationQueue(
  snapshot: NativeSimulationSnapshot,
  lineCode: NativeLineCode,
): readonly NativeRegulationQueueItem[] {
  const trains = snapshot.trains.filter((train) => train.lineCode === lineCode);
  const capacity = getReferenceCapacity(lineCode);
  const items: NativeRegulationQueueItem[] = [];

  for (const incident of snapshot.incidents.filter(
    (candidate) => candidate.lineCode === lineCode && candidate.status === "active",
  )) {
    const impacted = trains.filter((train) => incident.impactedTrainIds.includes(train.id)).length;
    items.push({
      id: `incident:${incident.id}`,
      kind: "incident",
      score: SEVERITY_SCORE[incident.severity] + Math.min(20, impacted * 5),
      title: `${incident.incidentCode} · ${incident.title}`,
      detail: `${incident.location} · ${incident.restrictionMode.replace("-", " ")}`,
      evidence: `${impacted} impacted train${impacted === 1 ? "" : "s"}; severity ${incident.severity}`,
      incidentId: incident.id,
    });
  }

  for (const train of trains) {
    const loadPercent = capacity ? Math.round(train.passengers / capacity * 100) : 0;
    if (train.status === "held" || train.status === "stopped") {
      items.push({
        id: `held:${train.id}`,
        kind: "held-train",
        score: 80 + Math.min(15, Math.round(train.delaySeconds / 60)),
        title: `${train.circulationId} requires regulation review`,
        detail: `${train.status} at ${train.location.type} ${train.location.id}`,
        evidence: `${train.delaySeconds}s delay; mission ${train.mission}`,
        trainId: train.id,
      });
    } else if (train.delaySeconds >= 180) {
      items.push({
        id: `delay:${train.id}`,
        kind: "delay",
        score: 40 + Math.min(35, Math.round(train.delaySeconds / 30)),
        title: `${train.circulationId} exceeds the 3-minute threshold`,
        detail: `${train.mission} towards ${stationName(train.destinationStationCode)}`,
        evidence: `${train.delaySeconds}s current object delay; ${train.status}`,
        trainId: train.id,
      });
    }
    if (loadPercent >= 85) {
      items.push({
        id: `crowding:${train.id}`,
        kind: "crowding",
        score: 35 + Math.min(30, loadPercent - 85),
        title: `${train.circulationId} crowding watch`,
        detail: `${train.passengers} modelled passengers against ${capacity} reference places`,
        evidence: `${loadPercent}% derived reference load`,
        trainId: train.id,
      });
    }
  }

  return items.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
