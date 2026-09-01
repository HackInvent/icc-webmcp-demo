#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const SCHEMA = "paris-icc-rail-station-connections-v2";
const GTFS_URL = "https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip";
const EARTH_RADIUS_METERS = 6_371_000;
const DOCUMENTARY_WALKING_MODEL = Object.freeze({
  walkingSpeedMetersPerSecond: 1.2,
  stationAccessPenaltySeconds: 120,
  minimumSeconds: 180,
  roundingSeconds: 5,
});

const REFERENCES = Object.freeze({
  idfmPublicWay: Object.freeze({
    authority: "Ile-de-France Mobilites",
    title: "Regles de correspondances et correspondances par la voie publique",
    url: "https://www.iledefrance-mobilites.fr/correspondance-voie-publique",
    pageUpdatedAt: "2026-02-20",
  }),
  idfmPublicWayDecision: Object.freeze({
    authority: "Ile-de-France Mobilites",
    title: "Deliberation 20251017-192 - ajout de nouvelles correspondances par la voie publique",
    url: "https://www.iledefrance-mobilites.fr/medias/portail-idfm/aSQ1g2GnmrmGqKoq_RAA166-1.pdf",
    decisionDate: "2025-10-17",
    effectiveFrom: "2026-04-01",
    pages: [57, 58],
  }),
  ratpNetworkPlan: Object.freeze({
    authority: "RATP",
    title: "Plan Paris schematique",
    url: "https://www.ratp.fr/informer/picts/plans/pdf/reseaux/metro.pdf",
    edition: "PLAN_PARIS_SCHEMATIQUE_SANS_CARROYAGE_01_2026",
  }),
  ratpCluny: Object.freeze({
    authority: "RATP",
    title: "Cluny - La Sorbonne, correspondance avec Saint-Michel - Notre-Dame",
    url: "https://www.ratp.fr/en/decouvrir/coulisses/au-quotidien/un-jour-une-station-cluny-la-sorbonne-tout-feu-tout-flamme",
    pageUpdatedAt: "2026-07-10",
  }),
});

// This is an explicit allow-list. transfers.txt contains many walking-proximity
// pairs between ordinary neighboring stations; importing every row would create
// false rail dependencies. Most pairs below are required to have reciprocal
// GTFS transfer evidence. The three `official-documentary` exceptions were
// activated by IDFM on 1 April 2026 but are absent from the current GTFS
// cross-station transfer rows; the decision names each pair explicitly.
const CONNECTION_REGISTRY = Object.freeze([
  ["IDFM:474151", "IDFM:71264", "interchange-complex", ["ratpNetworkPlan"]],
  ["IDFM:474151", "IDFM:73794", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:73619", "IDFM:73620", "interchange-complex", ["ratpCluny", "ratpNetworkPlan"]],
  ["IDFM:478733", "IDFM:71410", "interchange-complex", ["ratpNetworkPlan"]],
  ["IDFM:71410", "IDFM:71434", "interchange-complex", ["ratpNetworkPlan"]],
  ["IDFM:474149", "IDFM:71359", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:71359", "IDFM:71410", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:478733", "IDFM:71359", "public-way-authorized", ["idfmPublicWay", "idfmPublicWayDecision"], "official-documentary"],
  ["IDFM:478733", "IDFM:71363", "public-way-authorized", ["idfmPublicWay", "idfmPublicWayDecision"], "official-documentary"],
  ["IDFM:71410", "IDFM:71363", "public-way-authorized", ["idfmPublicWay", "idfmPublicWayDecision"], "official-documentary"],
  ["IDFM:482368", "IDFM:71370", "interchange-complex", ["ratpNetworkPlan"]],
  ["IDFM:71370", "IDFM:73690", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:478926", "IDFM:71337", "interchange-complex", ["ratpNetworkPlan"]],
  ["IDFM:478926", "IDFM:482368", "interchange-complex", ["ratpNetworkPlan"]],
  ["IDFM:71370", "IDFM:73688", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:482368", "IDFM:73688", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:482368", "IDFM:71337", "interchange-complex", ["ratpNetworkPlan"]],
  ["IDFM:478926", "IDFM:73688", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:478926", "IDFM:71370", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:473829", "IDFM:73844", "mapped-walking-link", ["ratpNetworkPlan"]],
  ["IDFM:474150", "IDFM:71229", "mapped-walking-link", ["ratpNetworkPlan"]],
  ["IDFM:71286", "IDFM:71292", "mapped-walking-link", ["ratpNetworkPlan"]],
  ["IDFM:474152", "IDFM:71321", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:71269", "IDFM:71270", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:492980", "IDFM:71290", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:71637", "IDFM:73626", "mapped-walking-link", ["ratpNetworkPlan"]],
  ["IDFM:488087", "IDFM:70945", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
  ["IDFM:490784", "IDFM:72206", "public-way-authorized", ["idfmPublicWay", "ratpNetworkPlan"]],
]);

function usage() {
  console.log([
    "Usage:",
    "  node scripts/build_rail_station_connections.mjs --gtfs FILE [options]",
    "",
    "Options:",
    "  --gtfs FILE      IDFM GTFS ZIP to audit",
    "  --topology FILE  Metro/RER topology used by the graph",
    "  --output FILE    Compact audited connection inventory",
    "  --check          Compare the deterministic result with the existing output",
    "  --help",
  ].join("\n"));
}

function parseCli(arguments_) {
  const options = {
    gtfs: null,
    topology: resolve(REPOSITORY_ROOT, "artifacts/paris-metro-rer-topology.json"),
    output: resolve(REPOSITORY_ROOT, "artifacts/rail-station-connections.json"),
    check: false,
    help: false,
  };
  const valueOptions = new Map([
    ["--gtfs", "gtfs"],
    ["--topology", "topology"],
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
  if (!condition) throw new Error(`Rail station-connection invariant failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.replace(/\r$/, ""));
  return cells;
}

function unzipEntry(zipFile, entryName) {
  const result = spawnSync("unzip", ["-p", zipFile, entryName], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  invariant(result.status === 0, `cannot read ${entryName} from ${zipFile}: ${result.stderr}`);
  return result.stdout;
}

function readCsv(source) {
  const lines = source.split("\n").filter(Boolean);
  const headers = parseCsvLine(lines.shift() ?? "");
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function stationPairKey(leftStationId, rightStationId) {
  return [leftStationId, rightStationId].sort().join("|");
}

function stationConnectionId(leftStationId, rightStationId) {
  const idPart = (value) => value.replace(/^IDFM:/, "").replace(/[^A-Za-z0-9]+/g, "-");
  return `station-connection:${[idPart(leftStationId), idPart(rightStationId)].sort().join("--")}`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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

function documentaryWalkingEstimate(fromStation, toStation) {
  const distanceMeters = Math.round(haversineMeters(fromStation, toStation));
  const rawSeconds = distanceMeters / DOCUMENTARY_WALKING_MODEL.walkingSpeedMetersPerSecond
    + DOCUMENTARY_WALKING_MODEL.stationAccessPenaltySeconds;
  const estimatedTransferSeconds = Math.max(
    DOCUMENTARY_WALKING_MODEL.minimumSeconds,
    Math.round(rawSeconds / DOCUMENTARY_WALKING_MODEL.roundingSeconds)
      * DOCUMENTARY_WALKING_MODEL.roundingSeconds,
  );
  return {
    method: "geodesic-walking-plus-station-access",
    distanceMeters,
    ...DOCUMENTARY_WALKING_MODEL,
    estimatedTransferSeconds,
  };
}

function buildInventory(gtfsZip, topology, generatedAt) {
  invariant(topology.schema === "paris-icc-metro-rer-topology-v3", "unexpected topology schema");
  const stationById = new Map();
  for (const line of topology.lines) {
    for (const stop of line.stops) {
      const station = stationById.get(stop.hubId) ?? {
        id: stop.hubId,
        name: stop.name,
        longitude: stop.longitude,
        latitude: stop.latitude,
        lineCodes: new Set(),
      };
      station.lineCodes.add(line.id);
      stationById.set(stop.hubId, station);
    }
  }
  invariant(stationById.size === topology.physicalStationCount, "topology physical-station count mismatch");

  const gtfsSources = {
    stops: unzipEntry(gtfsZip, "stops.txt"),
    transfers: unzipEntry(gtfsZip, "transfers.txt"),
    pathways: unzipEntry(gtfsZip, "pathways.txt"),
  };
  const stops = new Map(readCsv(gtfsSources.stops).map((stop) => [stop.stop_id, stop]));
  const rootCache = new Map();
  function graphStationId(stopId) {
    if (rootCache.has(stopId)) return rootCache.get(stopId);
    const visited = new Set();
    let currentId = stopId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      if (stationById.has(currentId)) {
        for (const id of visited) rootCache.set(id, currentId);
        return currentId;
      }
      currentId = stops.get(currentId)?.parent_station ?? "";
    }
    for (const id of visited) rootCache.set(id, null);
    return null;
  }

  const transferEvidenceByPair = new Map();
  let gtfsTransferRowsInsideGraph = 0;
  let gtfsSameStationTransferRows = 0;
  for (const transfer of readCsv(gtfsSources.transfers)) {
    const fromStationId = graphStationId(transfer.from_stop_id);
    const toStationId = graphStationId(transfer.to_stop_id);
    if (!fromStationId || !toStationId) continue;
    gtfsTransferRowsInsideGraph += 1;
    if (fromStationId === toStationId) {
      gtfsSameStationTransferRows += 1;
      continue;
    }
    const key = stationPairKey(fromStationId, toStationId);
    const evidence = transferEvidenceByPair.get(key) ?? {
      rowCount: 0,
      directions: new Set(),
      minimumTransferSeconds: [],
    };
    evidence.rowCount += 1;
    evidence.directions.add(`${fromStationId}>${toStationId}`);
    const seconds = Number(transfer.min_transfer_time);
    if (Number.isFinite(seconds) && seconds > 0) evidence.minimumTransferSeconds.push(seconds);
    transferEvidenceByPair.set(key, evidence);
  }

  const pathwayEvidenceByPair = new Map();
  for (const pathway of readCsv(gtfsSources.pathways)) {
    const fromStationId = graphStationId(pathway.from_stop_id);
    const toStationId = graphStationId(pathway.to_stop_id);
    if (!fromStationId || !toStationId || fromStationId === toStationId) continue;
    const key = stationPairKey(fromStationId, toStationId);
    const evidence = pathwayEvidenceByPair.get(key) ?? {
      rowCount: 0,
      bidirectionalRowCount: 0,
      modes: new Set(),
      traversalSeconds: [],
    };
    evidence.rowCount += 1;
    if (pathway.is_bidirectional === "1") evidence.bidirectionalRowCount += 1;
    evidence.modes.add(pathway.pathway_mode);
    const seconds = Number(pathway.traversal_time);
    if (Number.isFinite(seconds) && seconds > 0) evidence.traversalSeconds.push(seconds);
    pathwayEvidenceByPair.set(key, evidence);
  }

  const connections = CONNECTION_REGISTRY.map(([
    leftId,
    rightId,
    category,
    referenceKeys,
    requestedSelectionBasis = "reciprocal-gtfs",
  ]) => {
    const [fromStationId, toStationId] = [leftId, rightId].sort();
    const fromStation = stationById.get(fromStationId);
    const toStation = stationById.get(toStationId);
    invariant(fromStation && toStation, `${leftId}<->${rightId} is absent from topology`);
    invariant(fromStationId !== toStationId, `${leftId}<->${rightId} is not cross-station`);
    const transferEvidence = transferEvidenceByPair.get(stationPairKey(leftId, rightId));
    invariant(requestedSelectionBasis === "reciprocal-gtfs"
      || requestedSelectionBasis === "official-documentary",
    `${leftId}<->${rightId} has unsupported selection basis ${requestedSelectionBasis}`);
    if (requestedSelectionBasis === "reciprocal-gtfs") {
      invariant(transferEvidence?.rowCount > 0, `${leftId}<->${rightId} has no GTFS transfer evidence`);
      invariant(transferEvidence.directions.size === 2, `${leftId}<->${rightId} is not reciprocal in GTFS`);
      invariant(transferEvidence.minimumTransferSeconds.length === transferEvidence.rowCount,
        `${leftId}<->${rightId} has an invalid transfer duration`);
    } else {
      invariant(!transferEvidence, `${leftId}<->${rightId} now has GTFS evidence; update its selection basis`);
      invariant(referenceKeys.includes("idfmPublicWayDecision"),
        `${leftId}<->${rightId} lacks the official decision reference`);
    }
    const pathwayEvidence = pathwayEvidenceByPair.get(stationPairKey(leftId, rightId));
    const transferSeconds = transferEvidence?.minimumTransferSeconds ?? [];
    const documentaryEstimate = requestedSelectionBasis === "official-documentary"
      ? documentaryWalkingEstimate(fromStation, toStation)
      : null;
    const estimatedTransferSeconds = documentaryEstimate?.estimatedTransferSeconds
      ?? Math.max(30, Math.round(median(transferSeconds) / 5) * 5);
    return {
      id: stationConnectionId(fromStationId, toStationId),
      category,
      fromStationId,
      toStationId,
      fromStationName: fromStation.name,
      toStationName: toStation.name,
      fromLineCodes: [...fromStation.lineCodes].sort(),
      toLineCodes: [...toStation.lineCodes].sort(),
      bidirectional: true,
      estimatedTransferSeconds,
      evidence: {
        selectionBasis: requestedSelectionBasis,
        gtfsTransfers: transferEvidence ? {
          rowCount: transferEvidence.rowCount,
          directionCount: transferEvidence.directions.size,
          minimumSeconds: Math.min(...transferSeconds),
          medianSeconds: median(transferSeconds),
          maximumSeconds: Math.max(...transferSeconds),
        } : null,
        gtfsPathways: pathwayEvidence ? {
          rowCount: pathwayEvidence.rowCount,
          bidirectionalRowCount: pathwayEvidence.bidirectionalRowCount,
          modes: [...pathwayEvidence.modes].sort(),
          minimumSeconds: pathwayEvidence.traversalSeconds.length > 0
            ? Math.min(...pathwayEvidence.traversalSeconds) : null,
          maximumSeconds: pathwayEvidence.traversalSeconds.length > 0
            ? Math.max(...pathwayEvidence.traversalSeconds) : null,
        } : null,
        documentaryTransferEstimate: documentaryEstimate,
        references: referenceKeys.map((key) => ({ key, ...REFERENCES[key] })),
      },
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const categoryCounts = Object.fromEntries(
    ["interchange-complex", "public-way-authorized", "mapped-walking-link"].map((category) => [
      category,
      connections.filter((connection) => connection.category === category).length,
    ]),
  );
  const selectedWithReciprocalGtfsEvidence = connections.filter(
    (connection) => connection.evidence.selectionBasis === "reciprocal-gtfs",
  ).length;
  const selectedWithOfficialDocumentaryEvidence = connections.filter(
    (connection) => connection.evidence.selectionBasis === "official-documentary",
  ).length;
  const documentaryConnectionIds = connections
    .filter((connection) => connection.evidence.selectionBasis === "official-documentary")
    .map((connection) => connection.id);
  const expectedDocumentaryConnectionIds = [
    stationConnectionId("IDFM:478733", "IDFM:71359"),
    stationConnectionId("IDFM:478733", "IDFM:71363"),
    stationConnectionId("IDFM:71410", "IDFM:71363"),
  ].sort();
  const checks = {
    topologyCountsMatch: topology.lineCount === 21 && topology.physicalStationCount === 546
      && topology.stationOccurrenceCount === 658 && topology.interstationCount === 640,
    selectedConnectionCountExact: connections.length === CONNECTION_REGISTRY.length
      && connections.length === 28,
    selectedIdsUnique: new Set(connections.map((connection) => connection.id)).size === connections.length,
    allEndpointsInTopology: connections.every((connection) => stationById.has(connection.fromStationId)
      && stationById.has(connection.toStationId)),
    reciprocalGtfsSelectionExact: selectedWithReciprocalGtfsEvidence === 25
      && connections.filter((connection) => connection.evidence.selectionBasis === "reciprocal-gtfs")
        .every((connection) => connection.evidence.gtfsTransfers?.rowCount > 0
          && connection.evidence.gtfsTransfers.directionCount === 2
          && connection.evidence.documentaryTransferEstimate === null),
    officialDocumentarySelectionExact: selectedWithOfficialDocumentaryEvidence === 3
      && JSON.stringify(documentaryConnectionIds) === JSON.stringify(expectedDocumentaryConnectionIds)
      && connections.filter((connection) => connection.evidence.selectionBasis === "official-documentary")
        .every((connection) => connection.evidence.gtfsTransfers === null
          && connection.evidence.documentaryTransferEstimate?.distanceMeters > 0
          && connection.evidence.references.some((reference) => reference.key === "idfmPublicWayDecision")),
    undocumentedChateauLandonShortcutRejected: !connections.some((connection) =>
      connection.id === stationConnectionId("IDFM:474149", "IDFM:71410")),
    onlyTwoCrossStationPathwayPairs: pathwayEvidenceByPair.size === 2,
    noUnfilteredGtfsProximityImport: connections.length < transferEvidenceByPair.size,
  };
  invariant(Object.values(checks).every(Boolean), `generated checks failed: ${JSON.stringify(checks)}`);

  return {
    schema: SCHEMA,
    generatedAt,
    source: {
      authority: "Ile-de-France Mobilites",
      gtfs: {
        dataset: "Planned timetables in GTFS format",
        url: GTFS_URL,
        zipSha256: sha256(readFileSync(gtfsZip)),
        files: Object.fromEntries(Object.entries(gtfsSources).map(([name, source]) => [name, {
          bytes: Buffer.byteLength(source),
          sha256: sha256(source),
        }])),
      },
      references: REFERENCES,
    },
    policy: {
      selection: "Explicit documented allow-list: reciprocal GTFS pairs plus three public-way pairs explicitly enacted by IDFM for April 2026.",
      rejection: "Unselected GTFS cross-station pairs are walking-proximity routing candidates, not inferred rail dependencies.",
      categories: {
        "interchange-complex": "Documented station complex or internal passenger corridor.",
        "public-way-authorized": "Connection listed by IDFM as a correspondence through public space.",
        "mapped-walking-link": "Walking link represented on the RATP plan; fare continuity is deliberately not inferred.",
      },
      timeModel: "Rounded GTFS median when present; otherwise a labelled geodesic walking estimate at 1.2 m/s plus 120 seconds of station access.",
      documentaryWalkingModel: DOCUMENTARY_WALKING_MODEL,
    },
    counts: {
      stationConnectionCount: connections.length,
      selectedWithReciprocalGtfsEvidence,
      selectedWithOfficialDocumentaryEvidence,
      categoryCounts,
      gtfsTransferRowsInsideGraph,
      gtfsSameStationTransferRows,
      gtfsCrossStationTransferRows: gtfsTransferRowsInsideGraph - gtfsSameStationTransferRows,
      gtfsCrossStationPairCount: transferEvidenceByPair.size,
      gtfsCrossStationPathwayPairCount: pathwayEvidenceByPair.size,
      deliberatelyExcludedGtfsCrossStationPairCount:
        transferEvidenceByPair.size - selectedWithReciprocalGtfsEvidence,
    },
    validation: { verdict: "pass", checks },
    connections,
  };
}

const options = parseCli(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}
if (!options.gtfs) {
  usage();
  throw new Error("--gtfs is required");
}

const topology = JSON.parse(readFileSync(options.topology, "utf8"));
const existing = options.check ? JSON.parse(readFileSync(options.output, "utf8")) : null;
const generatedAt = existing?.generatedAt ?? new Date().toISOString();
const inventory = buildInventory(options.gtfs, topology, generatedAt);
const output = `${JSON.stringify(inventory, null, 2)}\n`;
if (options.check) {
  invariant(readFileSync(options.output, "utf8") === output,
    `${relative(REPOSITORY_ROOT, options.output)} differs from the supplied GTFS snapshot`);
  console.log(`PASS ${relative(REPOSITORY_ROOT, options.output)} matches the supplied GTFS snapshot`);
} else {
  writeFileSync(options.output, output);
  console.log(JSON.stringify({
    status: "written",
    output: relative(REPOSITORY_ROOT, options.output),
    sha256: sha256(output),
    counts: inventory.counts,
  }, null, 2));
}
