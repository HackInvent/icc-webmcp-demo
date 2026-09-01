import graphFixture from "../../artifacts/rail-interdependence-graph.json";
import type { NativeLineCode } from "./nativeNetwork";

export const RAIL_INTERDEPENDENCE_GRAPH_SCHEMA =
  "paris-icc-rail-interdependence-graph-v2" as const;

export type RailGraphMode = "metro" | "rer";
export type RailGraphLinkKind = "interstation" | "transfer" | "station-connection";
export type RailStationConnectionCategory = "interchange-complex" | "public-way-authorized" | "mapped-walking-link";
export type RailStationConnectionPolicy = "none" | "official-only" | "all";
export type RailImpactLevel = "direct" | "primary" | "secondary";

export interface RailGraphLine {
  id: NativeLineCode;
  routeId: string;
  label: string;
  name: string;
  mode: RailGraphMode;
  color: string;
  textColor: string;
  terminalStationIds: string[];
  lineNodeIds: string[];
  interstationIds: string[];
}

export interface RailGraphStation {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  lineCodes: NativeLineCode[];
  lineNodeIds: string[];
  interchange: boolean;
  svg: {
    rendered: boolean;
    primaryObjectId: string | null;
    objectIds: string[];
  };
}

export interface RailGraphLineNode {
  id: string;
  stationId: string;
  lineCode: NativeLineCode;
  sourceStopId: string;
}

export interface RailGraphInterstation {
  id: string;
  sourceEdgeId: string;
  lineCode: NativeLineCode;
  mode: RailGraphMode;
  fromStationId: string;
  toStationId: string;
  fromNodeId: string;
  toNodeId: string;
  bidirectional: true;
  distanceMeters: number;
  estimatedTravelSeconds: number;
  svg: {
    rendered: boolean;
    interstationObjectId: string | null;
    pathIds: string[];
    projectionRole: "direct" | "contracted-chain-member" | "outside-rendered-plan";
  };
}

export interface RailGraphTransfer {
  id: string;
  stationId: string;
  leftLineCode: NativeLineCode;
  rightLineCode: NativeLineCode;
  leftNodeId: string;
  rightNodeId: string;
  bidirectional: true;
  estimatedTransferSeconds: number;
  svgStationObjectIds: string[];
}

export interface RailGraphStationConnection {
  id: string;
  sourceConnectionId: string;
  category: RailStationConnectionCategory;
  fromStationId: string;
  toStationId: string;
  fromNodeIds: string[];
  toNodeIds: string[];
  bidirectional: true;
  estimatedTransferSeconds: number;
  traversalLinkCount: number;
  evidence: {
    selectionBasis: "reciprocal-gtfs" | "official-documentary";
    gtfsTransfers: {
      rowCount: number;
      directionCount: 2;
      minimumSeconds: number;
      medianSeconds: number;
      maximumSeconds: number;
    } | null;
    gtfsPathways: {
      rowCount: number;
      bidirectionalRowCount: number;
      modes: string[];
      minimumSeconds: number | null;
      maximumSeconds: number | null;
    } | null;
    documentaryTransferEstimate: {
      method: "geodesic-walking-plus-station-access";
      distanceMeters: number;
      walkingSpeedMetersPerSecond: number;
      stationAccessPenaltySeconds: number;
      minimumSeconds: number;
      roundingSeconds: number;
      estimatedTransferSeconds: number;
    } | null;
    references: Array<{
      key: string;
      authority: string;
      title: string;
      url: string;
      pageUpdatedAt?: string;
      edition?: string;
      decisionDate?: string;
      effectiveFrom?: string;
      pages?: number[];
    }>;
  };
  svg: {
    fromStationObjectIds: string[];
    toStationObjectIds: string[];
  };
}


export interface RailInterdependenceGraph {
  schema: typeof RAIL_INTERDEPENDENCE_GRAPH_SCHEMA;
  generatedAt: string;
  source: {
    authority: string;
    dataset: string;
    url: string;
    topology: { file: string; bytes: number; sha256: string };
    stationConnections: { file: string; bytes: number; sha256: string };
    nativeManifest: { file: string; bytes: number; sha256: string };
    nativeSvg: { file: string; sha256: string };
  };
  policy: {
    graphType: string;
    nodeModel: string;
    interstationContract: string;
    transferContract: string;
    stationConnectionContract: string;
    svgProjectionContract: string;
    costModel: {
      authority: string;
      metro: { cruiseSpeedKph: number; fixedSeconds: number; minimumSeconds: number };
      rer: { cruiseSpeedKph: number; fixedSeconds: number; minimumSeconds: number };
      defaultTransferSeconds: number;
      documentaryWalking: {
        walkingSpeedMetersPerSecond: number;
        stationAccessPenaltySeconds: number;
        minimumSeconds: number;
        roundingSeconds: number;
      };
      replaceableAtRuntime: boolean;
    };
    propagationModel: string;
  };
  counts: {
    lineCount: number;
    stationCount: number;
    stationLineNodeCount: number;
    interstationLinkCount: number;
    transferStationCount: number;
    transferLinkCount: number;
    stationConnectionCount: number;
    stationConnectionTraversalLinkCount: number;
    stationConnectionCategoryCounts: Record<RailStationConnectionCategory, number>;
    directedTraversalArcCount: number;
    connectedComponentCount: number;
    svgStationProjectionCount: number;
    svgInterstationProjectionCount: number;
    graphInterstationProjectedCount: number;
    graphInterstationOutsideRenderedPlanCount: number;
  };
  validation: {
    verdict: "pass";
    checks: Record<string, boolean>;
  };
  lines: RailGraphLine[];
  stations: RailGraphStation[];
  lineNodes: RailGraphLineNode[];
  interstations: RailGraphInterstation[];
  transfers: RailGraphTransfer[];
  stationConnections: RailGraphStationConnection[];
  svgProjection: {
    stationObjects: Array<{
      stationId: string;
      rendered: true;
      primaryObjectId: string;
      objectIds: string[];
    }>;
    interstationObjects: Array<{
      svgInterstationId: string;
      lineCode: NativeLineCode;
      fromStationId: string;
      toStationId: string;
      graphInterstationIds: string[];
      svgPathIds: string[];
    }>;
  };
}

export interface RailGraphTraversalArc {
  id: string;
  kind: RailGraphLinkKind;
  linkId: string;
  fromNodeId: string;
  toNodeId: string;
  lineCode: NativeLineCode | null;
  stationId: string | null;
  stationConnectionCategory: RailStationConnectionCategory | null;
  estimatedSeconds: number;
}

export interface RailRouteOptions {
  metric?: "estimated-time" | "fewest-links";
  maxTransfers?: number;
  transferSeconds?: number;
  transferHopPenalty?: number;
  stationConnectionPolicy?: RailStationConnectionPolicy;
  stationConnectionSeconds?: Readonly<Record<string, number>>;
  blockedStationIds?: readonly string[];
  blockedInterstationIds?: readonly string[];
  blockedStationConnectionIds?: readonly string[];
  disabledLineCodes?: readonly NativeLineCode[];
  interstationSeconds?: Readonly<Record<string, number>>;
}

export interface RailRouteStep {
  kind: RailGraphLinkKind;
  linkId: string;
  fromNodeId: string;
  toNodeId: string;
  fromStationId: string;
  toStationId: string;
  lineCode: NativeLineCode | null;
  estimatedSeconds: number;
  svgObjectIds: string[];
}

export interface RailRoute {
  fromStationId: string;
  toStationId: string;
  optimizationMetric: NonNullable<RailRouteOptions["metric"]>;
  optimizationCost: number;
  estimatedTravelSeconds: number;
  transferCount: number;
  stationIds: string[];
  lineCodes: NativeLineCode[];
  interstationIds: string[];
  transferIds: string[];
  stationConnectionIds: string[];
  steps: RailRouteStep[];
  svgStationObjectIds: string[];
  svgInterstationObjectIds: string[];
}

export interface RailImpactSeed {
  stationIds?: readonly string[];
  interstationIds?: readonly string[];
  stationConnectionIds?: readonly string[];
  lineCodes?: readonly NativeLineCode[];
}

export interface RailImpactOptions {
  maxElapsedSeconds?: number;
  maxTransfers?: number;
  transferSeconds?: number;
  stationConnectionPolicy?: RailStationConnectionPolicy;
  stationConnectionSeconds?: Readonly<Record<string, number>>;
  interstationSeconds?: Readonly<Record<string, number>>;
}

export interface RailAffectedStation {
  stationId: string;
  stationName: string;
  earliestSeconds: number;
  transferCount: number;
  level: RailImpactLevel;
  reachedLineCodes: NativeLineCode[];
  svgObjectIds: string[];
}

export interface RailAffectedLink {
  kind: RailGraphLinkKind;
  linkId: string;
  earliestSeconds: number;
  transferCount: number;
  level: RailImpactLevel;
  lineCode: NativeLineCode | null;
  stationId: string | null;
  svgObjectIds: string[];
}

export interface RailImpactEnvelope {
  model: "bounded-weighted-topological-envelope-v2";
  source: {
    stationIds: string[];
    interstationIds: string[];
    stationConnectionIds: string[];
    lineCodes: NativeLineCode[];
  };
  limits: {
    maxElapsedSeconds: number;
    maxTransfers: number;
    stationConnectionPolicy: RailStationConnectionPolicy;
  };
  affectedStations: RailAffectedStation[];
  affectedInterstations: RailAffectedLink[];
  affectedTransfers: RailAffectedLink[];
  affectedStationConnections: RailAffectedLink[];
  affectedLineCodes: NativeLineCode[];
  svgStationObjectIds: string[];
  svgInterstationObjectIds: string[];
  diagnostics: {
    reachedLineNodeCount: number;
    reachedInterstationCount: number;
    reachedTransferCount: number;
    reachedStationConnectionCount: number;
    unprojectedStationCount: number;
    unprojectedInterstationCount: number;
  };
  limitations: string[];
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid rail interdependence graph: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGraph(value: unknown): asserts value is RailInterdependenceGraph {
  invariant(isRecord(value), "root must be an object");
  invariant(value.schema === RAIL_INTERDEPENDENCE_GRAPH_SCHEMA, "unexpected schema");
  invariant(isRecord(value.counts), "counts are missing");
  invariant(value.counts.lineCount === 21, "expected 21 lines");
  invariant(value.counts.stationCount === 546, "expected 546 physical stations");
  invariant(value.counts.stationLineNodeCount === 658, "expected 658 station-line nodes");
  invariant(value.counts.interstationLinkCount === 640, "expected 640 interstations");
  invariant(value.counts.transferLinkCount === 163, "expected 163 transfers");
  invariant(value.counts.stationConnectionCount === 28, "expected 28 station connections");
  invariant(value.counts.stationConnectionTraversalLinkCount === 98, "expected 98 station-connection traversal links");
  invariant(value.counts.directedTraversalArcCount === 1802, "expected 1802 traversal arcs");
  invariant(value.counts.connectedComponentCount === 1, "graph must be connected");
  invariant(isRecord(value.validation) && value.validation.verdict === "pass", "embedded validation failed");
  invariant(Array.isArray(value.lines) && value.lines.length === value.counts.lineCount, "line collection mismatch");
  invariant(Array.isArray(value.stations) && value.stations.length === value.counts.stationCount, "station collection mismatch");
  invariant(Array.isArray(value.lineNodes) && value.lineNodes.length === value.counts.stationLineNodeCount, "line-node collection mismatch");
  invariant(Array.isArray(value.interstations) && value.interstations.length === value.counts.interstationLinkCount, "interstation collection mismatch");
  invariant(Array.isArray(value.transfers) && value.transfers.length === value.counts.transferLinkCount, "transfer collection mismatch");
  invariant(Array.isArray(value.stationConnections)
    && value.stationConnections.length === value.counts.stationConnectionCount,
  "station-connection collection mismatch");
  const categoryCounts = value.counts.stationConnectionCategoryCounts;
  invariant(isRecord(categoryCounts)
    && categoryCounts["interchange-complex"] === 8
    && categoryCounts["public-way-authorized"] === 16
    && categoryCounts["mapped-walking-link"] === 4,
  "station-connection category counts mismatch");
  for (const connection of value.stationConnections) {
    invariant(isRecord(connection), "station connection must be an object");
    invariant(isRecord(connection.evidence), "station connection evidence is missing");
    const basis = connection.evidence.selectionBasis;
    if (basis === "reciprocal-gtfs") {
      invariant(isRecord(connection.evidence.gtfsTransfers)
        && connection.evidence.gtfsTransfers.directionCount === 2
        && connection.evidence.documentaryTransferEstimate === null,
      "invalid reciprocal GTFS station-connection evidence");
    } else {
      invariant(basis === "official-documentary"
        && connection.evidence.gtfsTransfers === null
        && isRecord(connection.evidence.documentaryTransferEstimate)
        && typeof connection.evidence.documentaryTransferEstimate.distanceMeters === "number"
        && connection.evidence.documentaryTransferEstimate.distanceMeters > 0,
      "invalid official documentary station-connection evidence");
    }
  }
}

const rawGraph: unknown = graphFixture;
validateGraph(rawGraph);

export const RAIL_INTERDEPENDENCE_GRAPH: RailInterdependenceGraph = rawGraph;
export const RAIL_GRAPH_LINES: readonly RailGraphLine[] = Object.freeze(rawGraph.lines);
export const RAIL_GRAPH_STATIONS: readonly RailGraphStation[] = Object.freeze(rawGraph.stations);
export const RAIL_GRAPH_LINE_NODES: readonly RailGraphLineNode[] = Object.freeze(rawGraph.lineNodes);
export const RAIL_GRAPH_INTERSTATIONS: readonly RailGraphInterstation[] = Object.freeze(rawGraph.interstations);
export const RAIL_GRAPH_TRANSFERS: readonly RailGraphTransfer[] = Object.freeze(rawGraph.transfers);
export const RAIL_GRAPH_STATION_CONNECTIONS: readonly RailGraphStationConnection[] = Object.freeze(rawGraph.stationConnections);

export const RAIL_GRAPH_LINE_BY_CODE: ReadonlyMap<NativeLineCode, RailGraphLine> = new Map(
  RAIL_GRAPH_LINES.map((line) => [line.id, line]),
);
export const RAIL_GRAPH_STATION_BY_ID: ReadonlyMap<string, RailGraphStation> = new Map(
  RAIL_GRAPH_STATIONS.map((station) => [station.id, station]),
);
export const RAIL_GRAPH_LINE_NODE_BY_ID: ReadonlyMap<string, RailGraphLineNode> = new Map(
  RAIL_GRAPH_LINE_NODES.map((node) => [node.id, node]),
);
export const RAIL_GRAPH_INTERSTATION_BY_ID: ReadonlyMap<string, RailGraphInterstation> = new Map(
  RAIL_GRAPH_INTERSTATIONS.map((interstation) => [interstation.id, interstation]),
);
export const RAIL_GRAPH_TRANSFER_BY_ID: ReadonlyMap<string, RailGraphTransfer> = new Map(
  RAIL_GRAPH_TRANSFERS.map((transfer) => [transfer.id, transfer]),
);
export const RAIL_GRAPH_STATION_CONNECTION_BY_ID: ReadonlyMap<string, RailGraphStationConnection> = new Map(
  RAIL_GRAPH_STATION_CONNECTIONS.map((connection) => [connection.id, connection]),
);

const stationIdBySvgObjectId = new Map<string, string>();
for (const station of RAIL_GRAPH_STATIONS) {
  for (const objectId of station.svg.objectIds) stationIdBySvgObjectId.set(objectId, station.id);
}
const graphInterstationIdsBySvgObjectId = new Map(
  rawGraph.svgProjection.interstationObjects.map((projection) => [
    projection.svgInterstationId,
    Object.freeze([...projection.graphInterstationIds]),
  ] as const),
);

export function resolveRailGraphStationId(reference: string): string | undefined {
  return RAIL_GRAPH_STATION_BY_ID.has(reference)
    ? reference
    : stationIdBySvgObjectId.get(reference);
}

export function resolveRailGraphInterstationIds(reference: string): readonly string[] {
  if (RAIL_GRAPH_INTERSTATION_BY_ID.has(reference)) return [reference];
  return graphInterstationIdsBySvgObjectId.get(reference) ?? [];
}

export function resolveRailGraphStationConnectionId(reference: string): string | undefined {
  return RAIL_GRAPH_STATION_CONNECTION_BY_ID.has(reference) ? reference : undefined;
}

const traversalAdjacency = new Map<string, RailGraphTraversalArc[]>(
  RAIL_GRAPH_LINE_NODES.map((node) => [node.id, []]),
);

function addTraversalArc(arc: RailGraphTraversalArc): void {
  const arcs = traversalAdjacency.get(arc.fromNodeId);
  invariant(arcs, `unknown traversal origin ${arc.fromNodeId}`);
  arcs.push(Object.freeze(arc));
}

for (const interstation of RAIL_GRAPH_INTERSTATIONS) {
  for (const [direction, fromNodeId, toNodeId] of [
    ["forward", interstation.fromNodeId, interstation.toNodeId],
    ["reverse", interstation.toNodeId, interstation.fromNodeId],
  ] as const) {
    addTraversalArc({
      id: `arc:${interstation.id}:${direction}`,
      kind: "interstation",
      linkId: interstation.id,
      fromNodeId,
      toNodeId,
      lineCode: interstation.lineCode,
      stationId: null,
      stationConnectionCategory: null,
      estimatedSeconds: interstation.estimatedTravelSeconds,
    });
  }
}
for (const transfer of RAIL_GRAPH_TRANSFERS) {
  for (const [direction, fromNodeId, toNodeId] of [
    ["left-to-right", transfer.leftNodeId, transfer.rightNodeId],
    ["right-to-left", transfer.rightNodeId, transfer.leftNodeId],
  ] as const) {
    addTraversalArc({
      id: `arc:${transfer.id}:${direction}`,
      kind: "transfer",
      linkId: transfer.id,
      fromNodeId,
      toNodeId,
      lineCode: null,
      stationId: transfer.stationId,
      stationConnectionCategory: null,
      estimatedSeconds: transfer.estimatedTransferSeconds,
    });
  }
}
for (const connection of RAIL_GRAPH_STATION_CONNECTIONS) {
  for (const [fromIndex, fromNodeId] of connection.fromNodeIds.entries()) {
    for (const [toIndex, toNodeId] of connection.toNodeIds.entries()) {
      for (const [direction, arcFromNodeId, arcToNodeId] of [
        ["forward", fromNodeId, toNodeId],
        ["reverse", toNodeId, fromNodeId],
      ] as const) {
        addTraversalArc({
          id: `arc:${connection.id}:${fromIndex}-${toIndex}:${direction}`,
          kind: "station-connection",
          linkId: connection.id,
          fromNodeId: arcFromNodeId,
          toNodeId: arcToNodeId,
          lineCode: null,
          stationId: null,
          stationConnectionCategory: connection.category,
          estimatedSeconds: connection.estimatedTransferSeconds,
        });
      }
    }
  }
}
const derivedTraversalArcCount = [...traversalAdjacency.values()].reduce(
  (sum, arcs) => sum + arcs.length,
  0,
);
invariant(derivedTraversalArcCount === RAIL_INTERDEPENDENCE_GRAPH.counts.directedTraversalArcCount,
  `derived ${derivedTraversalArcCount} traversal arcs, expected ${RAIL_INTERDEPENDENCE_GRAPH.counts.directedTraversalArcCount}`);
for (const arcs of traversalAdjacency.values()) {
  arcs.sort((left, right) => left.id.localeCompare(right.id));
  Object.freeze(arcs);
}

export function getRailGraphNeighbors(lineNodeId: string): readonly RailGraphTraversalArc[] {
  return traversalAdjacency.get(lineNodeId) ?? [];
}

interface QueueEntry {
  key: string;
  nodeId: string;
  transfers: number;
  score: number;
}

class MinQueue {
  private readonly values: QueueEntry[] = [];

  get size(): number {
    return this.values.length;
  }

  push(entry: QueueEntry): void {
    this.values.push(entry);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareQueueEntries(this.values[parent], entry) <= 0) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = entry;
  }

  pop(): QueueEntry | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length
        && compareQueueEntries(this.values[right], this.values[left]) < 0 ? right : left;
      if (compareQueueEntries(last, this.values[child]) <= 0) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function compareQueueEntries(left: QueueEntry, right: QueueEntry): number {
  return left.score - right.score || left.transfers - right.transfers || left.key.localeCompare(right.key);
}

function stateKey(nodeId: string, transfers: number): string {
  return `${nodeId}\u0000${transfers}`;
}

function boundedInteger(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return resolved;
}

function positiveCost(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${name} must be a positive number`);
  return resolved;
}

function uniqueInOrder<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function resolveStationConnectionPolicy(
  value: RailStationConnectionPolicy | undefined,
): RailStationConnectionPolicy {
  const policy = value ?? "official-only";
  if (policy !== "none" && policy !== "official-only" && policy !== "all") {
    throw new Error("stationConnectionPolicy must be none, official-only or all");
  }
  return policy;
}

function isCorrespondenceArc(arc: RailGraphTraversalArc): boolean {
  return arc.kind === "transfer" || arc.kind === "station-connection";
}

function stationConnectionAllowed(
  arc: RailGraphTraversalArc,
  policy: RailStationConnectionPolicy,
): boolean {
  if (arc.kind !== "station-connection") return true;
  if (policy === "none") return false;
  return policy === "all" || arc.stationConnectionCategory !== "mapped-walking-link";
}

function arcEstimatedSeconds(arc: RailGraphTraversalArc, options: {
  transferSeconds?: number;
  stationConnectionSeconds?: Readonly<Record<string, number>>;
  interstationSeconds?: Readonly<Record<string, number>>;
}): number {
  if (arc.kind === "transfer") {
    return positiveCost(options.transferSeconds, arc.estimatedSeconds, "transferSeconds");
  }
  if (arc.kind === "station-connection") {
    return positiveCost(options.stationConnectionSeconds?.[arc.linkId], arc.estimatedSeconds,
      `cost for ${arc.linkId}`);
  }
  return positiveCost(options.interstationSeconds?.[arc.linkId], arc.estimatedSeconds, `cost for ${arc.linkId}`);
}

function stationForNode(nodeId: string): RailGraphStation {
  const node = RAIL_GRAPH_LINE_NODE_BY_ID.get(nodeId);
  invariant(node, `unknown line node ${nodeId}`);
  const station = RAIL_GRAPH_STATION_BY_ID.get(node.stationId);
  invariant(station, `unknown station ${node.stationId}`);
  return station;
}

function svgIdsForArc(arc: RailGraphTraversalArc): string[] {
  if (arc.kind === "interstation") {
    const objectId = RAIL_GRAPH_INTERSTATION_BY_ID.get(arc.linkId)?.svg.interstationObjectId;
    return objectId ? [objectId] : [];
  }
  if (arc.kind === "transfer") {
    return RAIL_GRAPH_TRANSFER_BY_ID.get(arc.linkId)?.svgStationObjectIds ?? [];
  }
  const connection = RAIL_GRAPH_STATION_CONNECTION_BY_ID.get(arc.linkId);
  return connection ? uniqueInOrder([
    ...connection.svg.fromStationObjectIds,
    ...connection.svg.toStationObjectIds,
  ]) : [];
}

export function findRailRoute(
  fromStationReference: string,
  toStationReference: string,
  options: RailRouteOptions = {},
): RailRoute | null {
  const fromStationId = resolveRailGraphStationId(fromStationReference);
  const toStationId = resolveRailGraphStationId(toStationReference);
  if (!fromStationId) throw new Error(`Unknown origin station: ${fromStationReference}`);
  if (!toStationId) throw new Error(`Unknown destination station: ${toStationReference}`);
  const metric = options.metric ?? "estimated-time";
  const maxTransfers = boundedInteger(options.maxTransfers, 6, "maxTransfers", 12);
  const transferHopPenalty = positiveCost(options.transferHopPenalty, 4, "transferHopPenalty");
  const stationConnectionPolicy = resolveStationConnectionPolicy(options.stationConnectionPolicy);
  const blockedStationIds = new Set((options.blockedStationIds ?? []).map((reference) => {
    const id = resolveRailGraphStationId(reference);
    if (!id) throw new Error(`Unknown blocked station: ${reference}`);
    return id;
  }));
  const blockedInterstationIds = new Set((options.blockedInterstationIds ?? []).flatMap((reference) => {
    const ids = resolveRailGraphInterstationIds(reference);
    if (ids.length === 0) throw new Error(`Unknown blocked interstation: ${reference}`);
    return ids;
  }));
  const blockedStationConnectionIds = new Set((options.blockedStationConnectionIds ?? []).map((reference) => {
    const id = resolveRailGraphStationConnectionId(reference);
    if (!id) throw new Error(`Unknown blocked station connection: ${reference}`);
    return id;
  }));
  const disabledLineCodes = new Set(options.disabledLineCodes ?? []);
  if (blockedStationIds.has(fromStationId) || blockedStationIds.has(toStationId)) return null;

  const fromStation = RAIL_GRAPH_STATION_BY_ID.get(fromStationId)!;
  const toStation = RAIL_GRAPH_STATION_BY_ID.get(toStationId)!;
  if (fromStationId === toStationId) {
    return {
      fromStationId,
      toStationId,
      optimizationMetric: metric,
      optimizationCost: 0,
      estimatedTravelSeconds: 0,
      transferCount: 0,
      stationIds: [fromStationId],
      lineCodes: [],
      interstationIds: [],
      transferIds: [],
      stationConnectionIds: [],
      steps: [],
      svgStationObjectIds: [...fromStation.svg.objectIds],
      svgInterstationObjectIds: [],
    };
  }

  const targetNodeIds = new Set(toStation.lineNodeIds.filter((nodeId) => {
    const node = RAIL_GRAPH_LINE_NODE_BY_ID.get(nodeId);
    return node && !disabledLineCodes.has(node.lineCode);
  }));
  const distances = new Map<string, number>();
  const previous = new Map<string, { key: string; arc: RailGraphTraversalArc }>();
  const queue = new MinQueue();
  for (const nodeId of fromStation.lineNodeIds) {
    const node = RAIL_GRAPH_LINE_NODE_BY_ID.get(nodeId);
    if (!node || disabledLineCodes.has(node.lineCode)) continue;
    const key = stateKey(nodeId, 0);
    distances.set(key, 0);
    queue.push({ key, nodeId, transfers: 0, score: 0 });
  }

  let target: QueueEntry | undefined;
  while (queue.size > 0) {
    const current = queue.pop();
    if (!current || current.score !== distances.get(current.key)) continue;
    if (targetNodeIds.has(current.nodeId)) {
      target = current;
      break;
    }
    for (const arc of getRailGraphNeighbors(current.nodeId)) {
      if (!stationConnectionAllowed(arc, stationConnectionPolicy)) continue;
      if (arc.kind === "station-connection" && blockedStationConnectionIds.has(arc.linkId)) continue;
      const targetNode = RAIL_GRAPH_LINE_NODE_BY_ID.get(arc.toNodeId)!;
      if (disabledLineCodes.has(targetNode.lineCode)) continue;
      if (blockedStationIds.has(targetNode.stationId)) continue;
      if (arc.kind === "interstation" && blockedInterstationIds.has(arc.linkId)) continue;
      const transfers = current.transfers + (isCorrespondenceArc(arc) ? 1 : 0);
      if (transfers > maxTransfers) continue;
      const cost = metric === "estimated-time"
        ? arcEstimatedSeconds(arc, options)
        : isCorrespondenceArc(arc) ? transferHopPenalty : 1;
      const score = current.score + cost;
      const key = stateKey(arc.toNodeId, transfers);
      const existing = distances.get(key);
      if (existing !== undefined && existing <= score) continue;
      distances.set(key, score);
      previous.set(key, { key: current.key, arc });
      queue.push({ key, nodeId: arc.toNodeId, transfers, score });
    }
  }
  if (!target) return null;

  const arcs: RailGraphTraversalArc[] = [];
  let cursor = target.key;
  while (previous.has(cursor)) {
    const step = previous.get(cursor)!;
    arcs.unshift(step.arc);
    cursor = step.key;
  }
  const steps = arcs.map((arc): RailRouteStep => ({
    kind: arc.kind,
    linkId: arc.linkId,
    fromNodeId: arc.fromNodeId,
    toNodeId: arc.toNodeId,
    fromStationId: stationForNode(arc.fromNodeId).id,
    toStationId: stationForNode(arc.toNodeId).id,
    lineCode: arc.lineCode,
    estimatedSeconds: arcEstimatedSeconds(arc, options),
    svgObjectIds: svgIdsForArc(arc),
  }));
  const stationIds = [fromStationId];
  for (const step of steps) {
    if (step.toStationId !== stationIds.at(-1)) stationIds.push(step.toStationId);
  }
  const stationSvgIds = stationIds.flatMap((stationId) =>
    RAIL_GRAPH_STATION_BY_ID.get(stationId)?.svg.objectIds ?? []
  );
  const interstationSvgIds = steps
    .filter((step) => step.kind === "interstation")
    .flatMap((step) => step.svgObjectIds);
  return {
    fromStationId,
    toStationId,
    optimizationMetric: metric,
    optimizationCost: target.score,
    estimatedTravelSeconds: steps.reduce((sum, step) => sum + step.estimatedSeconds, 0),
    transferCount: steps.filter((step) => step.kind !== "interstation").length,
    stationIds,
    lineCodes: uniqueInOrder(steps.flatMap((step) => step.lineCode ?? [])),
    interstationIds: steps.filter((step) => step.kind === "interstation").map((step) => step.linkId),
    transferIds: steps.filter((step) => step.kind === "transfer").map((step) => step.linkId),
    stationConnectionIds: steps.filter((step) => step.kind === "station-connection").map((step) => step.linkId),
    steps,
    svgStationObjectIds: uniqueInOrder(stationSvgIds),
    svgInterstationObjectIds: uniqueInOrder(interstationSvgIds),
  };
}

interface ReachedLink {
  arc: RailGraphTraversalArc;
  earliestSeconds: number;
  transferCount: number;
  direct: boolean;
}

export function analyzeRailImpact(
  seed: RailImpactSeed,
  options: RailImpactOptions = {},
): RailImpactEnvelope {
  const sourceStationIds = uniqueInOrder((seed.stationIds ?? []).map((reference) => {
    const id = resolveRailGraphStationId(reference);
    if (!id) throw new Error(`Unknown incident station: ${reference}`);
    return id;
  })).sort();
  const sourceInterstationIds = uniqueInOrder((seed.interstationIds ?? []).flatMap((reference) => {
    const ids = resolveRailGraphInterstationIds(reference);
    if (ids.length === 0) throw new Error(`Unknown incident interstation: ${reference}`);
    return ids;
  })).sort();
  const sourceStationConnectionIds = uniqueInOrder((seed.stationConnectionIds ?? []).map((reference) => {
    const id = resolveRailGraphStationConnectionId(reference);
    if (!id) throw new Error(`Unknown incident station connection: ${reference}`);
    return id;
  })).sort();
  const sourceLineCodes = uniqueInOrder(seed.lineCodes ?? []).sort();
  for (const lineCode of sourceLineCodes) {
    if (!RAIL_GRAPH_LINE_BY_CODE.has(lineCode)) throw new Error(`Unknown incident line: ${lineCode}`);
  }
  if (sourceStationIds.length + sourceInterstationIds.length + sourceStationConnectionIds.length + sourceLineCodes.length === 0) {
    throw new Error("At least one incident station, interstation, station connection or line is required");
  }
  const maxElapsedSeconds = options.maxElapsedSeconds ?? 1_800;
  if (!Number.isFinite(maxElapsedSeconds) || maxElapsedSeconds < 0 || maxElapsedSeconds > 86_400) {
    throw new Error("maxElapsedSeconds must be between 0 and 86400");
  }
  const maxTransfers = boundedInteger(options.maxTransfers, 1, "maxTransfers", 12);
  const stationConnectionPolicy = resolveStationConnectionPolicy(options.stationConnectionPolicy);
  const directStationIds = new Set(sourceStationIds);
  const directInterstationIds = new Set(sourceInterstationIds);
  const directStationConnectionIds = new Set(sourceStationConnectionIds);
  const seedNodeIds = new Set<string>();
  for (const stationId of sourceStationIds) {
    for (const nodeId of RAIL_GRAPH_STATION_BY_ID.get(stationId)!.lineNodeIds) seedNodeIds.add(nodeId);
  }
  for (const interstationId of sourceInterstationIds) {
    const interstation = RAIL_GRAPH_INTERSTATION_BY_ID.get(interstationId)!;
    seedNodeIds.add(interstation.fromNodeId);
    seedNodeIds.add(interstation.toNodeId);
    directStationIds.add(interstation.fromStationId);
    directStationIds.add(interstation.toStationId);
  }
  for (const stationConnectionId of sourceStationConnectionIds) {
    const connection = RAIL_GRAPH_STATION_CONNECTION_BY_ID.get(stationConnectionId)!;
    for (const nodeId of [...connection.fromNodeIds, ...connection.toNodeIds]) seedNodeIds.add(nodeId);
    directStationIds.add(connection.fromStationId);
    directStationIds.add(connection.toStationId);
  }
  for (const lineCode of sourceLineCodes) {
    for (const nodeId of RAIL_GRAPH_LINE_BY_CODE.get(lineCode)!.lineNodeIds) {
      seedNodeIds.add(nodeId);
      directStationIds.add(stationForNode(nodeId).id);
    }
    for (const interstationId of RAIL_GRAPH_LINE_BY_CODE.get(lineCode)!.interstationIds) {
      directInterstationIds.add(interstationId);
    }
  }

  const distances = new Map<string, number>();
  const queue = new MinQueue();
  for (const nodeId of seedNodeIds) {
    const key = stateKey(nodeId, 0);
    distances.set(key, 0);
    queue.push({ key, nodeId, transfers: 0, score: 0 });
  }
  const reachedLinks = new Map<string, ReachedLink>();
  for (const interstationId of directInterstationIds) {
    const interstation = RAIL_GRAPH_INTERSTATION_BY_ID.get(interstationId)!;
    reachedLinks.set(interstationId, {
      arc: getRailGraphNeighbors(interstation.fromNodeId).find((arc) => arc.linkId === interstationId)!,
      earliestSeconds: 0,
      transferCount: 0,
      direct: true,
    });
  }
  for (const stationConnectionId of directStationConnectionIds) {
    const connection = RAIL_GRAPH_STATION_CONNECTION_BY_ID.get(stationConnectionId)!;
    const arc = getRailGraphNeighbors(connection.fromNodeIds[0])
      .find((candidate) => candidate.linkId === stationConnectionId);
    invariant(arc, `missing traversal arc for ${stationConnectionId}`);
    reachedLinks.set(stationConnectionId, {
      arc,
      earliestSeconds: 0,
      transferCount: 0,
      direct: true,
    });
  }

  while (queue.size > 0) {
    const current = queue.pop();
    if (!current || current.score !== distances.get(current.key)) continue;
    for (const arc of getRailGraphNeighbors(current.nodeId)) {
      if (!stationConnectionAllowed(arc, stationConnectionPolicy)) continue;
      const transfers = current.transfers + (isCorrespondenceArc(arc) ? 1 : 0);
      if (transfers > maxTransfers) continue;
      const seconds = arcEstimatedSeconds(arc, options);
      const score = current.score + seconds;
      if (score > maxElapsedSeconds) continue;
      const linkTime = arc.kind === "interstation" ? current.score : score;
      const reached = reachedLinks.get(arc.linkId);
      if (!reached || linkTime < reached.earliestSeconds
        || (linkTime === reached.earliestSeconds && transfers < reached.transferCount)) {
        reachedLinks.set(arc.linkId, {
          arc,
          earliestSeconds: linkTime,
          transferCount: transfers,
          direct: directInterstationIds.has(arc.linkId) || directStationConnectionIds.has(arc.linkId),
        });
      }
      const key = stateKey(arc.toNodeId, transfers);
      const existing = distances.get(key);
      if (existing !== undefined && existing <= score) continue;
      distances.set(key, score);
      queue.push({ key, nodeId: arc.toNodeId, transfers, score });
    }
  }

  const bestByNode = new Map<string, { earliestSeconds: number; transferCount: number }>();
  for (const [key, earliestSeconds] of distances) {
    const separator = key.lastIndexOf("\u0000");
    const nodeId = key.slice(0, separator);
    const transferCount = Number(key.slice(separator + 1));
    const current = bestByNode.get(nodeId);
    if (!current || earliestSeconds < current.earliestSeconds
      || (earliestSeconds === current.earliestSeconds && transferCount < current.transferCount)) {
      bestByNode.set(nodeId, { earliestSeconds, transferCount });
    }
  }
  const bestByStation = new Map<string, {
    earliestSeconds: number;
    transferCount: number;
    lineCodes: Set<NativeLineCode>;
  }>();
  for (const [nodeId, best] of bestByNode) {
    const node = RAIL_GRAPH_LINE_NODE_BY_ID.get(nodeId)!;
    const current = bestByStation.get(node.stationId);
    if (!current) {
      bestByStation.set(node.stationId, { ...best, lineCodes: new Set([node.lineCode]) });
    } else {
      current.lineCodes.add(node.lineCode);
      if (best.earliestSeconds < current.earliestSeconds
        || (best.earliestSeconds === current.earliestSeconds && best.transferCount < current.transferCount)) {
        current.earliestSeconds = best.earliestSeconds;
        current.transferCount = best.transferCount;
      }
    }
  }
  const levelFor = (direct: boolean, transferCount: number): RailImpactLevel =>
    direct ? "direct" : transferCount === 0 ? "primary" : "secondary";
  const affectedStations = [...bestByStation]
    .map(([stationId, best]): RailAffectedStation => {
      const station = RAIL_GRAPH_STATION_BY_ID.get(stationId)!;
      return {
        stationId,
        stationName: station.name,
        earliestSeconds: best.earliestSeconds,
        transferCount: best.transferCount,
        level: levelFor(directStationIds.has(stationId), best.transferCount),
        reachedLineCodes: [...best.lineCodes].sort(),
        svgObjectIds: [...station.svg.objectIds],
      };
    })
    .sort((left, right) => left.earliestSeconds - right.earliestSeconds
      || left.stationName.localeCompare(right.stationName, "fr"));
  const affectedLinks = [...reachedLinks.values()].map((reached): RailAffectedLink => ({
    kind: reached.arc.kind,
    linkId: reached.arc.linkId,
    earliestSeconds: reached.earliestSeconds,
    transferCount: reached.transferCount,
    level: levelFor(reached.direct, reached.transferCount),
    lineCode: reached.arc.lineCode,
    stationId: reached.arc.stationId,
    svgObjectIds: svgIdsForArc(reached.arc),
  }));
  const affectedInterstations = affectedLinks
    .filter((link) => link.kind === "interstation")
    .sort((left, right) => left.earliestSeconds - right.earliestSeconds || left.linkId.localeCompare(right.linkId));
  const affectedTransfers = affectedLinks
    .filter((link) => link.kind === "transfer")
    .sort((left, right) => left.earliestSeconds - right.earliestSeconds || left.linkId.localeCompare(right.linkId));
  const affectedStationConnections = affectedLinks
    .filter((link) => link.kind === "station-connection")
    .sort((left, right) => left.earliestSeconds - right.earliestSeconds || left.linkId.localeCompare(right.linkId));
  const affectedLineCodes = uniqueInOrder([
    ...affectedStations.flatMap((station) => station.reachedLineCodes),
    ...affectedInterstations.flatMap((link) => link.lineCode ?? []),
  ]).sort();
  const svgStationObjectIds = uniqueInOrder(affectedStations.flatMap((station) => station.svgObjectIds));
  const svgInterstationObjectIds = uniqueInOrder(
    affectedInterstations.flatMap((interstation) => interstation.svgObjectIds),
  );
  return {
    model: "bounded-weighted-topological-envelope-v2",
    source: {
      stationIds: sourceStationIds,
      interstationIds: sourceInterstationIds,
      stationConnectionIds: sourceStationConnectionIds,
      lineCodes: sourceLineCodes,
    },
    limits: { maxElapsedSeconds, maxTransfers, stationConnectionPolicy },
    affectedStations,
    affectedInterstations,
    affectedTransfers,
    affectedStationConnections,
    affectedLineCodes,
    svgStationObjectIds,
    svgInterstationObjectIds,
    diagnostics: {
      reachedLineNodeCount: bestByNode.size,
      reachedInterstationCount: affectedInterstations.length,
      reachedTransferCount: affectedTransfers.length,
      reachedStationConnectionCount: affectedStationConnections.length,
      unprojectedStationCount: affectedStations.filter((station) => station.svgObjectIds.length === 0).length,
      unprojectedInterstationCount: affectedInterstations.filter((link) => link.svgObjectIds.length === 0).length,
    },
    limitations: [
      "This result is a bounded topological propagation envelope, not a delay forecast.",
      "Default travel and transfer times are deterministic heuristics and can be replaced at runtime.",
      `Cross-station traversal policy: ${stationConnectionPolicy}.`,
      "Passenger demand, rolling stock circulation, signalling and recovery actions require separate operational inputs.",
    ],
  };
}
