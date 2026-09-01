#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const GRAPH_SCHEMA = "paris-icc-rail-interdependence-graph-v2";
const EARTH_RADIUS_METERS = 6_371_000;
const DEFAULT_TRANSFER_SECONDS = 240;
const TRAVEL_MODELS = Object.freeze({
  metro: Object.freeze({ cruiseSpeedKph: 32, fixedSeconds: 30, minimumSeconds: 60 }),
  rer: Object.freeze({ cruiseSpeedKph: 55, fixedSeconds: 45, minimumSeconds: 90 }),
});

function usage() {
  console.log([
    "Usage:",
    "  node scripts/build_rail_interdependence_graph.mjs [options]",
    "",
    "Options:",
    "  --manifest FILE  Audited native SVG manifest",
    "  --topology FILE  Full IDFM Metro/RER topology",
    "  --connections FILE  Audited cross-station connection inventory",
    "  --output FILE    Generated graph JSON",
    "  --check          Verify that FILE already equals the deterministic output",
    "  --help",
  ].join("\n"));
}

function parseCli(arguments_) {
  const options = {
    manifest: resolve(REPOSITORY_ROOT, "artifacts/ratp-network-native.json"),
    topology: resolve(REPOSITORY_ROOT, "artifacts/paris-metro-rer-topology.json"),
    connections: resolve(REPOSITORY_ROOT, "artifacts/rail-station-connections.json"),
    output: resolve(REPOSITORY_ROOT, "artifacts/rail-interdependence-graph.json"),
    check: false,
    help: false,
  };
  const valueOptions = new Map([
    ["--manifest", "manifest"],
    ["--topology", "topology"],
    ["--connections", "connections"],
    ["--output", "output"],
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--check") options.check = true;
    else {
      const key = valueOptions.get(argument);
      if (!key) throw new Error(`Unknown option: ${argument}`);
      const value = arguments_[index += 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      options[key] = resolve(REPOSITORY_ROOT, value);
    }
  }
  return options;
}

function invariant(condition, message) {
  if (!condition) throw new Error(`Rail graph build invariant failed: ${message}`);
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

function pairKey(lineCode, leftStationId, rightStationId) {
  return `${lineCode}|${[leftStationId, rightStationId].sort().join("|")}`;
}

function transferId(stationId, leftLineCode, rightLineCode) {
  return `transfer:${idPart(stationId)}:${[leftLineCode, rightLineCode].sort().join("--")}`;
}

function haversineMeters(left, right) {
  const radians = (value) => value * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimatedTravelSeconds(mode, distanceMeters) {
  const model = TRAVEL_MODELS[mode];
  invariant(model, `unsupported transport mode ${mode}`);
  const movingSeconds = distanceMeters / (model.cruiseSpeedKph / 3.6);
  const seconds = Math.max(model.minimumSeconds, movingSeconds + model.fixedSeconds);
  return Math.max(5, Math.round(seconds / 5) * 5);
}

function canonicalName(occurrences, renderedStation) {
  if (renderedStation?.name) return renderedStation.name;
  const counts = new Map();
  for (const occurrence of occurrences) {
    const entry = counts.get(occurrence.name) ?? { count: 0, name: occurrence.name };
    entry.count += 1;
    counts.set(occurrence.name, entry);
  }
  return [...counts.values()].sort((left, right) =>
    right.count - left.count || left.name.localeCompare(right.name, "fr")
  )[0]?.name ?? occurrences[0]?.hubId ?? "Unknown station";
}

function connectedComponentCount(nodeIds, adjacency) {
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

function buildGraph(manifest, topology, stationConnectionInventory, sourceRecords) {
  invariant(manifest.schema === "paris-icc-native-ratp-network-v1", "unexpected native manifest schema");
  invariant(topology.schema === "paris-icc-metro-rer-topology-v3", "unexpected topology schema");
  invariant(stationConnectionInventory.schema === "paris-icc-rail-station-connections-v2",
    "unexpected station-connection inventory schema");
  invariant(stationConnectionInventory.validation?.verdict === "pass",
    "station-connection inventory is not validated");
  invariant(JSON.stringify(manifest.sourceTopology) === JSON.stringify(topology), "embedded and standalone topologies differ");
  invariant(Array.isArray(topology.lines), "topology lines are missing");
  invariant(Array.isArray(manifest.renderedMap?.stations), "rendered stations are missing");
  invariant(Array.isArray(manifest.renderedMap?.interstations), "rendered interstations are missing");

  const renderedStationById = new Map(manifest.renderedMap.stations.map((station) => [station.code, station]));
  const occurrenceByStation = new Map();
  const sourceEdgeByPair = new Map();
  const sourceEdgeIds = new Set();
  const lineCodes = new Set();
  const lineNodes = [];
  const lineNodeIds = new Set();

  for (const line of topology.lines) {
    invariant(!lineCodes.has(line.id), `duplicate line ${line.id}`);
    lineCodes.add(line.id);
    const stopIds = new Set();
    for (const stop of line.stops) {
      invariant(stop.id === stop.hubId, `${line.id} stop ${stop.id} is not normalized to its hub`);
      invariant(!stopIds.has(stop.hubId), `${line.id} repeats station ${stop.hubId}`);
      invariant(Number.isFinite(stop.longitude) && Number.isFinite(stop.latitude), `${stop.hubId} coordinates are invalid`);
      stopIds.add(stop.hubId);
      const occurrence = { ...stop, lineCode: line.id, mode: line.mode };
      occurrenceByStation.set(stop.hubId, [...(occurrenceByStation.get(stop.hubId) ?? []), occurrence]);
      const id = lineNodeId(line.id, stop.hubId);
      invariant(!lineNodeIds.has(id), `duplicate station-line node ${id}`);
      lineNodeIds.add(id);
      lineNodes.push({
        id,
        stationId: stop.hubId,
        lineCode: line.id,
        sourceStopId: stop.id,
      });
    }
    for (const edge of line.edges) {
      invariant(!sourceEdgeIds.has(edge.id), `duplicate interstation ${edge.id}`);
      invariant(stopIds.has(edge.from) && stopIds.has(edge.to), `${edge.id} endpoint is absent from ${line.id}`);
      invariant(edge.from !== edge.to, `${edge.id} is a self-loop`);
      sourceEdgeIds.add(edge.id);
      const key = pairKey(line.id, edge.from, edge.to);
      invariant(!sourceEdgeByPair.has(key), `parallel duplicate source pair ${key}`);
      sourceEdgeByPair.set(key, { ...edge, lineCode: line.id, mode: line.mode });
    }
  }

  invariant(lineCodes.size === topology.lineCount, "line count differs from topology declaration");
  invariant(lineNodes.length === topology.stationOccurrenceCount, "station occurrence count differs from topology declaration");
  invariant(occurrenceByStation.size === topology.physicalStationCount, "physical station count differs from topology declaration");
  invariant(sourceEdgeIds.size === topology.interstationCount, "interstation count differs from topology declaration");

  const svgProjectionByPair = new Map();
  const renderedInterstationProjections = [];
  for (const interstation of manifest.renderedMap.interstations) {
    const chain = interstation.gtfsChain?.length >= 2
      ? interstation.gtfsChain
      : [interstation.fromStationCode, interstation.toStationCode];
    const graphInterstationIds = [];
    for (let index = 0; index < chain.length - 1; index += 1) {
      const key = pairKey(interstation.lineCode, chain[index], chain[index + 1]);
      const sourceEdge = sourceEdgeByPair.get(key);
      invariant(sourceEdge, `${interstation.id} chain pair ${key} is absent from source topology`);
      invariant(!svgProjectionByPair.has(key), `${key} is projected by more than one SVG object`);
      const projection = {
        svgInterstationId: interstation.svgId,
        svgPathIds: [...interstation.pathIds],
        role: chain.length === 2 ? "direct" : "contracted-chain-member",
      };
      svgProjectionByPair.set(key, projection);
      graphInterstationIds.push(sourceEdge.id);
    }
    renderedInterstationProjections.push({
      svgInterstationId: interstation.svgId,
      lineCode: interstation.lineCode,
      fromStationId: interstation.fromStationCode,
      toStationId: interstation.toStationCode,
      graphInterstationIds,
      svgPathIds: [...interstation.pathIds],
    });
  }

  const stations = [...occurrenceByStation]
    .map(([stationId, occurrences]) => {
      const renderedStation = renderedStationById.get(stationId);
      const lineCodesForStation = [...new Set(occurrences.map((occurrence) => occurrence.lineCode))].sort();
      const longitude = occurrences.reduce((sum, occurrence) => sum + occurrence.longitude, 0) / occurrences.length;
      const latitude = occurrences.reduce((sum, occurrence) => sum + occurrence.latitude, 0) / occurrences.length;
      return {
        id: stationId,
        name: canonicalName(occurrences, renderedStation),
        longitude,
        latitude,
        lineCodes: lineCodesForStation,
        lineNodeIds: lineCodesForStation.map((lineCode) => lineNodeId(lineCode, stationId)),
        interchange: lineCodesForStation.length > 1,
        svg: renderedStation ? {
          rendered: true,
          primaryObjectId: renderedStation.svgId,
          objectIds: [...new Set([renderedStation.svgId, ...(renderedStation.visual?.componentIds ?? [])])],
        } : {
          rendered: false,
          primaryObjectId: null,
          objectIds: [],
        },
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const stationById = new Map(stations.map((station) => [station.id, station]));

  for (const renderedStationId of renderedStationById.keys()) {
    invariant(stationById.has(renderedStationId), `rendered station ${renderedStationId} is absent from source topology`);
  }

  const interstations = [];
  for (const line of topology.lines) {
    for (const edge of line.edges) {
      const from = stationById.get(edge.from);
      const to = stationById.get(edge.to);
      invariant(from && to, `${edge.id} station metadata is missing`);
      const distanceMeters = Math.round(haversineMeters(from, to));
      invariant(distanceMeters > 0, `${edge.id} has zero geographic length`);
      const projection = svgProjectionByPair.get(pairKey(line.id, edge.from, edge.to));
      interstations.push({
        id: edge.id,
        sourceEdgeId: edge.id,
        lineCode: line.id,
        mode: line.mode,
        fromStationId: edge.from,
        toStationId: edge.to,
        fromNodeId: lineNodeId(line.id, edge.from),
        toNodeId: lineNodeId(line.id, edge.to),
        bidirectional: true,
        distanceMeters,
        estimatedTravelSeconds: estimatedTravelSeconds(line.mode, distanceMeters),
        svg: projection ? {
          rendered: true,
          interstationObjectId: projection.svgInterstationId,
          pathIds: projection.svgPathIds,
          projectionRole: projection.role,
        } : {
          rendered: false,
          interstationObjectId: null,
          pathIds: [],
          projectionRole: "outside-rendered-plan",
        },
      });
    }
  }
  interstations.sort((left, right) => left.id.localeCompare(right.id));

  const transfers = [];
  for (const station of stations) {
    for (let leftIndex = 0; leftIndex < station.lineCodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < station.lineCodes.length; rightIndex += 1) {
        const leftLineCode = station.lineCodes[leftIndex];
        const rightLineCode = station.lineCodes[rightIndex];
        transfers.push({
          id: transferId(station.id, leftLineCode, rightLineCode),
          stationId: station.id,
          leftLineCode,
          rightLineCode,
          leftNodeId: lineNodeId(leftLineCode, station.id),
          rightNodeId: lineNodeId(rightLineCode, station.id),
          bidirectional: true,
          estimatedTransferSeconds: DEFAULT_TRANSFER_SECONDS,
          svgStationObjectIds: station.svg.objectIds,
        });
      }
    }
  }
  transfers.sort((left, right) => left.id.localeCompare(right.id));

  const allowedConnectionCategories = new Set([
    "interchange-complex",
    "public-way-authorized",
    "mapped-walking-link",
  ]);
  const stationConnections = stationConnectionInventory.connections.map((connection) => {
    const fromStation = stationById.get(connection.fromStationId);
    const toStation = stationById.get(connection.toStationId);
    invariant(fromStation && toStation, `${connection.id} endpoint is absent from topology`);
    invariant(fromStation.id !== toStation.id, `${connection.id} is not cross-station`);
    invariant(allowedConnectionCategories.has(connection.category),
      `${connection.id} has unsupported category ${connection.category}`);
    invariant(JSON.stringify(connection.fromLineCodes) === JSON.stringify(fromStation.lineCodes),
      `${connection.id} from-line membership differs from topology`);
    invariant(JSON.stringify(connection.toLineCodes) === JSON.stringify(toStation.lineCodes),
      `${connection.id} to-line membership differs from topology`);
    invariant(Number.isFinite(connection.estimatedTransferSeconds)
      && connection.estimatedTransferSeconds > 0, `${connection.id} has an invalid duration`);
    const selectionBasis = connection.evidence?.selectionBasis;
    const reciprocalGtfsEvidenceValid = selectionBasis === "reciprocal-gtfs"
      && connection.evidence.gtfsTransfers?.directionCount === 2
      && connection.evidence.documentaryTransferEstimate === null;
    const officialDocumentaryEvidenceValid = selectionBasis === "official-documentary"
      && connection.evidence.gtfsTransfers === null
      && connection.evidence.documentaryTransferEstimate?.distanceMeters > 0
      && connection.evidence.documentaryTransferEstimate.estimatedTransferSeconds
        === connection.estimatedTransferSeconds
      && connection.evidence.references?.some((reference) =>
        reference.key === "idfmPublicWayDecision"
      );
    invariant(reciprocalGtfsEvidenceValid || officialDocumentaryEvidenceValid,
      `${connection.id} lacks admissible connection evidence`);
    return {
      id: connection.id,
      sourceConnectionId: connection.id,
      category: connection.category,
      fromStationId: fromStation.id,
      toStationId: toStation.id,
      fromNodeIds: [...fromStation.lineNodeIds],
      toNodeIds: [...toStation.lineNodeIds],
      bidirectional: true,
      estimatedTransferSeconds: connection.estimatedTransferSeconds,
      traversalLinkCount: fromStation.lineNodeIds.length * toStation.lineNodeIds.length,
      evidence: connection.evidence,
      svg: {
        fromStationObjectIds: [...fromStation.svg.objectIds],
        toStationObjectIds: [...toStation.svg.objectIds],
      },
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  invariant(stationConnections.length === stationConnectionInventory.counts.stationConnectionCount,
    "station-connection count differs from inventory declaration");
  const stationConnectionTraversalLinkCount = stationConnections.reduce(
    (sum, connection) => sum + connection.traversalLinkCount,
    0,
  );
  lineNodes.sort((left, right) => left.id.localeCompare(right.id));

  const interstationByLine = new Map([...lineCodes].map((lineCode) => [lineCode, []]));
  for (const interstation of interstations) interstationByLine.get(interstation.lineCode).push(interstation.id);
  const lineNodeByLine = new Map([...lineCodes].map((lineCode) => [lineCode, []]));
  for (const lineNode of lineNodes) lineNodeByLine.get(lineNode.lineCode).push(lineNode.id);
  const lines = topology.lines.map((line) => ({
    id: line.id,
    routeId: line.routeId,
    label: line.label,
    name: line.name,
    mode: line.mode,
    color: line.color,
    textColor: line.textColor,
    terminalStationIds: [...line.terminalStopIds],
    lineNodeIds: [...lineNodeByLine.get(line.id)].sort(),
    interstationIds: [...interstationByLine.get(line.id)].sort(),
  }));

  const adjacency = new Map(lineNodes.map((node) => [node.id, new Set()]));
  for (const interstation of interstations) {
    adjacency.get(interstation.fromNodeId).add(interstation.toNodeId);
    adjacency.get(interstation.toNodeId).add(interstation.fromNodeId);
  }
  for (const transfer of transfers) {
    adjacency.get(transfer.leftNodeId).add(transfer.rightNodeId);
    adjacency.get(transfer.rightNodeId).add(transfer.leftNodeId);
  }
  for (const connection of stationConnections) {
    for (const fromNodeId of connection.fromNodeIds) {
      for (const toNodeId of connection.toNodeIds) {
        adjacency.get(fromNodeId).add(toNodeId);
        adjacency.get(toNodeId).add(fromNodeId);
      }
    }
  }
  const connectedComponents = connectedComponentCount(lineNodeIds, adjacency);
  const projectedInterstationCount = interstations.filter((interstation) => interstation.svg.rendered).length;
  const renderedStationCount = stations.filter((station) => station.svg.rendered).length;
  const interchangeStationCount = stations.filter((station) => station.interchange).length;
  const counts = {
    lineCount: lines.length,
    stationCount: stations.length,
    stationLineNodeCount: lineNodes.length,
    interstationLinkCount: interstations.length,
    transferStationCount: interchangeStationCount,
    transferLinkCount: transfers.length,
    stationConnectionCount: stationConnections.length,
    stationConnectionTraversalLinkCount,
    stationConnectionCategoryCounts: stationConnectionInventory.counts.categoryCounts,
    directedTraversalArcCount: 2 * (interstations.length + transfers.length + stationConnectionTraversalLinkCount),
    connectedComponentCount: connectedComponents,
    svgStationProjectionCount: renderedStationCount,
    svgInterstationProjectionCount: renderedInterstationProjections.length,
    graphInterstationProjectedCount: projectedInterstationCount,
    graphInterstationOutsideRenderedPlanCount: interstations.length - projectedInterstationCount,
  };

  const checks = {
    topologyCountsMatch: lines.length === topology.lineCount
      && stations.length === topology.physicalStationCount
      && lineNodes.length === topology.stationOccurrenceCount
      && interstations.length === topology.interstationCount,
    allStationLineNodesUnique: lineNodeIds.size === lineNodes.length,
    allInterstationIdsUnique: new Set(interstations.map((item) => item.id)).size === interstations.length,
    allTransferIdsUnique: new Set(transfers.map((item) => item.id)).size === transfers.length,
    allStationConnectionIdsUnique: new Set(stationConnections.map((item) => item.id)).size === stationConnections.length,
    stationConnectionInventoryBijection: stationConnections.length === stationConnectionInventory.connections.length
      && stationConnections.every((item) => stationConnectionInventory.connections.some((source) => source.id === item.id)),
    allInterstationEndpointsExist: interstations.every((item) =>
      lineNodeIds.has(item.fromNodeId) && lineNodeIds.has(item.toNodeId)
    ),
    allTransfersStayInsideStation: transfers.every((item) => {
      const left = lineNodes.find((node) => node.id === item.leftNodeId);
      const right = lineNodes.find((node) => node.id === item.rightNodeId);
      return left?.stationId === item.stationId && right?.stationId === item.stationId
        && left.lineCode !== right.lineCode;
    }),
    allStationConnectionsJoinDifferentStations: stationConnections.every((item) =>
      item.fromStationId !== item.toStationId
      && item.fromNodeIds.every((nodeId) => lineNodes.find((node) => node.id === nodeId)?.stationId === item.fromStationId)
      && item.toNodeIds.every((nodeId) => lineNodes.find((node) => node.id === nodeId)?.stationId === item.toStationId)
      && item.traversalLinkCount === item.fromNodeIds.length * item.toNodeIds.length
    ),
    allRenderedStationsProjected: renderedStationCount === manifest.renderedMap.stationCount,
    allRenderedInterstationsProjected: renderedInterstationProjections.length === manifest.renderedMap.interstationCount
      && renderedInterstationProjections.every((projection) => projection.graphInterstationIds.length > 0),
    graphIsConnectedThroughRailAndConnections: connectedComponents === 1,
  };
  invariant(Object.values(checks).every(Boolean), `generated checks failed: ${JSON.stringify(checks)}`);

  return {
    schema: GRAPH_SCHEMA,
    generatedAt: new Date(Math.max(Date.parse(topology.generatedAt), Date.parse(stationConnectionInventory.generatedAt))).toISOString(),
    source: {
      authority: topology.source.authority,
      dataset: topology.source.dataset,
      url: topology.source.url,
      topology: sourceRecords.topology,
      stationConnections: sourceRecords.connections,
      nativeManifest: sourceRecords.manifest,
      nativeSvg: {
        file: manifest.svg.file,
        sha256: manifest.svg.sha256,
      },
    },
    policy: {
      graphType: "typed-undirected-multigraph-with-derived-directed-traversal-arcs",
      nodeModel: "station-line nodes grouped by physical IDFM stations",
      interstationContract: "Every interstation belongs to exactly one line and joins two station-line nodes on that line.",
      transferContract: "Every transfer joins two different line nodes at the same physical station.",
      stationConnectionContract: "Every selected cross-station connection is documented and expands to the Cartesian product of its endpoint line nodes; evidence is reciprocal GTFS or an explicit current IDFM decision.",
      svgProjectionContract: "Operational links outside the plan remain navigable; rendered links reference native SVG objects without adding overlay geometry.",
      costModel: {
        authority: "deterministic navigation heuristic, not a timetable prediction",
        metro: TRAVEL_MODELS.metro,
        rer: TRAVEL_MODELS.rer,
        defaultTransferSeconds: DEFAULT_TRANSFER_SECONDS,
        documentaryWalking: stationConnectionInventory.policy.documentaryWalkingModel,
        replaceableAtRuntime: true,
      },
      propagationModel: "bounded weighted topological envelope; operational causality must be supplied by the incident scenario",
    },
    counts,
    validation: {
      verdict: "pass",
      checks,
    },
    lines,
    stations,
    lineNodes,
    interstations,
    transfers,
    stationConnections,
    svgProjection: {
      stationObjects: stations
        .filter((station) => station.svg.rendered)
        .map((station) => ({ stationId: station.id, ...station.svg })),
      interstationObjects: renderedInterstationProjections,
    },
  };
}

const options = parseCli(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
const topology = JSON.parse(readFileSync(options.topology, "utf8"));
const stationConnectionInventory = JSON.parse(readFileSync(options.connections, "utf8"));
const graph = buildGraph(manifest, topology, stationConnectionInventory, {
  manifest: fileRecord(options.manifest),
  topology: fileRecord(options.topology),
  connections: fileRecord(options.connections),
});
const output = `${JSON.stringify(graph, null, 2)}\n`;

if (options.check) {
  const current = readFileSync(options.output, "utf8");
  invariant(current === output, `${relative(REPOSITORY_ROOT, options.output)} is stale; rebuild it`);
  console.log(`PASS ${relative(REPOSITORY_ROOT, options.output)} is deterministic and current`);
} else {
  writeFileSync(options.output, output);
  console.log(JSON.stringify({
    status: "written",
    output: relative(REPOSITORY_ROOT, options.output),
    sha256: sha256(Buffer.from(output)),
    counts: graph.counts,
  }, null, 2));
}
