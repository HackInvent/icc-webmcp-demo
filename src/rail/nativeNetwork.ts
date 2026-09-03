import nativeManifestFixture from "../../artifacts/ratp-network-native.json";

export const NATIVE_NETWORK_SCHEMA = "paris-icc-native-ratp-network-v1" as const;

export type NativeLineCode =
  | "M1"
  | "M2"
  | "M3"
  | "M3BIS"
  | "M4"
  | "M5"
  | "M6"
  | "M7"
  | "M7BIS"
  | "M8"
  | "M9"
  | "M10"
  | "M11"
  | "M12"
  | "M13"
  | "M14"
  | "RER_A"
  | "RER_B"
  | "RER_C"
  | "RER_D"
  | "RER_E";

export const NATIVE_AUTOMATIC_LINE_CODES: readonly NativeLineCode[] = Object.freeze([
  "M1",
  "M4",
  "M14",
]);

const NATIVE_AUTOMATIC_LINE_CODE_SET = new Set<NativeLineCode>(
  NATIVE_AUTOMATIC_LINE_CODES,
);

export function isNativeAutomaticLine(lineCode: NativeLineCode): boolean {
  return NATIVE_AUTOMATIC_LINE_CODE_SET.has(lineCode);
}

export interface NativePoint {
  x: number;
  y: number;
}

export interface NativeStationPort extends NativePoint {
  distanceFromGuide: number;
  sourcePath: number;
  reason: string;
}

export interface NativeStation {
  id: string;
  svgId: string;
  code: string;
  name: string;
  lines: NativeLineCode[];
  longitude: number;
  latitude: number;
  anchor: NativePoint;
  linePorts: Partial<Record<NativeLineCode, NativeStationPort[]>>;
  visual: {
    status: "wrapped-native-bubble" | "wrapped-native-marker";
    componentIds: string[];
    components: Array<{
      svgId: string;
      status: string;
      primitiveIds: string[];
    }>;
    primitiveIds: string[];
  };
  label: {
    text: string;
    normalized: string;
    bbox: { x: number; y: number; width: number; height: number };
    sourceTextBlock: number;
    sourceLineRange: number[];
    sourceUseRange: number[];
    assignmentDistance?: number;
  };
}

export interface NativePathPart {
  id: string;
  role: string;
  order: number;
  orientation: "from-to" | "to-from";
  rawStart: NativePoint;
  rawEnd: NativePoint;
  sourceOwner: string;
  memberTopologyEdgeId: string;
  sourcePathId: string;
  fromStationCode: string;
  toStationCode: string;
}

export interface NativePhysicalTerminal {
  stationCode: string;
  stationSvgId: string;
  ports: NativeStationPort[];
  role: "declared-endpoint" | "member-branch-terminal" | string;
}

export interface NativeExplicitJunction {
  id: string;
  kind: string;
  sourcePathIds: string[];
  connectorArtworkIds: string[];
  endpointGap: number;
  reason: string;
  pathIds: string[];
}

export interface NativeInterstation {
  id: string;
  svgId: string;
  lineCode: NativeLineCode;
  fromStationCode: string;
  toStationCode: string;
  fromStationSvgId: string;
  toStationSvgId: string;
  ports: { from: NativeStationPort[]; to: NativeStationPort[] };
  collapsedStopCount: number;
  gtfsChain: string[];
  pathIds: string[];
  nativeLength: number;
  pathParts: NativePathPart[];
  memberTopologyEdges: string[];
  rendered: true;
  endpointModel: string;
  physicalSegment: {
    id: string;
    graphModel: string;
    seamTolerance: number;
    terminals: NativePhysicalTerminal[];
    junctions: {
      declaration: string;
      tolerance: number;
      explicit: NativeExplicitJunction[];
    };
    artworkIds: string[];
  };
}

export interface NativeLine {
  code: NativeLineCode;
  label: string;
  name: string;
  mode: "metro" | "rer";
  color: string;
  stationCodes: string[];
  interstationIds: string[];
  sourcePathCount: number;
}

export interface NativeTopologyCrosswalkEntry {
  oldId: string;
  newId: string | null;
  relation: string;
  rendered: boolean;
  reason: string;
  duplicateOfPathId?: string;
  stationCode?: string;
  componentId?: string;
}

export interface NativeNetworkManifest {
  schema: typeof NATIVE_NETWORK_SCHEMA;
  generatedAt: string;
  source: {
    ratpEdition: string;
    ratpPdfSha256: string;
    ratpPlanUrl: string;
    idfmTopologySchema: string;
    idfmTopologySource: { authority: string; dataset: string; url: string };
  };
  svg: {
    file: string;
    sha256: string;
    width: string;
    height: string;
    viewBox: string;
    background: string;
    waterwaysRetained: boolean;
    legacyOverlay: boolean;
    metadata: { manifestFile: string; stationCount: number; interstationCount: number; lineCount: number };
    bytes: number;
  };
  renderedMap: {
    stationCount: number;
    interstationCount: number;
    lineCount: number;
    stationStatusCounts: Record<string, number>;
    stations: NativeStation[];
    interstations: NativeInterstation[];
    lines: NativeLine[];
    topologyCrosswalk: NativeTopologyCrosswalkEntry[];
    nativeDecorationInventory: unknown;
  };
  sourceTopology: unknown;
  endpointRepair: unknown;
}

export interface NativeNetworkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface NativeAdjacencyEntry {
  lineCode: NativeLineCode;
  stationCode: string;
  neighborStationCode: string;
  interstationId: string;
}

export interface NativeLineComponent {
  lineCode: NativeLineCode;
  stationCodes: readonly string[];
  interstationIds: readonly string[];
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid native RATP network manifest: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifest(value: unknown): asserts value is NativeNetworkManifest {
  invariant(isRecord(value), "root must be an object");
  invariant(value.schema === NATIVE_NETWORK_SCHEMA, `schema must be ${NATIVE_NETWORK_SCHEMA}`);
  invariant(isRecord(value.svg), "svg metadata is missing");
  invariant(value.svg.viewBox === "0 0 1133.86 1133.86", "unexpected SVG viewBox");
  invariant(isRecord(value.renderedMap), "renderedMap is missing");
  const renderedMap = value.renderedMap;
  invariant(renderedMap.lineCount === 21, "expected 21 rendered lines");
  invariant(renderedMap.stationCount === 390, "expected 390 rendered stations");
  invariant(renderedMap.interstationCount === 467, "expected 467 rendered interstations");
  invariant(Array.isArray(renderedMap.lines) && renderedMap.lines.length === 21, "line collection mismatch");
  invariant(Array.isArray(renderedMap.stations) && renderedMap.stations.length === 390, "station collection mismatch");
  invariant(
    Array.isArray(renderedMap.interstations) && renderedMap.interstations.length === 467,
    "interstation collection mismatch",
  );
  invariant(
    Array.isArray(renderedMap.topologyCrosswalk) && renderedMap.topologyCrosswalk.length === 484,
    "topology crosswalk must expose the 484 source objects",
  );
}

const rawManifest: unknown = nativeManifestFixture;
validateManifest(rawManifest);

export const NATIVE_NETWORK_MANIFEST: NativeNetworkManifest = rawManifest;
export const NATIVE_LINES: readonly NativeLine[] = Object.freeze(rawManifest.renderedMap.lines);
export const NATIVE_STATIONS: readonly NativeStation[] = Object.freeze(rawManifest.renderedMap.stations);
export const NATIVE_INTERSTATIONS: readonly NativeInterstation[] = Object.freeze(
  rawManifest.renderedMap.interstations,
);

export const NATIVE_LINE_BY_CODE: ReadonlyMap<NativeLineCode, NativeLine> = new Map(
  NATIVE_LINES.map((line) => [line.code, line]),
);
export const NATIVE_STATION_BY_CODE: ReadonlyMap<string, NativeStation> = new Map(
  NATIVE_STATIONS.map((station) => [station.code, station]),
);
export const NATIVE_STATION_BY_SVG_ID: ReadonlyMap<string, NativeStation> = new Map(
  NATIVE_STATIONS.flatMap((station) =>
    [...new Set([station.svgId, ...station.visual.componentIds])].map(
      (svgId) => [svgId, station] as const,
    ),
  ),
);
export const NATIVE_INTERSTATION_BY_ID: ReadonlyMap<string, NativeInterstation> = new Map(
  NATIVE_INTERSTATIONS.map((interstation) => [interstation.id, interstation]),
);

function pairKey(lineCode: NativeLineCode, left: string, right: string): string {
  return `${lineCode}|${[left, right].sort().join("|")}`;
}

export const NATIVE_INTERSTATION_BY_PAIR: ReadonlyMap<string, NativeInterstation> = new Map(
  NATIVE_INTERSTATIONS.map((interstation) => [
    pairKey(interstation.lineCode, interstation.fromStationCode, interstation.toStationCode),
    interstation,
  ]),
);

const adjacency = new Map<NativeLineCode, Map<string, NativeAdjacencyEntry[]>>();
for (const line of NATIVE_LINES) adjacency.set(line.code, new Map());
for (const interstation of NATIVE_INTERSTATIONS) {
  const lineAdjacency = adjacency.get(interstation.lineCode);
  invariant(lineAdjacency, `unknown line ${interstation.lineCode} on ${interstation.id}`);
  for (const [stationCode, neighborStationCode] of [
    [interstation.fromStationCode, interstation.toStationCode],
    [interstation.toStationCode, interstation.fromStationCode],
  ] as const) {
    const entries = lineAdjacency.get(stationCode) ?? [];
    entries.push({
      lineCode: interstation.lineCode,
      stationCode,
      neighborStationCode,
      interstationId: interstation.id,
    });
    lineAdjacency.set(stationCode, entries);
  }
}
for (const lineAdjacency of adjacency.values()) {
  for (const entries of lineAdjacency.values()) {
    entries.sort((left, right) =>
      left.neighborStationCode.localeCompare(right.neighborStationCode) ||
      left.interstationId.localeCompare(right.interstationId)
    );
    Object.freeze(entries);
  }
}

export const NATIVE_ADJACENCY: ReadonlyMap<
  NativeLineCode,
  ReadonlyMap<string, readonly NativeAdjacencyEntry[]>
> = adjacency;

function buildLineComponents(line: NativeLine): NativeLineComponent[] {
  const lineAdjacency = adjacency.get(line.code) ?? new Map();
  const unseen = new Set(line.stationCodes);
  const components: NativeLineComponent[] = [];
  while (unseen.size > 0) {
    const first = [...unseen].sort()[0];
    const pending = [first];
    const stationCodes = new Set<string>();
    const interstationIds = new Set<string>();
    unseen.delete(first);
    while (pending.length > 0) {
      const stationCode = pending.shift();
      if (!stationCode || stationCodes.has(stationCode)) continue;
      stationCodes.add(stationCode);
      for (const entry of lineAdjacency.get(stationCode) ?? []) {
        interstationIds.add(entry.interstationId);
        if (unseen.delete(entry.neighborStationCode)) pending.push(entry.neighborStationCode);
      }
    }
    components.push({
      lineCode: line.code,
      stationCodes: Object.freeze([...stationCodes].sort()),
      interstationIds: Object.freeze([...interstationIds].sort()),
    });
  }
  return components.sort((left, right) =>
    right.interstationIds.length - left.interstationIds.length ||
    left.stationCodes[0].localeCompare(right.stationCodes[0])
  );
}

export const NATIVE_LINE_COMPONENTS: ReadonlyMap<NativeLineCode, readonly NativeLineComponent[]> =
  new Map(NATIVE_LINES.map((line) => [line.code, Object.freeze(buildLineComponents(line))]));

const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] = rawManifest.svg.viewBox
  .split(/\s+/)
  .map(Number);
invariant(
  [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight].every(Number.isFinite),
  "viewBox must contain four finite numbers",
);

export const NATIVE_NETWORK_BOUNDS: NativeNetworkBounds = Object.freeze({
  minX: viewBoxX,
  minY: viewBoxY,
  maxX: viewBoxX + viewBoxWidth,
  maxY: viewBoxY + viewBoxHeight,
  width: viewBoxWidth,
  height: viewBoxHeight,
});

export function getNativeNeighbors(
  lineCode: NativeLineCode,
  stationCode: string,
): readonly NativeAdjacencyEntry[] {
  return NATIVE_ADJACENCY.get(lineCode)?.get(stationCode) ?? [];
}

export function findNativeInterstation(
  lineCode: NativeLineCode,
  leftStationCode: string,
  rightStationCode: string,
): NativeInterstation | undefined {
  return NATIVE_INTERSTATION_BY_PAIR.get(pairKey(lineCode, leftStationCode, rightStationCode));
}

const crosswalkByOldId = new Map(
  rawManifest.renderedMap.topologyCrosswalk.map((entry) => [entry.oldId, entry]),
);

export function resolveRenderedInterstationId(sourceObjectId: string): string | null | undefined {
  return crosswalkByOldId.get(sourceObjectId)?.newId;
}

export function normalizeNativeStationSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function searchNativeStations(query: string, limit = 12): readonly NativeStation[] {
  const normalized = normalizeNativeStationSearch(query);
  if (!normalized || limit <= 0) return [];
  return NATIVE_STATIONS
    .map((station) => {
      const name = normalizeNativeStationSearch(station.name);
      const code = station.code.toLowerCase();
      const score = code === query.toLowerCase()
        ? 0
        : name === normalized
          ? 1
          : name.startsWith(normalized)
            ? 2
            : name.includes(normalized)
              ? 3
              : code.includes(normalized)
                ? 4
                : Number.POSITIVE_INFINITY;
      return { station, score };
    })
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) =>
      left.score - right.score || left.station.name.localeCompare(right.station.name, "en")
    )
    .slice(0, limit)
    .map((candidate) => candidate.station);
}
