#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const GRAPH_SCHEMA = "paris-icc-rail-interdependence-graph-v2";

function usage() {
  console.log([
    "Usage:",
    "  node scripts/validate_rail_interdependence_graph.mjs [options]",
    "",
    "Options:",
    "  --graph FILE     Generated graph",
    "  --manifest FILE  Audited native manifest",
    "  --topology FILE  Full IDFM topology",
    "  --connections FILE  Audited station-connection inventory",
    "  --svg FILE       Native SVG projection target",
    "  --output FILE    Validation inventory",
    "  --help",
  ].join("\n"));
}

function parseCli(arguments_) {
  const options = {
    graph: resolve(REPOSITORY_ROOT, "artifacts/rail-interdependence-graph.json"),
    manifest: resolve(REPOSITORY_ROOT, "artifacts/ratp-network-native.json"),
    topology: resolve(REPOSITORY_ROOT, "artifacts/paris-metro-rer-topology.json"),
    connections: resolve(REPOSITORY_ROOT, "artifacts/rail-station-connections.json"),
    svg: resolve(REPOSITORY_ROOT, "artifacts/ratp-network-native.svg"),
    output: resolve(REPOSITORY_ROOT, "artifacts/rail-interdependence-graph-validation.json"),
    help: false,
  };
  const keys = new Map([
    ["--graph", "graph"],
    ["--manifest", "manifest"],
    ["--topology", "topology"],
    ["--connections", "connections"],
    ["--svg", "svg"],
    ["--output", "output"],
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else {
      const key = keys.get(argument);
      if (!key) throw new Error(`Unknown option: ${argument}`);
      const value = arguments_[index += 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      options[key] = resolve(REPOSITORY_ROOT, value);
    }
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileRecord(file) {
  const bytes = readFileSync(file);
  return {
    file: relative(REPOSITORY_ROOT, file),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function idPart(value) {
  return value
    .replace(/^IDFM:/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function lineNodeId(lineCode, stationId) {
  return `station-line:${lineCode}:${idPart(stationId)}`;
}

function transferId(stationId, leftLineCode, rightLineCode) {
  return `transfer:${idPart(stationId)}:${[leftLineCode, rightLineCode].sort().join("--")}`;
}


function stationConnectionId(leftStationId, rightStationId) {
  return `station-connection:${[idPart(leftStationId), idPart(rightStationId)].sort().join("--")}`;
}
function pairKey(lineCode, leftStationId, rightStationId) {
  return `${lineCode}|${[leftStationId, rightStationId].sort().join("|")}`;
}

function membershipEqual(left, right) {
  return left.length === right.length && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function unique(values) {
  return new Set(values).size === values.length;
}

function extractSvgIds(source) {
  const ids = [];
  const pattern = /\sid=(['"])(.*?)\1/g;
  for (const match of source.matchAll(pattern)) ids.push(match[2]);
  return ids;
}

function componentCount(nodeIds, adjacency) {
  const unseen = new Set(nodeIds);
  let count = 0;
  while (unseen.size > 0) {
    count += 1;
    const first = unseen.values().next().value;
    unseen.delete(first);
    const pending = [first];
    while (pending.length > 0) {
      const current = pending.shift();
      for (const neighbor of adjacency.get(current) ?? []) {
        if (unseen.delete(neighbor)) pending.push(neighbor);
      }
    }
  }
  return count;
}

const options = parseCli(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const graph = JSON.parse(readFileSync(options.graph, "utf8"));
const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
const topology = JSON.parse(readFileSync(options.topology, "utf8"));
const connectionInventory = JSON.parse(readFileSync(options.connections, "utf8"));
const svgSource = readFileSync(options.svg, "utf8");
const graphRecord = fileRecord(options.graph);
const manifestRecord = fileRecord(options.manifest);
const topologyRecord = fileRecord(options.topology);
const connectionInventoryRecord = fileRecord(options.connections);
const svgRecord = fileRecord(options.svg);

const lineById = new Map(graph.lines?.map((line) => [line.id, line]) ?? []);
const stationById = new Map(graph.stations?.map((station) => [station.id, station]) ?? []);
const lineNodeById = new Map(graph.lineNodes?.map((node) => [node.id, node]) ?? []);
const interstationById = new Map(graph.interstations?.map((link) => [link.id, link]) ?? []);
const transferById = new Map(graph.transfers?.map((link) => [link.id, link]) ?? []);
const stationConnectionById = new Map(graph.stationConnections?.map((link) => [link.id, link]) ?? []);
const sourceStationConnectionById = new Map(connectionInventory.connections?.map((link) => [link.id, link]) ?? []);
const svgIds = extractSvgIds(svgSource);
const svgIdSet = new Set(svgIds);

const sourceLines = topology.lines ?? [];
const sourceLineById = new Map(sourceLines.map((line) => [line.id, line]));
const sourceStationOccurrences = sourceLines.flatMap((line) =>
  line.stops.map((stop) => ({ ...stop, lineCode: line.id }))
);
const sourceStationIds = new Set(sourceStationOccurrences.map((stop) => stop.hubId));
const sourceEdges = sourceLines.flatMap((line) =>
  line.edges.map((edge) => ({ ...edge, lineCode: line.id, mode: line.mode }))
);
const sourceEdgeById = new Map(sourceEdges.map((edge) => [edge.id, edge]));
const sourceEdgeByPair = new Map(sourceEdges.map((edge) => [
  pairKey(edge.lineCode, edge.from, edge.to),
  edge,
]));

const expectedLineNodeIds = sourceStationOccurrences.map((stop) =>
  lineNodeId(stop.lineCode, stop.hubId)
);
const expectedTransferIds = [];
const sourceLinesByStation = new Map();
for (const occurrence of sourceStationOccurrences) {
  const codes = sourceLinesByStation.get(occurrence.hubId) ?? new Set();
  codes.add(occurrence.lineCode);
  sourceLinesByStation.set(occurrence.hubId, codes);
}
for (const [stationId, codesSet] of sourceLinesByStation) {
  const codes = [...codesSet].sort();
  for (let left = 0; left < codes.length; left += 1) {
    for (let right = left + 1; right < codes.length; right += 1) {
      expectedTransferIds.push(transferId(stationId, codes[left], codes[right]));
    }
  }
}

const graphAdjacency = new Map([...lineNodeById.keys()].map((nodeId) => [nodeId, new Set()]));
for (const link of graph.interstations ?? []) {
  graphAdjacency.get(link.fromNodeId)?.add(link.toNodeId);
  graphAdjacency.get(link.toNodeId)?.add(link.fromNodeId);
}
for (const link of graph.transfers ?? []) {
  graphAdjacency.get(link.leftNodeId)?.add(link.rightNodeId);
  graphAdjacency.get(link.rightNodeId)?.add(link.leftNodeId);
}
let derivedStationConnectionTraversalLinkCount = 0;
for (const link of graph.stationConnections ?? []) {
  derivedStationConnectionTraversalLinkCount += (link.fromNodeIds?.length ?? 0) * (link.toNodeIds?.length ?? 0);
  for (const fromNodeId of link.fromNodeIds ?? []) {
    for (const toNodeId of link.toNodeIds ?? []) {
      graphAdjacency.get(fromNodeId)?.add(toNodeId);
      graphAdjacency.get(toNodeId)?.add(fromNodeId);
    }
  }
}
const derivedDirectedArcCount = 2 * (
  (graph.interstations?.length ?? 0)
  + (graph.transfers?.length ?? 0)
  + derivedStationConnectionTraversalLinkCount
);
const connectedComponents = componentCount([...lineNodeById.keys()], graphAdjacency);

const lineInventory = [];
for (const line of graph.lines ?? []) {
  const nodeIds = line.lineNodeIds ?? [];
  const links = (line.interstationIds ?? []).map((id) => interstationById.get(id)).filter(Boolean);
  const adjacency = new Map(nodeIds.map((nodeId) => [nodeId, new Set()]));
  for (const link of links) {
    adjacency.get(link.fromNodeId)?.add(link.toNodeId);
    adjacency.get(link.toNodeId)?.add(link.fromNodeId);
  }
  const components = componentCount(nodeIds, adjacency);
  lineInventory.push({
    lineCode: line.id,
    stationLineNodeCount: nodeIds.length,
    interstationCount: links.length,
    connectedComponentCount: components,
    cycleRank: links.length - nodeIds.length + components,
    verdict: components === 1 ? "pass" : "fail",
  });
}

const stationFailures = [];
for (const station of graph.stations ?? []) {
  const expectedCodes = [...(sourceLinesByStation.get(station.id) ?? [])].sort();
  const expectedNodes = expectedCodes.map((lineCode) => lineNodeId(lineCode, station.id));
  const failures = [];
  if (!membershipEqual(station.lineCodes ?? [], expectedCodes)) failures.push("line-code-membership");
  if (!membershipEqual(station.lineNodeIds ?? [], expectedNodes)) failures.push("line-node-membership");
  if (!Number.isFinite(station.longitude) || !Number.isFinite(station.latitude)) failures.push("coordinates");
  if (station.interchange !== (expectedCodes.length > 1)) failures.push("interchange-flag");
  if (station.svg?.rendered && !(station.svg.objectIds ?? []).every((id) => svgIdSet.has(id))) {
    failures.push("svg-object");
  }
  if (failures.length > 0) stationFailures.push({ stationId: station.id, failures });
}

const lineNodeFailures = [];
for (const node of graph.lineNodes ?? []) {
  const station = stationById.get(node.stationId);
  const line = lineById.get(node.lineCode);
  const failures = [];
  if (!station) failures.push("station-reference");
  if (!line) failures.push("line-reference");
  if (node.id !== lineNodeId(node.lineCode, node.stationId)) failures.push("stable-id");
  if (!station?.lineCodes.includes(node.lineCode)) failures.push("station-membership");
  if (!line?.lineNodeIds.includes(node.id)) failures.push("line-membership");
  if (failures.length > 0) lineNodeFailures.push({ lineNodeId: node.id, failures });
}

const interstationFailures = [];
for (const link of graph.interstations ?? []) {
  const source = sourceEdgeById.get(link.id);
  const from = lineNodeById.get(link.fromNodeId);
  const to = lineNodeById.get(link.toNodeId);
  const line = lineById.get(link.lineCode);
  const failures = [];
  if (!source) failures.push("source-edge-reference");
  if (source && (source.lineCode !== link.lineCode || source.from !== link.fromStationId
    || source.to !== link.toStationId)) failures.push("source-edge-bijection");
  if (from?.stationId !== link.fromStationId || from?.lineCode !== link.lineCode) failures.push("from-node");
  if (to?.stationId !== link.toStationId || to?.lineCode !== link.lineCode) failures.push("to-node");
  if (!line?.interstationIds.includes(link.id)) failures.push("line-membership");
  if (!Number.isFinite(link.distanceMeters) || link.distanceMeters <= 0) failures.push("distance");
  if (!Number.isFinite(link.estimatedTravelSeconds) || link.estimatedTravelSeconds <= 0) failures.push("cost");
  if (link.svg?.rendered) {
    if (!svgIdSet.has(link.svg.interstationObjectId)) failures.push("svg-object");
    if (!(link.svg.pathIds ?? []).every((id) => svgIdSet.has(id))) failures.push("svg-path");
  } else if (link.svg?.interstationObjectId !== null || (link.svg?.pathIds ?? []).length !== 0) {
    failures.push("unrendered-projection");
  }
  if (failures.length > 0) interstationFailures.push({ interstationId: link.id, failures });
}

const transferFailures = [];
for (const link of graph.transfers ?? []) {
  const left = lineNodeById.get(link.leftNodeId);
  const right = lineNodeById.get(link.rightNodeId);
  const failures = [];
  if (left?.stationId !== link.stationId || right?.stationId !== link.stationId) failures.push("physical-station");
  if (left?.lineCode === right?.lineCode) failures.push("different-lines");
  if (link.id !== transferId(link.stationId, link.leftLineCode, link.rightLineCode)) failures.push("stable-id");
  if (!Number.isFinite(link.estimatedTransferSeconds) || link.estimatedTransferSeconds <= 0) failures.push("cost");
  if (!(link.svgStationObjectIds ?? []).every((id) => svgIdSet.has(id))) failures.push("svg-object");
  if (failures.length > 0) transferFailures.push({ transferId: link.id, failures });
}
const stationConnectionCategories = [
  "interchange-complex",
  "public-way-authorized",
  "mapped-walking-link",
];
const derivedStationConnectionCategoryCounts = Object.fromEntries(
  stationConnectionCategories.map((category) => [
    category,
    (graph.stationConnections ?? []).filter((link) => link.category === category).length,
  ]),
);
const expectedOfficialDocumentaryConnectionIds = new Set([
  stationConnectionId("IDFM:478733", "IDFM:71359"),
  stationConnectionId("IDFM:478733", "IDFM:71363"),
  stationConnectionId("IDFM:71410", "IDFM:71363"),
]);
const actualOfficialDocumentaryConnectionIds = new Set(
  (graph.stationConnections ?? [])
    .filter((link) => link.evidence?.selectionBasis === "official-documentary")
    .map((link) => link.id),
);
const stationConnectionFailures = [];
for (const link of graph.stationConnections ?? []) {
  const source = sourceStationConnectionById.get(link.id);
  const fromStation = stationById.get(link.fromStationId);
  const toStation = stationById.get(link.toStationId);
  const expectedFromNodeIds = (source?.fromLineCodes ?? []).map(
    (lineCode) => lineNodeId(lineCode, source.fromStationId),
  );
  const expectedToNodeIds = (source?.toLineCodes ?? []).map(
    (lineCode) => lineNodeId(lineCode, source.toStationId),
  );
  const failures = [];
  if (!source) failures.push("source-reference");
  if (link.sourceConnectionId !== link.id) failures.push("source-id");
  if (link.id !== stationConnectionId(link.fromStationId, link.toStationId)) failures.push("stable-id");
  if (link.fromStationId === link.toStationId || !fromStation || !toStation) failures.push("cross-station-endpoints");
  if (source && (source.fromStationId !== link.fromStationId
    || source.toStationId !== link.toStationId)) failures.push("source-endpoints");
  if (source?.category !== link.category || !stationConnectionCategories.includes(link.category)) {
    failures.push("category");
  }
  if (!membershipEqual(link.fromNodeIds ?? [], expectedFromNodeIds)) failures.push("from-node-membership");
  if (!membershipEqual(link.toNodeIds ?? [], expectedToNodeIds)) failures.push("to-node-membership");
  if (!(link.fromNodeIds ?? []).every((nodeId) => lineNodeById.get(nodeId)?.stationId === link.fromStationId)) {
    failures.push("from-node-endpoint");
  }
  if (!(link.toNodeIds ?? []).every((nodeId) => lineNodeById.get(nodeId)?.stationId === link.toStationId)) {
    failures.push("to-node-endpoint");
  }
  const expectedTraversalLinks = expectedFromNodeIds.length * expectedToNodeIds.length;
  if (link.traversalLinkCount !== expectedTraversalLinks) failures.push("traversal-link-count");
  if (!Number.isFinite(link.estimatedTransferSeconds) || link.estimatedTransferSeconds <= 0
    || link.estimatedTransferSeconds !== source?.estimatedTransferSeconds) failures.push("cost");
  if (link.bidirectional !== true || source?.bidirectional !== true) failures.push("bidirectional");
  const selectionBasis = link.evidence?.selectionBasis;
  if (selectionBasis === "reciprocal-gtfs") {
    if (link.evidence.gtfsTransfers?.directionCount !== 2
      || link.evidence.documentaryTransferEstimate !== null) failures.push("gtfs-evidence");
  } else if (selectionBasis === "official-documentary") {
    const estimate = link.evidence.documentaryTransferEstimate;
    if (link.evidence.gtfsTransfers !== null
      || !Number.isFinite(estimate?.distanceMeters) || estimate.distanceMeters <= 0
      || estimate.estimatedTransferSeconds !== link.estimatedTransferSeconds
      || !link.evidence.references?.some((reference) =>
        reference.key === "idfmPublicWayDecision" && reference.effectiveFrom === "2026-04-01"
      )) failures.push("documentary-evidence");
  } else {
    failures.push("selection-basis");
  }
  if (JSON.stringify(link.evidence) !== JSON.stringify(source?.evidence)) {
    failures.push("source-evidence");
  }
  if (!membershipEqual(link.svg?.fromStationObjectIds ?? [], fromStation?.svg?.objectIds ?? [])
    || !membershipEqual(link.svg?.toStationObjectIds ?? [], toStation?.svg?.objectIds ?? [])) {
    failures.push("svg-station-membership");
  }
  if (![...(link.svg?.fromStationObjectIds ?? []), ...(link.svg?.toStationObjectIds ?? [])]
    .every((id) => svgIdSet.has(id))) failures.push("svg-object");
  if (failures.length > 0) stationConnectionFailures.push({ stationConnectionId: link.id, failures });
}


const expectedRenderedProjectionBySvgId = new Map();
const expectedSourceProjection = new Map();
for (const rendered of manifest.renderedMap.interstations ?? []) {
  const chain = rendered.gtfsChain?.length >= 2
    ? rendered.gtfsChain
    : [rendered.fromStationCode, rendered.toStationCode];
  const graphInterstationIds = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    const key = pairKey(rendered.lineCode, chain[index], chain[index + 1]);
    const source = sourceEdgeByPair.get(key);
    if (source) {
      graphInterstationIds.push(source.id);
      expectedSourceProjection.set(source.id, rendered.svgId);
    }
  }
  expectedRenderedProjectionBySvgId.set(rendered.svgId, {
    graphInterstationIds,
    svgPathIds: rendered.pathIds,
  });
}

const projectionFailures = [];
for (const projection of graph.svgProjection?.interstationObjects ?? []) {
  const expected = expectedRenderedProjectionBySvgId.get(projection.svgInterstationId);
  const failures = [];
  if (!expected) failures.push("manifest-object");
  if (expected && !membershipEqual(projection.graphInterstationIds ?? [], expected.graphInterstationIds)) {
    failures.push("graph-membership");
  }
  if (expected && !membershipEqual(projection.svgPathIds ?? [], expected.svgPathIds)) failures.push("path-membership");
  if (!svgIdSet.has(projection.svgInterstationId)) failures.push("svg-object");
  if (failures.length > 0) projectionFailures.push({ svgInterstationId: projection.svgInterstationId, failures });
}

const renderedStationIds = new Set(manifest.renderedMap.stations.map((station) => station.code));
const renderedInterstationIds = new Set(manifest.renderedMap.interstations.map((link) => link.svgId));
const graphProjectedSourceIds = new Set(
  (graph.interstations ?? []).filter((link) => link.svg?.rendered).map((link) => link.id),
);
const graphProjectedSvgIds = new Set(
  (graph.interstations ?? []).flatMap((link) => link.svg?.interstationObjectId ?? []),
);
const expectedProjectedSourceIds = new Set(expectedSourceProjection.keys());

const checks = {
  schemas: graph.schema === GRAPH_SCHEMA
    && topology.schema === "paris-icc-metro-rer-topology-v3"
    && connectionInventory.schema === "paris-icc-rail-station-connections-v2"
    && manifest.schema === "paris-icc-native-ratp-network-v1",
  sourceHashes: graph.source?.topology?.sha256 === topologyRecord.sha256
    && graph.source?.stationConnections?.sha256 === connectionInventoryRecord.sha256
    && graph.source?.nativeManifest?.sha256 === manifestRecord.sha256
    && graph.source?.nativeSvg?.sha256 === svgRecord.sha256,
  embeddedTopologyEqualsStandalone: JSON.stringify(manifest.sourceTopology) === JSON.stringify(topology),
  declaredCountsMatchCollections: graph.counts?.lineCount === graph.lines?.length
    && graph.counts?.stationCount === graph.stations?.length
    && graph.counts?.stationLineNodeCount === graph.lineNodes?.length
    && graph.counts?.interstationLinkCount === graph.interstations?.length
    && graph.counts?.transferLinkCount === graph.transfers?.length
    && graph.counts?.stationConnectionCount === graph.stationConnections?.length
    && graph.counts?.stationConnectionTraversalLinkCount === derivedStationConnectionTraversalLinkCount,
  sourceCountsMatchGraph: topology.lineCount === graph.lines?.length
    && topology.physicalStationCount === graph.stations?.length
    && topology.stationOccurrenceCount === graph.lineNodes?.length
    && topology.interstationCount === graph.interstations?.length
    && connectionInventory.counts?.stationConnectionCount === graph.stationConnections?.length,
  uniqueLineIds: unique((graph.lines ?? []).map((line) => line.id)),
  uniqueStationIds: unique((graph.stations ?? []).map((station) => station.id)),
  uniqueLineNodeIds: unique((graph.lineNodes ?? []).map((node) => node.id))
    && membershipEqual((graph.lineNodes ?? []).map((node) => node.id), expectedLineNodeIds),
  uniqueInterstationIds: unique((graph.interstations ?? []).map((link) => link.id))
    && membershipEqual((graph.interstations ?? []).map((link) => link.id), sourceEdges.map((edge) => edge.id)),
  uniqueTransferIds: unique((graph.transfers ?? []).map((link) => link.id))
    && membershipEqual((graph.transfers ?? []).map((link) => link.id), expectedTransferIds),
  uniqueStationConnectionIds: unique((graph.stationConnections ?? []).map((link) => link.id))
    && membershipEqual((graph.stationConnections ?? []).map((link) => link.id),
      (connectionInventory.connections ?? []).map((link) => link.id)),
  stationBijection: stationById.size === sourceStationIds.size
    && [...sourceStationIds].every((id) => stationById.has(id)) && stationFailures.length === 0,
  lineNodeBijection: lineNodeFailures.length === 0,
  interstationBijection: interstationFailures.length === 0,
  transferBijection: transferFailures.length === 0,
  stationConnectionBijection: stationConnectionById.size === sourceStationConnectionById.size
    && stationConnectionFailures.length === 0,
  stationConnectionCategoryCounts: JSON.stringify(graph.counts?.stationConnectionCategoryCounts)
    === JSON.stringify(derivedStationConnectionCategoryCounts),
  stationConnectionSourceAudited: connectionInventory.validation?.verdict === "pass"
    && connectionInventory.counts?.stationConnectionCount === 28
    && connectionInventory.counts?.selectedWithReciprocalGtfsEvidence === 25
    && connectionInventory.counts?.selectedWithOfficialDocumentaryEvidence === 3
    && connectionInventory.counts?.gtfsCrossStationPairCount === 184
    && connectionInventory.counts?.deliberatelyExcludedGtfsCrossStationPairCount === 159,
  officialDocumentaryConnectionSetExact:
    actualOfficialDocumentaryConnectionIds.size === expectedOfficialDocumentaryConnectionIds.size
    && [...expectedOfficialDocumentaryConnectionIds]
      .every((id) => actualOfficialDocumentaryConnectionIds.has(id)),
  lineGraphsConnected: lineInventory.every((line) => line.verdict === "pass"),
  globalGraphConnected: connectedComponents === 1 && graph.counts?.connectedComponentCount === 1,
  directedArcCount: graph.counts?.directedTraversalArcCount === derivedDirectedArcCount
    && derivedDirectedArcCount === 1802,
  svgIdsUnique: svgIds.length === svgIdSet.size,
  renderedStationsCovered: renderedStationIds.size === manifest.renderedMap.stationCount
    && (graph.stations ?? []).filter((station) => station.svg?.rendered).length === renderedStationIds.size
    && [...renderedStationIds].every((id) => stationById.get(id)?.svg?.rendered),
  renderedInterstationsCovered: renderedInterstationIds.size === manifest.renderedMap.interstationCount
    && graphProjectedSvgIds.size === renderedInterstationIds.size
    && [...renderedInterstationIds].every((id) => graphProjectedSvgIds.has(id)),
  sourceProjectionExact: graphProjectedSourceIds.size === expectedProjectedSourceIds.size
    && [...expectedProjectedSourceIds].every((id) => graphProjectedSourceIds.has(id))
    && projectionFailures.length === 0,
  projectionCounts: graph.counts?.svgStationProjectionCount === renderedStationIds.size
    && graph.counts?.svgInterstationProjectionCount === renderedInterstationIds.size
    && graph.counts?.graphInterstationProjectedCount === graphProjectedSourceIds.size
    && graph.counts?.graphInterstationOutsideRenderedPlanCount
      === sourceEdges.length - graphProjectedSourceIds.size,
};
const verdict = Object.values(checks).every(Boolean) ? "pass" : "fail";
const report = {
  schema: "paris-icc-rail-interdependence-graph-validation-v2",
  generatedAt: new Date().toISOString(),
  verdict,
  subject: {
    graph: graphRecord,
    topology: topologyRecord,
    stationConnections: connectionInventoryRecord,
    nativeManifest: manifestRecord,
    nativeSvg: svgRecord,
  },
  summary: {
    lines: graph.lines?.length ?? 0,
    physicalStations: graph.stations?.length ?? 0,
    stationLineNodes: graph.lineNodes?.length ?? 0,
    interstations: graph.interstations?.length ?? 0,
    interchangeStations: (graph.stations ?? []).filter((station) => station.interchange).length,
    transfers: graph.transfers?.length ?? 0,
    stationConnections: graph.stationConnections?.length ?? 0,
    stationConnectionTraversalLinks: derivedStationConnectionTraversalLinkCount,
    stationConnectionCategoryCounts: derivedStationConnectionCategoryCounts,
    gtfsCrossStationPairsAudited: connectionInventory.counts?.gtfsCrossStationPairCount ?? 0,
    gtfsCrossStationPairsSelected: connectionInventory.counts?.selectedWithReciprocalGtfsEvidence ?? 0,
    officialDocumentaryPairsSelected:
      connectionInventory.counts?.selectedWithOfficialDocumentaryEvidence ?? 0,
    stationConnectionsSelected: connectionInventory.counts?.stationConnectionCount ?? 0,
    gtfsCrossStationPairsExcluded: connectionInventory.counts?.deliberatelyExcludedGtfsCrossStationPairCount ?? 0,
    directedTraversalArcs: derivedDirectedArcCount,
    connectedComponents,
    projectedStations: (graph.stations ?? []).filter((station) => station.svg?.rendered).length,
    projectedGraphInterstations: graphProjectedSourceIds.size,
    projectedSvgInterstationObjects: graphProjectedSvgIds.size,
    graphInterstationsOutsideRenderedPlan: sourceEdges.length - graphProjectedSourceIds.size,
  },
  checks,
  inventory: {
    lines: lineInventory,
    stationConnections: (graph.stationConnections ?? []).map((connection) => ({
      id: connection.id,
      category: connection.category,
      selectionBasis: connection.evidence?.selectionBasis ?? null,
      fromStationId: connection.fromStationId,
      toStationId: connection.toStationId,
      fromLineNodeCount: connection.fromNodeIds?.length ?? 0,
      toLineNodeCount: connection.toNodeIds?.length ?? 0,
      traversalLinkCount: connection.traversalLinkCount,
      estimatedTransferSeconds: connection.estimatedTransferSeconds,
      gtfsTransferRowCount: connection.evidence?.gtfsTransfers?.rowCount ?? 0,
      documentaryDistanceMeters:
        connection.evidence?.documentaryTransferEstimate?.distanceMeters ?? null,
      gtfsReciprocalDirectionCount: connection.evidence?.gtfsTransfers?.directionCount ?? 0,
      gtfsPathwayRowCount: connection.evidence?.gtfsPathways?.rowCount ?? 0,
      referenceKeys: (connection.evidence?.references ?? []).map((reference) => reference.key),
      svgEndpointObjectCount: (connection.svg?.fromStationObjectIds?.length ?? 0)
        + (connection.svg?.toStationObjectIds?.length ?? 0),
      verdict: stationConnectionFailures.some((failure) => failure.stationConnectionId === connection.id)
        ? "fail" : "pass",
    })),
    topologyCycleRank: lineInventory.reduce((sum, line) => sum + line.cycleRank, 0),
    maximumStationLineMultiplicity: Math.max(...(graph.stations ?? []).map((station) => station.lineCodes.length)),
    maximumTraversalDegree: Math.max(...[...graphAdjacency.values()].map((neighbors) => neighbors.size)),
  },
  exceptions: {
    stationFailures,
    lineNodeFailures,
    interstationFailures,
    transferFailures,
    stationConnectionFailures,
    projectionFailures,
    missingRenderedStationIds: [...renderedStationIds].filter((id) => !stationById.get(id)?.svg?.rendered),
    missingRenderedInterstationIds: [...renderedInterstationIds].filter((id) => !graphProjectedSvgIds.has(id)),
    missingProjectedSourceInterstationIds: [...expectedProjectedSourceIds].filter((id) => !graphProjectedSourceIds.has(id)),
    unexpectedProjectedSourceInterstationIds: [...graphProjectedSourceIds].filter((id) => !expectedProjectedSourceIds.has(id)),
  },
};

writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${verdict === "pass" ? "PASS" : "FAIL"} ${relative(REPOSITORY_ROOT, options.graph)}`);
console.log(JSON.stringify({ verdict, summary: report.summary, failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name) }, null, 2));
process.exitCode = verdict === "pass" ? 0 : 1;
