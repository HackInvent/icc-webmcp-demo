import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import nativeMapUrl from "../../artifacts/ratp-network-native.svg?url";
import {
  NATIVE_INTERSTATION_BY_ID,
  NATIVE_LINE_BY_CODE,
  NATIVE_LINES,
  NATIVE_NETWORK_BOUNDS,
  NATIVE_NETWORK_MANIFEST,
  NATIVE_STATION_BY_CODE,
  NATIVE_STATION_BY_SVG_ID,
  NATIVE_STATIONS,
  searchNativeStations,
  type NativeInterstation,
  type NativeLine,
  type NativeLineCode,
  type NativePoint,
  type NativeStation,
} from "../rail/nativeNetwork";
import type {
  NativeIncident,
  NativeSimulationSnapshot,
  NativeTrainState,
} from "../rail/nativeSimulation";
import { RAIL_GRAPH_STATIONS } from "../rail/interdependenceGraph";
import { Icon } from "./Icon";

interface RatpNetworkSchematicProps {
  simulation: NativeSimulationSnapshot;
  operationalResponse?: unknown;
  focusIncidentId?: string;
  revealIncidentId?: string;
  onIncidentActivate: (incidentId: string) => void;
  onDeclareIncident: (target: NativeIncidentDeclarationTarget) => void;
}

export interface NativeIncidentDeclarationTarget {
  targetType: "station" | "interstation";
  targetId: string;
  lineCode: NativeLineCode;
}

type AtlasScope = "all" | "metro" | "rer";
type SemanticLevel = "overview" | "operations" | "detail";
type NativeSelection =
  | { kind: "line"; id: NativeLineCode }
  | { kind: "station"; id: string }
  | { kind: "interstation"; id: string }
  | { kind: "train"; id: string }
  | { kind: "incident"; id: string };

interface NativeViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResolvedPathPart {
  path: SVGPathElement;
  length: number;
  reverse: boolean;
}

interface PositionedTrain {
  train: NativeTrainState;
  ownerId: string;
  point: NativePoint;
  laneOffset: number;
}

interface PositionedIncident {
  incident: NativeIncident;
  ownerId: string;
  point: NativePoint;
}

interface PositionedBusService {
  id: string;
  incidentId: string | null;
  lineCode: NativeLineCode;
  status: string;
  cyclePhase: string;
  point: NativePoint;
}

interface DelayCluster {
  objectId: string;
  lineCode: NativeLineCode;
  count: number;
  maximumDelaySeconds: number;
  point: NativePoint;
}

type NativeRuntimeLayer = "state" | "trains" | "context" | "incidents";

interface NativeRuntimeHost {
  host: SVGGElement;
  owner: SVGGElement;
  kind: "station" | "interstation";
  layers: Record<NativeRuntimeLayer, SVGGElement>;
}

const NATIVE_RUNTIME_LAYER_ORDER: readonly NativeRuntimeLayer[] = [
  "state",
  "trains",
  "context",
  "incidents",
];

const ROOT_VIEW: NativeViewBox = {
  x: NATIVE_NETWORK_BOUNDS.minX,
  y: NATIVE_NETWORK_BOUNDS.minY,
  width: NATIVE_NETWORK_BOUNDS.width,
  height: NATIVE_NETWORK_BOUNDS.height,
};
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const OPERATIONS_ZOOM = 1.3;
const DETAIL_ZOOM = 2.4;

type RuntimeMarkerKind =
  | "incident-icon"
  | "incident-tag"
  | "train-body"
  | "train-detail"
  | "context"
  | "indicator";

const RUNTIME_MARKER_DENSITY: Record<RuntimeMarkerKind, {
  base: number;
  exponent: number;
  maximum: number;
}> = {
  "incident-icon": { base: 0.875, exponent: 0.26, maximum: 1.4375 },
  "incident-tag": { base: 0.92, exponent: 0.12, maximum: 1.17 },
  "train-body": { base: 0.86, exponent: 0.18, maximum: 1.27 },
  "train-detail": { base: 1, exponent: 0.12, maximum: 1.31 },
  context: { base: 0.92, exponent: 0.10, maximum: 1.17 },
  indicator: { base: 0.82, exponent: 0.22, maximum: 1.3 },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function zoomFor(view: NativeViewBox): number {
  return ROOT_VIEW.width / view.width;
}

function semanticLevelFor(zoom: number): SemanticLevel {
  if (zoom >= DETAIL_ZOOM) return "detail";
  if (zoom >= OPERATIONS_ZOOM) return "operations";
  return "overview";
}

function runtimePixelDensity(zoom: number, kind: RuntimeMarkerKind): number {
  const profile = RUNTIME_MARKER_DENSITY[kind];
  return clamp(
    profile.base * Math.pow(Math.max(1, zoom), profile.exponent),
    profile.base,
    profile.maximum,
  );
}

function normalizeView(view: NativeViewBox): NativeViewBox {
  const minimumSize = ROOT_VIEW.width / MAX_ZOOM;
  const maximumSize = ROOT_VIEW.width / MIN_ZOOM;
  const size = clamp(Math.max(view.width, view.height), minimumSize, maximumSize);
  return {
    width: size,
    height: size,
    x: clamp(view.x, ROOT_VIEW.x, ROOT_VIEW.x + ROOT_VIEW.width - size),
    y: clamp(view.y, ROOT_VIEW.y, ROOT_VIEW.y + ROOT_VIEW.height - size),
  };
}

function activateWithKeyboard(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function stationName(code: string): string {
  return NATIVE_STATION_BY_CODE.get(code)?.name ?? code.replace("IDFM:", "");
}

function lineLabel(code: NativeLineCode): string {
  return NATIVE_LINE_BY_CODE.get(code)?.name ?? code.replace("_", " ");
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return seconds === 0 ? "on time" : "+" + seconds + "s";
  const minutes = Math.floor(seconds / 60);
  return "+" + minutes + "m" + (seconds % 60 ? " " + seconds % 60 + "s" : "");
}

const INCIDENT_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatIncidentTime(timestamp: number): string {
  return INCIDENT_TIME_FORMATTER.format(new Date(timestamp));
}

export type NativeIncidentMarkerSymbol = "alert" | "baggage" | "power";

export function nativeIncidentMarkerSymbol(
  incident: Pick<NativeIncident, "effect" | "type">,
): NativeIncidentMarkerSymbol {
  if (incident.effect === "abandoned-baggage") return "baggage";
  if (incident.type === "power") return "power";
  return "alert";
}

function prepareTrustedNativeSvg(source: string): string {
  const documentNode = new DOMParser().parseFromString(source, "image/svg+xml");
  const parserError = documentNode.querySelector("parsererror");
  const svg = documentNode.documentElement;
  if (parserError || svg.localName !== "svg") throw new Error("The native RATP SVG could not be parsed.");
  svg.querySelectorAll("script, foreignObject").forEach((node) => node.remove());
  svg.removeAttribute("aria-hidden");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Interactive Paris Metro and RER operational network");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.querySelectorAll("[tabindex]").forEach((node) => node.setAttribute("tabindex", "-1"));
  return new XMLSerializer().serializeToString(svg);
}

function rootPointToObject(
  point: NativePoint,
  owner: SVGGElement,
  root: SVGSVGElement,
): NativePoint | null {
  const ownerMatrix = owner.getCTM();
  const rootMatrix = root.getCTM();
  if (!ownerMatrix || !rootMatrix) return null;
  try {
    const matrix = ownerMatrix.inverse().multiply(rootMatrix);
    const transformed = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return Number.isFinite(transformed.x) && Number.isFinite(transformed.y)
      ? { x: transformed.x, y: transformed.y }
      : null;
  } catch {
    return null;
  }
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum - 1).trimEnd() + "…";
}

function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function distance(left: NativePoint, right: NativePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function nativeElementById(root: SVGSVGElement, id: string): Element | null {
  return root.querySelector("#" + CSS.escape(id));
}

function transformPathPoint(
  path: SVGPathElement,
  point: DOMPoint,
  root: SVGSVGElement,
): NativePoint | null {
  const pathMatrix = path.getCTM();
  const rootMatrix = root.getCTM();
  if (!pathMatrix || !rootMatrix) return null;
  try {
    const matrix = rootMatrix.inverse().multiply(pathMatrix);
    const transformed = point.matrixTransform(matrix);
    return Number.isFinite(transformed.x) && Number.isFinite(transformed.y)
      ? { x: transformed.x, y: transformed.y }
      : null;
  } catch {
    return null;
  }
}

function resolvePathParts(
  interstation: NativeInterstation,
  root: SVGSVGElement,
): ResolvedPathPart[] {
  const tolerance = Math.max(0.05, interstation.physicalSegment.seamTolerance);
  const nodes: NativePoint[] = [];
  const nodeFor = (point: NativePoint): number => {
    const found = nodes.findIndex((candidate) => distance(candidate, point) <= tolerance);
    if (found >= 0) return found;
    nodes.push(point);
    return nodes.length - 1;
  };
  const parts = interstation.pathParts
    .map((part) => {
      const path = nativeElementById(root, part.id);
      if (!(path instanceof SVGPathElement)) return null;
      let length: number;
      try {
        length = path.getTotalLength();
      } catch {
        return null;
      }
      if (!Number.isFinite(length) || length <= 0) return null;
      return {
        path,
        length,
        startNode: nodeFor(part.rawStart),
        endNode: nodeFor(part.rawEnd),
        order: part.order,
        orientation: part.orientation,
      };
    })
    .filter((part): part is NonNullable<typeof part> => part !== null);
  if (parts.length === 0) return [];

  const fromPort = interstation.ports.from[0] ?? NATIVE_STATION_BY_CODE.get(interstation.fromStationCode)?.anchor;
  const toPort = interstation.ports.to[0] ?? NATIVE_STATION_BY_CODE.get(interstation.toStationCode)?.anchor;
  if (!fromPort || !toPort) {
    return parts
      .sort((left, right) => left.order - right.order)
      .map((part) => ({
        path: part.path,
        length: part.length,
        reverse: part.orientation === "to-from",
      }));
  }
  const closestNode = (point: NativePoint): number => {
    let selected = 0;
    let selectedDistance = Number.POSITIVE_INFINITY;
    nodes.forEach((candidate, index) => {
      const candidateDistance = distance(candidate, point);
      if (candidateDistance < selectedDistance) {
        selected = index;
        selectedDistance = candidateDistance;
      }
    });
    return selected;
  };
  const startNode = closestNode(fromPort);
  const targetNode = closestNode(toPort);
  type Link = { to: number; partIndex: number; reverse: boolean; weight: number };
  const graph = new Map<number, Link[]>();
  parts.forEach((part, partIndex) => {
    const forward = graph.get(part.startNode) ?? [];
    forward.push({ to: part.endNode, partIndex, reverse: false, weight: part.length });
    graph.set(part.startNode, forward);
    const reverse = graph.get(part.endNode) ?? [];
    reverse.push({ to: part.startNode, partIndex, reverse: true, weight: part.length });
    graph.set(part.endNode, reverse);
  });
  const scores = new Map<number, number>([[startNode, 0]]);
  const previous = new Map<number, { node: number; link: Link }>();
  const pending = new Set(nodes.map((_, index) => index));
  while (pending.size > 0) {
    let current = -1;
    let currentScore = Number.POSITIVE_INFINITY;
    pending.forEach((node) => {
      const score = scores.get(node) ?? Number.POSITIVE_INFINITY;
      if (score < currentScore) {
        current = node;
        currentScore = score;
      }
    });
    if (current < 0 || !Number.isFinite(currentScore)) break;
    pending.delete(current);
    if (current === targetNode) break;
    for (const link of graph.get(current) ?? []) {
      const candidate = currentScore + link.weight;
      if (candidate < (scores.get(link.to) ?? Number.POSITIVE_INFINITY)) {
        scores.set(link.to, candidate);
        previous.set(link.to, { node: current, link });
      }
    }
  }
  if (!previous.has(targetNode) && startNode !== targetNode) {
    return parts
      .sort((left, right) => left.order - right.order)
      .map((part) => ({
        path: part.path,
        length: part.length,
        reverse: part.orientation === "to-from",
      }));
  }
  const resolved: ResolvedPathPart[] = [];
  let cursor = targetNode;
  while (cursor !== startNode) {
    const step = previous.get(cursor);
    if (!step) break;
    const part = parts[step.link.partIndex];
    resolved.unshift({
      path: part.path,
      length: part.length,
      reverse: step.link.reverse,
    });
    cursor = step.node;
  }
  return resolved;
}

function fallbackPoint(interstation: NativeInterstation, progress: number): NativePoint {
  const from = interstation.ports.from[0]
    ?? NATIVE_STATION_BY_CODE.get(interstation.fromStationCode)?.anchor
    ?? { x: ROOT_VIEW.width / 2, y: ROOT_VIEW.height / 2 };
  const to = interstation.ports.to[0]
    ?? NATIVE_STATION_BY_CODE.get(interstation.toStationCode)?.anchor
    ?? from;
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

function selectionIds(selection: NativeSelection | null): string[] {
  if (!selection) return [];
  if (selection.kind === "station") {
    const station = NATIVE_STATION_BY_SVG_ID.get(selection.id);
    return station?.visual.componentIds ?? [selection.id];
  }
  if (selection.kind === "interstation") return [selection.id];
  return [];
}

function operationalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positionedBusServices(response: unknown): PositionedBusService[] {
  const root = operationalRecord(response);
  const measures = Array.isArray(root?.continuityMeasures) ? root.continuityMeasures : [];
  return measures.flatMap((rawMeasure) => {
    const measure = operationalRecord(rawMeasure);
    if (!measure || (measure.kind !== "shuttle-bus" && measure.kind !== "bus-bridge")) return [];
    if (measure.status !== "active" && measure.status !== "running") return [];
    const plan = operationalRecord(measure.plan);
    const cycle = operationalRecord(plan?.cycle);
    const plannedTermini = Array.isArray(plan?.terminusStationIds)
      ? plan.terminusStationIds.filter((value): value is string => typeof value === "string")
      : [];
    const stationIds = plannedTermini.length >= 2
      ? plannedTermini
      : Array.isArray(measure.stationIds)
        ? measure.stationIds.filter((value): value is string => typeof value === "string")
        : [];
    const cyclePhase = typeof cycle?.phase === "string" ? cycle.phase : "active";
    const discreteStationId = typeof cycle?.atStationId === "string"
      ? cycle.atStationId
      : cycle?.direction === "inbound" || cyclePhase === "at-destination"
        ? stationIds[1]
        : stationIds[0];
    const graphStation = [discreteStationId, ...stationIds]
      .filter((stationId): stationId is string => typeof stationId === "string")
      .map((stationId) => RAIL_GRAPH_STATIONS.find((station) => station.id === stationId))
      .find((station) => station?.svg.primaryObjectId);
    const station = graphStation?.svg.primaryObjectId
      ? NATIVE_STATION_BY_SVG_ID.get(graphStation.svg.primaryObjectId)
      : undefined;
    const incidentId = typeof measure.incidentId === "string" ? measure.incidentId : "";
    if (!station || !incidentId) return [];
    const lineCodes = Array.isArray(measure.lineCodes)
      ? measure.lineCodes.filter((value): value is NativeLineCode => typeof value === "string" && NATIVE_LINE_BY_CODE.has(value as NativeLineCode))
      : [];
    return [{
      id: typeof measure.measureId === "string" ? measure.measureId : typeof measure.id === "string" ? measure.id : "BUS-" + incidentId,
      incidentId,
      lineCode: lineCodes[0] ?? station.lines[0],
      status: String(measure.status),
      cyclePhase,
      point: station.anchor,
    }];
  });
}


export function RatpNetworkSchematic({
  simulation,
  operationalResponse,
  focusIncidentId,
  revealIncidentId,
  onIncidentActivate,
  onDeclareIncident,
}: RatpNetworkSchematicProps) {
  const [scope, setScope] = useState<AtlasScope>("all");
  const [focusedLine, setFocusedLine] = useState<NativeLineCode | null>(null);
  const [selection, setSelection] = useState<NativeSelection | null>({
    kind: "incident",
    id: simulation.incidents[0]?.id ?? "",
  });
  const [view, setView] = useState<NativeViewBox>(ROOT_VIEW);
  const [stationQuery, setStationQuery] = useState("");
  const [artwork, setArtwork] = useState<string | null>(null);
  const [artworkError, setArtworkError] = useState<string | null>(null);
  const [artworkEpoch, setArtworkEpoch] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const artworkRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const runtimeHosts = useRef(new Map<string, NativeRuntimeHost>());
  const operationalForegroundLayersRef = useRef<Record<NativeRuntimeLayer, SVGGElement> | null>(null);
  const geometryCache = useRef(new Map<string, ResolvedPathPart[]>());
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    view: NativeViewBox;
  } | null>(null);
  const handledFocusRequestRef = useRef<string | null>(null);
  const handledRevealRequestRef = useRef<string | null>(null);
  const zoom = zoomFor(view);
  const semanticLevel = semanticLevelFor(zoom);
  const stagePixelScale = stageSize.width > 0 && stageSize.height > 0
    ? Math.max(0.001, Math.min(stageSize.width / view.width, stageSize.height / view.height))
    : Math.max(0.001, zoom);
  const localRuntimeScale = (kind: RuntimeMarkerKind): number =>
    runtimePixelDensity(zoom, kind) / stagePixelScale;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = (): void => {
      const rectangle = stage.getBoundingClientRect();
      setStageSize((current) =>
        Math.abs(current.width - rectangle.width) < 0.5 &&
        Math.abs(current.height - rectangle.height) < 0.5
          ? current
          : { width: rectangle.width, height: rectangle.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(nativeMapUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Native map request failed with " + response.status + ".");
        return response.text();
      })
      .then((source) => {
        setArtwork(prepareTrustedNativeSvg(source));
        setArtworkError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setArtworkError(error instanceof Error ? error.message : "The native map could not be loaded.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!artwork || !artworkRef.current) return;
    const root = artworkRef.current.querySelector("svg");
    if (!(root instanceof SVGSVGElement)) {
      setArtworkError("The native map did not expose an SVG root.");
      return;
    }
    root.setAttribute("data-runtime-schema", NATIVE_NETWORK_MANIFEST.schema);
    root.setAttribute("data-runtime-interactive", "true");
    root.querySelectorAll("[tabindex]").forEach((node) => node.setAttribute("tabindex", "-1"));
    const nextRuntimeHosts = new Map<string, NativeRuntimeHost>();
    root.querySelectorAll<SVGGElement>(
      [
        "g.native-station[data-object-id]",
        "g.native-station-component[data-object-id]",
        "g.native-interstation[data-object-id]",
      ].join(","),
    ).forEach((owner) => {
      const objectId = owner.dataset.objectId;
      if (!objectId) return;
      const kind = owner.classList.contains("native-interstation") ? "interstation" : "station";
      const existing = Array.from(owner.children).find(
        (child) => child.getAttribute("data-runtime-object-host") === objectId,
      );
      const host = existing instanceof SVGGElement
        ? existing
        : document.createElementNS("http://www.w3.org/2000/svg", "g");
      host.setAttribute("class", "native-object-runtime-host");
      host.setAttribute("data-runtime-object-host", objectId);
      host.setAttribute("data-runtime-object-kind", kind);
      host.setAttribute("data-runtime-train-count", "0");
      host.setAttribute("data-runtime-incident-count", "0");
      if (kind === "station") {
        const station = NATIVE_STATION_BY_SVG_ID.get(objectId);
        if (station) {
          host.setAttribute("data-context-name", station.name);
          host.setAttribute("data-context-lines", station.lines.join(" "));
        }
      } else {
        const interstation = NATIVE_INTERSTATION_BY_ID.get(objectId);
        if (interstation) {
          host.setAttribute("data-context-line", interstation.lineCode);
          host.setAttribute("data-context-from", interstation.fromStationCode);
          host.setAttribute("data-context-to", interstation.toStationCode);
        }
      }
      owner.setAttribute("role", "group");
      const layers = {} as Record<NativeRuntimeLayer, SVGGElement>;
      NATIVE_RUNTIME_LAYER_ORDER.forEach((layerName) => {
        const existingLayer = Array.from(host.children).find(
          (child) => child.getAttribute("data-runtime-layer") === layerName,
        );
        const layer = existingLayer instanceof SVGGElement
          ? existingLayer
          : document.createElementNS("http://www.w3.org/2000/svg", "g");
        layer.setAttribute(
          "class",
          "native-object-runtime-layer native-object-runtime-layer--" + layerName,
        );
        layer.setAttribute("data-runtime-layer", layerName);
        layer.setAttribute("data-runtime-layer-owner", objectId);
        host.appendChild(layer);
        layers[layerName] = layer;
      });
      owner.appendChild(host);
      nextRuntimeHosts.set(objectId, { host, owner, kind, layers });
    });
    runtimeHosts.current = nextRuntimeHosts;
    root.setAttribute("data-runtime-object-host-count", String(nextRuntimeHosts.size));
    const existingForeground = Array.from(root.children).find(
      (child) => child.getAttribute("data-runtime-operational-foreground") === "true",
    );
    const operationalForeground = existingForeground instanceof SVGGElement
      ? existingForeground
      : document.createElementNS("http://www.w3.org/2000/svg", "g");
    operationalForeground.setAttribute("class", "native-operational-foreground");
    operationalForeground.setAttribute("data-runtime-operational-foreground", "true");
    operationalForeground.setAttribute("aria-label", "Operational foreground projections");
    const operationalForegroundLayers = {} as Record<NativeRuntimeLayer, SVGGElement>;
    NATIVE_RUNTIME_LAYER_ORDER.forEach((layerName) => {
      const existingLayer = Array.from(operationalForeground.children).find(
        (child) => child.getAttribute("data-runtime-foreground-layer") === layerName,
      );
      const layer = existingLayer instanceof SVGGElement
        ? existingLayer
        : document.createElementNS("http://www.w3.org/2000/svg", "g");
      layer.setAttribute(
        "class",
        "native-operational-foreground__layer native-operational-foreground__layer--" + layerName,
      );
      layer.setAttribute("data-runtime-foreground-layer", layerName);
      operationalForeground.appendChild(layer);
      operationalForegroundLayers[layerName] = layer;
    });
    root.appendChild(operationalForeground);
    operationalForegroundLayersRef.current = operationalForegroundLayers;
    geometryCache.current.clear();
    setArtworkEpoch((current) => current + 1);
  }, [artwork]);

  useEffect(() => {
    const root = artworkRef.current?.querySelector("svg");
    if (!(root instanceof SVGSVGElement)) return;
    root.setAttribute("viewBox", [view.x, view.y, view.width, view.height].join(" "));
  }, [artworkEpoch, view]);

  const activeAffectedIds = useMemo(
    () => new Set(
      simulation.incidents
        .filter((incident) => incident.status === "active")
        .flatMap((incident) => incident.affectedInterstationIds),
    ),
    [simulation.incidents],
  );

  useEffect(() => {
    const root = artworkRef.current?.querySelector("svg");
    if (!(root instanceof SVGSVGElement)) return;
    root.querySelectorAll(".native-object--dimmed,.native-object--affected,.native-object--selected")
      .forEach((node) => node.classList.remove(
        "native-object--dimmed",
        "native-object--affected",
        "native-object--selected",
      ));
    if (focusedLine) {
      NATIVE_LINES.forEach((line) => {
        if (line.code !== focusedLine) {
          nativeElementById(root, "native-line-" + line.code)?.classList.add("native-object--dimmed");
        }
      });
    }
    activeAffectedIds.forEach((id) => {
      nativeElementById(root, id)?.classList.add("native-object--affected");
    });
    selectionIds(selection).forEach((id) => {
      nativeElementById(root, id)?.classList.add("native-object--selected");
    });
  }, [activeAffectedIds, artworkEpoch, focusedLine, selection]);

  useEffect(() => {
    const container = artworkRef.current;
    if (!container) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-runtime-entity]")) return;
      const object = target.closest("[data-object-id]");
      const id = object?.getAttribute("data-object-id");
      if (!id) return;
      if (id.startsWith("station-")) setSelection({ kind: "station", id });
      if (id.startsWith("interstation-")) setSelection({ kind: "interstation", id });
    };
    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [artworkEpoch]);

  const pointOnInterstation = (
    interstationId: string,
    rawProgress: number,
    fromStationCode?: string,
  ): NativePoint | null => {
    const interstation = NATIVE_INTERSTATION_BY_ID.get(interstationId);
    if (!interstation) return null;
    const progress = clamp(
      fromStationCode === interstation.toStationCode ? 1 - rawProgress : rawProgress,
      0,
      1,
    );
    const root = artworkRef.current?.querySelector("svg");
    if (!(root instanceof SVGSVGElement)) return fallbackPoint(interstation, progress);
    let parts = geometryCache.current.get(interstationId);
    if (!parts) {
      parts = resolvePathParts(interstation, root);
      geometryCache.current.set(interstationId, parts);
    }
    const totalLength = parts.reduce((total, part) => total + part.length, 0);
    if (parts.length === 0 || totalLength <= 0) return fallbackPoint(interstation, progress);
    let target = totalLength * progress;
    for (const part of parts) {
      if (target > part.length) {
        target -= part.length;
        continue;
      }
      const length = part.reverse ? part.length - target : target;
      try {
        const point = part.path.getPointAtLength(clamp(length, 0, part.length));
        return transformPathPoint(part.path, point, root) ?? fallbackPoint(interstation, progress);
      } catch {
        return fallbackPoint(interstation, progress);
      }
    }
    return fallbackPoint(interstation, progress);
  };

  const visibleLines = useMemo(
    () => NATIVE_LINES.filter((line) => scope === "all" || line.mode === scope),
    [scope],
  );
  const visibleLineCodes = useMemo(
    () => new Set(visibleLines.map((line) => line.code)),
    [visibleLines],
  );
  const lineInScope = (lineCode: NativeLineCode): boolean =>
    visibleLineCodes.has(lineCode) && (!focusedLine || focusedLine === lineCode);

  const pointInObject = (objectId: string, point: NativePoint): NativePoint | null => {
    const binding = runtimeHosts.current.get(objectId);
    const root = artworkRef.current?.querySelector("svg");
    if (!binding || !(root instanceof SVGSVGElement)) return null;
    return rootPointToObject(point, binding.owner, root) ?? point;
  };

  const positionedTrains = useMemo<PositionedTrain[]>(() => {
    const entries = simulation.trains
      .filter((train) => lineInScope(train.lineCode))
      .flatMap((train) => {
        if (train.location.type === "station") {
          const station = NATIVE_STATION_BY_CODE.get(train.location.id);
          return station
            ? [{ train, ownerId: station.svgId, point: station.anchor }]
            : [];
        }
        const point = pointOnInterstation(train.location.id, 0.5);
        return point ? [{ train, ownerId: train.location.id, point }] : [];
      });
    const byOwner = new Map<string, typeof entries>();
    entries.forEach((entry) => {
      const group = byOwner.get(entry.ownerId) ?? [];
      group.push(entry);
      byOwner.set(entry.ownerId, group);
    });
    return entries.map((entry) => {
      const siblings = [...(byOwner.get(entry.ownerId) ?? [entry])]
        .sort((left, right) => left.train.id.localeCompare(right.train.id));
      const index = siblings.findIndex((candidate) => candidate.train.id === entry.train.id);
      return {
        ...entry,
        laneOffset: siblings.length > 1 ? (index - (siblings.length - 1) / 2) * 28 : 0,
      };
    });
  }, [
      artworkEpoch,
      focusedLine,
      simulation.telemetryRevision,
      simulation.trains,
      visibleLineCodes,
    ]);

  const positionedIncidents = useMemo<PositionedIncident[]>(() => simulation.incidents
    .filter((incident) => incident.status === "active" && lineInScope(incident.lineCode))
    .map((incident) => {
      const stationCode = incident.target.type === "station"
        ? incident.target.id
        : incident.affectedStationCodes[0] ?? "";
      const station = NATIVE_STATION_BY_CODE.get(stationCode);
      const edgeId = incident.target.type === "interstation"
        ? incident.target.id
        : incident.affectedInterstationIds[0];
      const stationTarget = incident.target.type === "station" && station;
      const point = stationTarget
        ? station.anchor
        : edgeId
          ? pointOnInterstation(edgeId, 0.5)
          : station?.anchor ?? null;
      return {
        incident,
        ownerId: stationTarget ? station.svgId : edgeId ?? station?.svgId ?? "",
        point,
      };
    })
    .filter((entry): entry is PositionedIncident => entry.point !== null && entry.ownerId.length > 0), [
      artworkEpoch,
      focusedLine,
      simulation.decisionRevision,
      simulation.incidents,
      visibleLineCodes,
    ]);

  const activeBusServices = useMemo(
    () => [
      ...positionedBusServices(operationalResponse),
      ...simulation.shuttles.flatMap((shuttle): PositionedBusService[] => {
        if (!lineInScope(shuttle.lineCode)) return [];
        const point = shuttle.location.type === "station"
          ? NATIVE_STATION_BY_CODE.get(shuttle.location.id)?.anchor ?? null
          : pointOnInterstation(shuttle.location.id, 0.5) ?? (() => {
              const nextStationIndex = shuttle.stationIndex + shuttle.direction;
              const from = NATIVE_STATION_BY_CODE.get(
                shuttle.routeStationIds[shuttle.stationIndex],
              )?.anchor;
              const to = NATIVE_STATION_BY_CODE.get(
                shuttle.routeStationIds[nextStationIndex],
              )?.anchor;
              return from && to
                ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
                : null;
            })();
        if (!point) return [];
        return [{
          id: shuttle.id,
          incidentId: null,
          lineCode: shuttle.lineCode,
          status: shuttle.status,
          cyclePhase: shuttle.direction === 1 ? "manual-outbound" : "manual-return",
          point,
        }];
      }),
    ].filter((service) => lineInScope(service.lineCode)),
    [artworkEpoch, focusedLine, operationalResponse, simulation.shuttles, visibleLineCodes],
  );

  const delayClusters = useMemo<DelayCluster[]>(() => {
    const byObject = new Map<string, PositionedTrain[]>();
    positionedTrains
      .filter((entry) => entry.train.delaySeconds >= 300)
      .forEach((entry) => {
        const group = byObject.get(entry.ownerId) ?? [];
        group.push(entry);
        byObject.set(entry.ownerId, group);
      });
    return [...byObject].map(([objectId, entries]) => ({
      objectId,
      lineCode: entries[0].train.lineCode,
      count: entries.length,
      maximumDelaySeconds: Math.max(...entries.map((entry) => entry.train.delaySeconds)),
      point: {
        x: entries.reduce((total, entry) => total + entry.point.x, 0) / entries.length,
        y: entries.reduce((total, entry) => total + entry.point.y, 0) / entries.length,
      },
    }));
  }, [positionedTrains]);

  useEffect(() => {
    if (!artworkEpoch) return;
    const trainCounts = new Map<string, number>();
    const maximumDelays = new Map<string, number>();
    positionedTrains.forEach(({ train, ownerId }) => {
      trainCounts.set(ownerId, (trainCounts.get(ownerId) ?? 0) + 1);
      maximumDelays.set(
        ownerId,
        Math.max(maximumDelays.get(ownerId) ?? 0, train.delaySeconds),
      );
    });
    const incidentCounts = new Map<string, number>();
    simulation.incidents.filter((incident) => incident.status === "active").forEach((incident) => {
      const objectIds = new Set(incident.affectedInterstationIds);
      incident.affectedStationCodes.forEach((code) => {
        const station = NATIVE_STATION_BY_CODE.get(code);
        station?.visual.componentIds.forEach((svgId) => objectIds.add(svgId));
      });
      objectIds.forEach((objectId) => {
        incidentCounts.set(objectId, (incidentCounts.get(objectId) ?? 0) + 1);
      });
    });
    runtimeHosts.current.forEach(({ host, owner, kind }, objectId) => {
      const trainCount = trainCounts.get(objectId) ?? 0;
      const segmentOccupied = kind === "interstation" && trainCount > 0;
      setAttributeIfChanged(
        host,
        "data-runtime-train-count",
        String(trainCount),
      );
      owner.classList.toggle("native-object--occupied", segmentOccupied);
      setAttributeIfChanged(
        owner,
        "data-runtime-occupation",
        segmentOccupied ? "occupied" : "clear",
      );
      setAttributeIfChanged(
        host,
        "data-runtime-incident-count",
        String(incidentCounts.get(objectId) ?? 0),
      );
      setAttributeIfChanged(
        host,
        "data-runtime-maximum-delay-seconds",
        String(maximumDelays.get(objectId) ?? 0),
      );
      setAttributeIfChanged(host, "data-runtime-semantic-level", semanticLevel);
    });
  }, [artworkEpoch, positionedTrains, semanticLevel, simulation.decisionRevision, simulation.incidents]);

  const fitPoints = (points: readonly NativePoint[], minimumZoom = 1.5): void => {
    if (points.length === 0) return;
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const requestedSize = Math.max(maxX - minX, maxY - minY, ROOT_VIEW.width / MAX_ZOOM) * 1.7;
    const maximumSize = ROOT_VIEW.width / minimumZoom;
    const size = clamp(requestedSize, ROOT_VIEW.width / MAX_ZOOM, maximumSize);
    setView(normalizeView({
      x: (minX + maxX) / 2 - size / 2,
      y: (minY + maxY) / 2 - size / 2,
      width: size,
      height: size,
    }));
  };

  const focusStation = (station: NativeStation): void => {
    setSelection({ kind: "station", id: station.svgId });
    fitPoints([station.anchor], 4.8);
  };

  const focusLine = (line: NativeLine): void => {
    setFocusedLine(line.code);
    setSelection({ kind: "line", id: line.code });
    fitPoints(
      line.stationCodes
        .map((code) => NATIVE_STATION_BY_CODE.get(code)?.anchor)
        .filter((point): point is NativePoint => Boolean(point)),
      1.25,
    );
  };

  const focusIncident = (incident: NativeIncident): void => {
    setFocusedLine(incident.lineCode);
    setSelection({ kind: "incident", id: incident.id });
    const points = incident.affectedInterstationIds.flatMap((id) => {
      const interstation = NATIVE_INTERSTATION_BY_ID.get(id);
      if (!interstation) return [];
      const fromPoint: NativePoint | undefined = interstation.ports.from[0]
        ?? NATIVE_STATION_BY_CODE.get(interstation.fromStationCode)?.anchor;
      const toPoint: NativePoint | undefined = interstation.ports.to[0]
        ?? NATIVE_STATION_BY_CODE.get(interstation.toStationCode)?.anchor;
      return [fromPoint, toPoint].filter((point): point is NativePoint => point !== undefined);
    });
    fitPoints(points.length > 0 ? points : positionedIncidents
      .filter((entry) => entry.incident.id === incident.id)
      .map((entry) => entry.point), 1.8);
  };

  useEffect(() => {
    if (!focusIncidentId || !artworkEpoch) return;
    if (handledFocusRequestRef.current === focusIncidentId) return;
    const incident = simulation.incidents.find((candidate) => candidate.id === focusIncidentId);
    if (!incident) return;
    handledFocusRequestRef.current = focusIncidentId;
    focusIncident(incident);
    onIncidentActivate(incident.id);
  }, [artworkEpoch, focusIncidentId, onIncidentActivate, simulation.incidents]);

  useEffect(() => {
    if (!revealIncidentId || !artworkEpoch) return;
    if (handledRevealRequestRef.current === revealIncidentId) return;
    const incident = simulation.incidents.find((candidate) =>
      candidate.id === revealIncidentId && candidate.status === "active"
    );
    if (!incident) return;
    handledRevealRequestRef.current = revealIncidentId;
    focusIncident(incident);
  }, [artworkEpoch, revealIncidentId, simulation.incidents]);

  const fitProblems = (): void => {
    const points = positionedIncidents.map((entry) => entry.point);
    fitPoints(points.length > 0 ? points : [{ x: ROOT_VIEW.width / 2, y: ROOT_VIEW.height / 2 }], 1.15);
  };

  const submitStationSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const station = searchNativeStations(stationQuery, 1)[0];
    if (station) focusStation(station);
  };

  const stageCoordinates = (clientX: number, clientY: number): NativePoint => {
    const rectangle = stageRef.current?.getBoundingClientRect();
    if (!rectangle) return { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    const scale = Math.min(rectangle.width / view.width, rectangle.height / view.height);
    const offsetX = (rectangle.width - view.width * scale) / 2;
    const offsetY = (rectangle.height - view.height * scale) / 2;
    return {
      x: view.x + (clientX - rectangle.left - offsetX) / scale,
      y: view.y + (clientY - rectangle.top - offsetY) / scale,
    };
  };

  const setZoomAt = (nextZoom: number, anchor?: NativePoint): void => {
    const normalizedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const size = ROOT_VIEW.width / normalizedZoom;
    const point = anchor ?? { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    const ratioX = (point.x - view.x) / view.width;
    const ratioY = (point.y - view.y) / view.height;
    setView(normalizeView({
      x: point.x - ratioX * size,
      y: point.y - ratioY * size,
      width: size,
      height: size,
    }));
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setZoomAt(zoom * (event.deltaY < 0 ? 1.17 : 0.86), stageCoordinates(event.clientX, event.clientY));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (target instanceof Element && target.closest(".native-train-marker,.native-incident-marker,[data-object-id]")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      view,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const rectangle = stageRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rectangle) return;
    const scale = Math.min(rectangle.width / drag.view.width, rectangle.height / drag.view.height);
    setView(normalizeView({
      ...drag.view,
      x: drag.view.x - (event.clientX - drag.clientX) / scale,
      y: drag.view.y - (event.clientY - drag.clientY) / scale,
    }));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const selectedIncident = selection?.kind === "incident"
    ? simulation.incidents.find((incident) => incident.id === selection.id)
    : undefined;
  const selectedTrain = selection?.kind === "train"
    ? simulation.trains.find((train) => train.id === selection.id)
    : undefined;
  const selectedStation = selection?.kind === "station"
    ? NATIVE_STATION_BY_SVG_ID.get(selection.id)
    : undefined;
  const selectedInterstation = selection?.kind === "interstation"
    ? NATIVE_INTERSTATION_BY_ID.get(selection.id)
    : undefined;
  const selectedLine = selection?.kind === "line"
    ? NATIVE_LINE_BY_CODE.get(selection.id)
    : undefined;
  const impactedTrains = selectedIncident
    ? simulation.trains.filter((train) => selectedIncident.impactedTrainIds.includes(train.id))
    : [];


  return (
    <article className="native-network-panel" id="text-text-overview-network-map" aria-labelledby="native-network-title">
      <header className="native-network-panel__header" id="text-text-overview-network-header">
        <div>
          <span className="panel__eyebrow">NATIVE RATP SCHEMATIC · OPERATIONAL DIGITAL TWIN</span>
          <h2 id="native-network-title">Paris Metro + RER decision map</h2>
          <span id="text-text-overview-simulation-notice" className="native-network-panel__disclaimer" role="note">
            Simulated environment — no real railway system connected.
          </span>
        </div>
        <div className="native-map__scope" role="group" aria-label="Network scope">
          {(["all", "metro", "rer"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={scope === value ? "active" : ""}
              aria-pressed={scope === value}
              onClick={() => {
                setScope(value);
                setFocusedLine(null);
                setView(ROOT_VIEW);
              }}
            >
              {value === "all" ? "All 21 lines" : value === "metro" ? "16 Metro" : "RER A–E"}
            </button>
          ))}
        </div>
      </header>

      <div className="native-map__toolbar" id="text-text-overview-network-toolbar">
        <form className="native-map__search" onSubmit={submitStationSearch}>
          <label>
            Find station or IDFM code
            <input
              value={stationQuery}
              list="native-station-options"
              placeholder="Châtelet, Nation, IDFM:71673…"
              onChange={(event) => setStationQuery(event.target.value)}
            />
          </label>
          <datalist id="native-station-options">
            {NATIVE_STATIONS.map((station) => (
              <option key={station.code} value={station.name}>{station.code}</option>
            ))}
          </datalist>
          <button type="submit">Locate</button>
        </form>
        <div className="native-map__toolbar-actions">
          <button type="button" onClick={fitProblems}><Icon name="alert" size={14}/> Fit problems</button>
          <output aria-live="polite">{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="Zoom out" onClick={() => setZoomAt(zoom / 1.3)}>−</button>
          <button type="button" onClick={() => { setView(ROOT_VIEW); setFocusedLine(null); }}>Fit</button>
          <button type="button" aria-label="Zoom in" onClick={() => setZoomAt(zoom * 1.3)}>+</button>
        </div>
      </div>

      <div className="native-map__workspace" id="text-text-overview-network-workspace">
        <nav className="native-map__lines" id="text-text-overview-network-lines" aria-label="Native network lines">
          <button
            type="button"
            className={focusedLine === null ? "active" : ""}
            onClick={() => {
              setFocusedLine(null);
              setSelection(null);
              setView(ROOT_VIEW);
            }}
          >
            <span className="native-map__line-badge" style={{ color: "#147d62" }}>ALL</span>
            <span><strong>Network fit</strong><small>21 rendered lines</small></span>
          </button>
          {visibleLines.map((line) => (
            <button
              type="button"
              key={line.code}
              className={focusedLine === line.code ? "active" : ""}
              aria-pressed={focusedLine === line.code}
              onClick={() => focusedLine === line.code
                ? (setFocusedLine(null), setView(ROOT_VIEW))
                : focusLine(line)}
            >
              <span
                className="native-map__line-badge"
                style={{ color: line.color, borderColor: line.color }}
              >
                {line.label}
              </span>
              <span>
                <strong>{line.name}</strong>
                <small>{line.stationCodes.length} stations · {line.interstationIds.length} zones</small>
              </span>
            </button>
          ))}
        </nav>

        <div
          ref={stageRef}
          id="text-text-overview-network-canvas"
          className="native-map__stage"
          data-semantic-level={semanticLevel}
          data-dragging={dragging}
          data-testid="native-network-stage"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <span className="native-map__level" aria-live="polite">
            {semanticLevel === "overview"
              ? "Overview · problem indicators"
              : semanticLevel === "operations"
                ? "Operations · trains and missions"
                : "Detail · exact objects and evidence"}
          </span>
          {artworkError && <div className="native-map__loading" role="alert">{artworkError}</div>}
          {!artwork && !artworkError && (
            <div className="native-map__loading" role="status">Loading the canonical native SVG…</div>
          )}
          {artwork && (
            <div
              ref={artworkRef}
              className="native-map__artwork"
              data-native-map-file={NATIVE_NETWORK_MANIFEST.svg.file}
              dangerouslySetInnerHTML={{ __html: artwork }}
            />
          )}
          {artworkEpoch > 0 && semanticLevel === "overview" && delayClusters.map((cluster) => {
            const binding = runtimeHosts.current.get(cluster.objectId);
            const localPoint = pointInObject(cluster.objectId, cluster.point);
            const line = NATIVE_LINE_BY_CODE.get(cluster.lineCode);
            const operationalForeground = operationalForegroundLayersRef.current?.state;
            if (!binding || !localPoint || !operationalForeground) return null;
            const markerScale = localRuntimeScale("indicator");
            const clusterId = "delay-" + cluster.objectId;
            const anchorId = "runtime-anchor-" + clusterId;
            return [
              createPortal(
                <g
                  id={anchorId}
                  className="native-runtime-semantic-anchor"
                  data-runtime-entity="delay-cluster"
                  data-operational-kind="delay-cluster"
                  data-delay-cluster-id={clusterId}
                  data-anchor-object-id={cluster.objectId}
                  data-native-x={cluster.point.x.toFixed(3)}
                  data-native-y={cluster.point.y.toFixed(3)}
                  transform={"translate(" + localPoint.x + " " + localPoint.y + ")"}
                  aria-hidden="true"
                />,
                binding.layers.state,
                clusterId + "-anchor",
              ),
              createPortal(
              <g
                className="native-delay-cluster native-incident-marker native-incident-marker--medium"
                data-runtime-presentation="delay-cluster"
                data-runtime-presentation-for={"delay-cluster:" + cluster.objectId}
                data-presentation-delay-cluster-id={clusterId}
                data-runtime-anchor-ref={anchorId}
                data-anchor-object-id={cluster.objectId}
                data-native-x={cluster.point.x.toFixed(3)}
                data-native-y={cluster.point.y.toFixed(3)}
                data-pixel-density={runtimePixelDensity(zoom, "indicator").toFixed(3)}
                transform={"translate(" + cluster.point.x + " " + cluster.point.y + ")"}
                role="button"
                tabIndex={0}
                aria-label={
                  cluster.count + " delayed trains on " + lineLabel(cluster.lineCode) +
                  ", maximum " + formatDelay(cluster.maximumDelaySeconds)
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (line) focusLine(line);
                }}
                onKeyDown={(event) => activateWithKeyboard(event, () => {
                  if (line) focusLine(line);
                })}
              >
                <g className="native-runtime-counter-scale" transform={"scale(" + markerScale + ")"}>
                  <circle r="17" className="native-incident-marker__plate"/>
                  <circle r="10" fill="#fff6e9" stroke="#9a5700" strokeWidth="2"/>
                  <path d="M 0 -6 L 0 0 L 5 3" fill="none" stroke="#9a5700" strokeWidth="2.4" strokeLinecap="round"/>
                  <text x="11" y="-9">{cluster.count}</text>
                  <title>{lineLabel(cluster.lineCode)} · delayed-train hotspot on this station or interstation</title>
                </g>
              </g>,
              operationalForeground,
              clusterId + "-presentation",
              ),
            ];
          })}

          {artworkEpoch > 0 && positionedIncidents.map(({ incident, ownerId, point }) => {
            const binding = runtimeHosts.current.get(ownerId);
            const localPoint = pointInObject(ownerId, point);
            const operationalForeground = operationalForegroundLayersRef.current?.incidents;
            if (!binding || !localPoint || !operationalForeground) return null;
            const markerClass = [
              "native-incident-marker",
              "native-incident-marker--" + incident.severity,
              "native-incident-marker--" + incident.type,
              "native-incident-marker--symbol-" + nativeIncidentMarkerSymbol(incident),
            ].join(" ");
            const markerSymbol = nativeIncidentMarkerSymbol(incident);
            const occurrenceLabel = formatIncidentTime(incident.startedAt);
            const detailed = semanticLevel === "detail";
            const iconDensity = runtimePixelDensity(zoom, "incident-icon");
            const tagDensity = runtimePixelDensity(zoom, "incident-tag");
            const iconScale = localRuntimeScale("incident-icon");
            const tagScale = localRuntimeScale("incident-tag");
            const tagOnLeft = point.x > view.x + view.width * 0.64;
            const tagVerticalOffset = point.y < view.y + view.height * 0.12
              ? 42
              : point.y > view.y + view.height * 0.88
                ? -42
                : 0;
            const tagVerticalSide = tagVerticalOffset > 0
              ? "below"
              : tagVerticalOffset < 0
                ? "above"
                : "center";
            const anchorId = "runtime-anchor-incident-" + incident.id;
            return [
              createPortal(
                <g
                  id={anchorId}
                  className="native-runtime-semantic-anchor"
                  data-runtime-entity="incident"
                  data-operational-kind="incident"
                  data-incident-id={incident.id}
                  data-anchor-object-id={ownerId}
                  data-native-x={point.x.toFixed(3)}
                  data-native-y={point.y.toFixed(3)}
                  data-semantic-density={semanticLevel}
                  transform={"translate(" + localPoint.x + " " + localPoint.y + ")"}
                  aria-hidden="true"
                />,
                binding.layers.incidents,
                "incident-anchor-" + incident.id,
              ),
              createPortal(
              <g
                className={markerClass}
                data-runtime-presentation="incident"
                data-runtime-presentation-for={"incident:" + incident.id}
                data-presentation-incident-id={incident.id}
                data-runtime-anchor-ref={anchorId}
                data-anchor-object-id={ownerId}
                data-native-x={point.x.toFixed(3)}
                data-native-y={point.y.toFixed(3)}
                data-semantic-density={semanticLevel}
                data-pixel-density={iconDensity.toFixed(3)}
                data-icon-pixel-density={iconDensity.toFixed(3)}
                data-tag-pixel-density={tagDensity.toFixed(3)}
                data-tag-side={tagOnLeft ? "left" : "right"}
                data-tag-vertical-side={tagVerticalSide}
                data-incident-effect={incident.effect}
                data-incident-symbol={markerSymbol}
                data-incident-started-at={incident.startedAt}
                data-incident-occurrence={new Date(incident.startedAt).toISOString()}
                transform={"translate(" + point.x + " " + point.y + ")"}
                role="button"
                tabIndex={0}
                aria-label={
                  incident.title + ", " + lineLabel(incident.lineCode) + ", " + incident.severity +
                  ", occurrence " + occurrenceLabel
                }
                onClick={(event) => {
                  event.stopPropagation();
                  focusIncident(incident);
                  onIncidentActivate(incident.id);
                }}
                onKeyDown={(event) => activateWithKeyboard(event, () => {
                  focusIncident(incident);
                  onIncidentActivate(incident.id);
                })}
              >
                <g
                  className="native-runtime-counter-scale native-runtime-counter-scale--incident-icon"
                  transform={"scale(" + iconScale + ")"}
                >
                  <circle r="25" className="native-incident-marker__pulse"/>
                  <circle r="16" className="native-incident-marker__plate"/>
                  {markerSymbol === "power" ? (
                    <path
                      className="native-incident-marker__symbol"
                      d="M 2 -11 L -7 2 L -1 2 L -4 11 L 8 -4 L 2 -4 Z"
                    />
                  ) : markerSymbol === "baggage" ? (
                    <g className="native-incident-marker__baggage" aria-hidden="true">
                      <path
                        className="native-incident-marker__baggage-handle"
                        d="M -4 -6 V -9 Q -4 -11 0 -11 Q 4 -11 4 -9 V -6"
                      />
                      <rect
                        className="native-incident-marker__baggage-body"
                        x="-9"
                        y="-6"
                        width="18"
                        height="15"
                        rx="2.5"
                      />
                      <path
                        className="native-incident-marker__baggage-detail"
                        d="M -4 -2 V 5 M 4 -2 V 5 M -7 1 H 7"
                      />
                    </g>
                  ) : (
                    <>
                      <path className="native-incident-marker__symbol" d="M 0 -11 L 11 10 L -11 10 Z"/>
                      <path d="M 0 -5 L 0 3 M 0 7 L 0 7.2" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/>
                    </>
                  )}
                </g>
                {semanticLevel !== "overview" && (
                  <g
                    className="native-runtime-counter-scale native-runtime-counter-scale--incident-tag"
                    transform={"scale(" + tagScale + ")"}
                  >
                    <g
                      className={"native-object-tag native-object-tag--" + semanticLevel}
                      transform={tagOnLeft || tagVerticalOffset
                        ? "translate(" + (tagOnLeft ? (detailed ? -216 : -154) : 0) +
                          " " + tagVerticalOffset + ")"
                        : undefined}
                    >
                      <rect
                        className="native-object-tag__plate"
                        x="20"
                        y={detailed ? -24 : -16}
                        width={detailed ? 176 : 114}
                        height={detailed ? 52 : 29}
                        rx="7"
                      />
                      <text x="28" y={detailed ? -11 : -5} className="native-object-tag__title">
                        {incident.id}
                      </text>
                      <text x="28" y={detailed ? 2 : 8} className="native-object-tag__line">
                        {detailed
                          ? shorten(incident.title, 30)
                          : lineLabel(incident.lineCode) + " · " + incident.severity}
                      </text>
                      {detailed && (
                        <>
                          <text x="28" y="15" className="native-object-tag__line">
                            {shorten(incident.location, 32)}
                          </text>
                          <text x="28" y="27" className="native-object-tag__meta">
                            {occurrenceLabel + " · " + incident.restrictionMode}
                          </text>
                        </>
                      )}
                    </g>
                  </g>
                )}
                <title>{incident.id} · {incident.title} · {incident.location} · {occurrenceLabel}</title>
              </g>,
              operationalForeground,
              "incident-presentation-" + incident.id,
              ),
            ];
          })}

          {artworkEpoch > 0 && activeBusServices.map((service) => {
            const foreground = operationalForegroundLayersRef.current?.state;
            if (!foreground) return null;
            const scale = localRuntimeScale("indicator");
            return createPortal(
              <g
                className="native-bus-marker"
                data-bus-service-id={service.id}
                data-incident-id={service.incidentId ?? undefined}
                transform={"translate(" + service.point.x + " " + service.point.y + ")"}
                aria-label={service.incidentId
                  ? "Replacement bus service " + service.id + " for " + service.incidentId
                  : "Manual shuttle " + service.id + " · " + service.cyclePhase}
              >
                <g transform={"scale(" + scale + ")"}>
                  <circle r="17" className="native-bus-marker__plate"/>
                  <rect x="-9" y="-7" width="18" height="13" rx="3" className="native-bus-marker__body"/>
                  <path d="M -6 -3 H 6 M -5 8 V 5 M 5 8 V 5" className="native-bus-marker__detail"/>
                  <circle cx="-5" cy="3" r="1.4"/><circle cx="5" cy="3" r="1.4"/>
                  <text x="13" y="-9">BUS</text>
                </g>
                <title>{service.id + " · " + service.cyclePhase + (service.incidentId ? " · shuttle for " + service.incidentId : " · manual operator order")}</title>
              </g>,
              foreground,
              "bus-service-" + service.id,
            );
          })}

          {artworkEpoch > 0 && semanticLevel !== "overview" && positionedTrains.map(({
            train,
            ownerId,
            point,
            laneOffset,
          }) => {
            const binding = runtimeHosts.current.get(ownerId);
            const localPoint = pointInObject(ownerId, point);
            const operationalForeground = operationalForegroundLayersRef.current?.trains;
            if (!binding || !localPoint || !operationalForeground) return null;
            const line = NATIVE_LINE_BY_CODE.get(train.lineCode);
            const trainClass = [
              "native-train-marker",
              train.delaySeconds >= 300 ? "native-train-marker--delayed" : "",
              train.status === "held" ? "native-train-marker--held" : "",
              selection?.kind === "train" && selection.id === train.id
                ? "native-train-marker--selected"
                : "",
            ].filter(Boolean).join(" ");
            const bodyDensity = runtimePixelDensity(zoom, "train-body");
            const detailDensity = runtimePixelDensity(zoom, "train-detail");
            const bodyScale = localRuntimeScale("train-body");
            const detailScale = localRuntimeScale("train-detail");
            const tagOnLeft = point.x > view.x + view.width * 0.7;
            const detailAbove = point.y > view.y + view.height * 0.7;
            const locationLabel = train.location.type === "station"
              ? stationName(train.location.id)
              : stationName(train.fromStationCode) + " — " + stationName(train.toStationCode);
            const anchorId = "runtime-anchor-train-" + train.id;
            return [
              createPortal(
                <g
                  id={anchorId}
                  className="native-runtime-semantic-anchor"
                  data-runtime-entity="train"
                  data-operational-kind="train"
                  data-train-id={train.id}
                  data-mission={train.mission}
                  data-current-interstation-id={train.currentInterstationId}
                  data-anchor-object-id={ownerId}
                  data-native-x={point.x.toFixed(3)}
                  data-native-y={point.y.toFixed(3)}
                  data-operational-location-type={train.location.type}
                  data-operational-location-id={train.location.id}
                  data-semantic-density={semanticLevel}
                  data-lane-offset={laneOffset.toFixed(2)}
                  transform={"translate(" + localPoint.x + " " + localPoint.y + ")"}
                  aria-hidden="true"
                />,
                binding.layers.trains,
                "train-anchor-" + train.id,
              ),
              createPortal(
              <g
                className={trainClass}
                data-runtime-presentation="train"
                data-runtime-presentation-for={"train:" + train.id}
                data-presentation-train-id={train.id}
                data-runtime-anchor-ref={anchorId}
                data-mission={train.mission}
                data-current-interstation-id={train.currentInterstationId}
                data-anchor-object-id={ownerId}
                data-native-x={point.x.toFixed(3)}
                data-native-y={point.y.toFixed(3)}
                data-operational-location-type={train.location.type}
                data-operational-location-id={train.location.id}
                data-semantic-density={semanticLevel}
                data-pixel-density={bodyDensity.toFixed(3)}
                data-body-pixel-density={bodyDensity.toFixed(3)}
                data-detail-pixel-density={detailDensity.toFixed(3)}
                data-lane-offset={laneOffset.toFixed(2)}
                data-tag-side={tagOnLeft ? "left" : "right"}
                data-detail-side={detailAbove ? "above" : "below"}
                transform={"translate(" + point.x + " " + point.y + ")"}
                role="button"
                tabIndex={semanticLevel === "detail" && focusedLine === train.lineCode ? 0 : -1}
                aria-label={
                  train.circulationId + ", mission " + train.mission + ", " +
                  (train.location.type === "station" ? "at station " : "on interstation ") +
                  locationLabel + ", " + formatDelay(train.delaySeconds)
                }
                onClick={(event) => {
                  event.stopPropagation();
                  setSelection({ kind: "train", id: train.id });
                }}
                onKeyDown={(event) => activateWithKeyboard(event, () => {
                  setSelection({ kind: "train", id: train.id });
                })}
              >
                <g
                  className="native-runtime-counter-scale native-runtime-counter-scale--train-body"
                  transform={"scale(" + bodyScale + ") translate(0 " + laneOffset + ")"}
                >
                  <rect x="-22" y="-9" width="44" height="18" rx="6" className="native-train-marker__body"/>
                  <circle cx="-14" cy="0" r="4" fill={line?.color ?? "#147d62"}/>
                  <text x="-7" y="2.6">{train.mission}</text>
                  {train.delaySeconds >= 300 && (
                    <text x="25" y="-1" className="native-train-marker__delay">
                      {formatDelay(train.delaySeconds)}
                    </text>
                  )}
                </g>
                {semanticLevel === "detail" && (
                  <g
                    className="native-runtime-counter-scale native-runtime-counter-scale--train-detail"
                    transform={"scale(" + detailScale + ") translate(0 " + laneOffset + ")"}
                  >
                    <g
                      className="native-train-marker__detail"
                      transform={tagOnLeft || detailAbove
                        ? "translate(" + (tagOnLeft ? -106 : 0) + " " + (detailAbove ? -58 : 0) + ")"
                        : undefined}
                    >
                      <rect x="-22" y="13" width="150" height="32" rx="6"/>
                      <text x="-16" y="26">{train.circulationId + " · " + train.status}</text>
                      <text x="-16" y="39" className="native-object-tag__meta">
                        {shorten(locationLabel, 25) + " · " + formatDelay(train.delaySeconds)}
                      </text>
                    </g>
                  </g>
                )}
                <title>
                  {train.id + " · " + train.circulationId + " · " +
                  stationName(train.fromStationCode) + " → " + stationName(train.toStationCode)}
                </title>
              </g>,
              operationalForeground,
              "train-presentation-" + train.id,
              ),
            ];
          })}

          {artworkEpoch > 0 && semanticLevel === "detail" && selectedStation && (() => {
            const binding = runtimeHosts.current.get(selectedStation.svgId);
            const localPoint = pointInObject(selectedStation.svgId, selectedStation.anchor);
            const operationalForeground = operationalForegroundLayersRef.current?.context;
            if (!binding || !localPoint || !operationalForeground) return null;
            const markerScale = localRuntimeScale("context");
            const tagOnLeft = selectedStation.anchor.x > view.x + view.width * 0.7;
            const tagAbove = selectedStation.anchor.y > view.y + view.height * 0.78;
            const anchorId = "runtime-anchor-context-station-" + selectedStation.svgId;
            return [
              createPortal(
                <g
                  id={anchorId}
                  className="native-runtime-semantic-anchor"
                  data-runtime-entity="object-context"
                  data-operational-kind="station-context"
                  data-anchor-object-id={selectedStation.svgId}
                  transform={"translate(" + localPoint.x + " " + localPoint.y + ")"}
                  aria-hidden="true"
                />,
                binding.layers.context,
                "station-context-anchor-" + selectedStation.svgId,
              ),
              createPortal(
              <g
                className="native-object-state-tag"
                data-runtime-presentation="object-context"
                data-runtime-presentation-for={"station-context:" + selectedStation.svgId}
                data-runtime-anchor-ref={anchorId}
                data-anchor-object-id={selectedStation.svgId}
                data-pixel-density={runtimePixelDensity(zoom, "context").toFixed(3)}
                data-tag-side={tagOnLeft ? "left" : "right"}
                data-tag-vertical-side={tagAbove ? "above" : "below"}
                transform={"translate(" + selectedStation.anchor.x + " " + selectedStation.anchor.y + ")"}
                pointerEvents="none"
              >
                <g className="native-runtime-counter-scale" transform={"scale(" + markerScale + ")"}>
                  <g transform={"translate(" + (tagOnLeft ? -186 : 18) + " " + (tagAbove ? -52 : 20) + ")"}>
                    <rect width="168" height="32" rx="7"/>
                    <text x="8" y="13" className="native-object-tag__title">STATION · {shorten(selectedStation.name, 28)}</text>
                    <text x="8" y="25" className="native-object-tag__meta">
                      {selectedStation.code + " · " + selectedStation.lines.join(" / ")}
                    </text>
                  </g>
                </g>
              </g>,
              operationalForeground,
              "station-context-presentation-" + selectedStation.svgId,
              ),
            ];
          })()}

          {artworkEpoch > 0 && semanticLevel === "detail" && selectedInterstation && (() => {
            const binding = runtimeHosts.current.get(selectedInterstation.id);
            const point = pointOnInterstation(selectedInterstation.id, 0.5);
            const localPoint = point ? pointInObject(selectedInterstation.id, point) : null;
            const operationalForeground = operationalForegroundLayersRef.current?.context;
            if (!binding || !point || !localPoint || !operationalForeground) return null;
            const markerScale = localRuntimeScale("context");
            const tagOnLeft = point.x > view.x + view.width * 0.7;
            const tagAbove = point.y > view.y + view.height * 0.78;
            const trainCount = simulation.trains.filter(
              (train) => train.location.type === "interstation" && train.location.id === selectedInterstation.id,
            ).length;
            const incidentCount = simulation.incidents.filter(
              (incident) => incident.status === "active" && incident.affectedInterstationIds.includes(selectedInterstation.id),
            ).length;
            const anchorId = "runtime-anchor-context-interstation-" + selectedInterstation.id;
            return [
              createPortal(
                <g
                  id={anchorId}
                  className="native-runtime-semantic-anchor"
                  data-runtime-entity="object-context"
                  data-operational-kind="interstation-context"
                  data-anchor-object-id={selectedInterstation.id}
                  data-native-x={point.x.toFixed(3)}
                  data-native-y={point.y.toFixed(3)}
                  transform={"translate(" + localPoint.x + " " + localPoint.y + ")"}
                  aria-hidden="true"
                />,
                binding.layers.context,
                "interstation-context-anchor-" + selectedInterstation.id,
              ),
              createPortal(
              <g
                className="native-object-state-tag"
                data-runtime-presentation="object-context"
                data-runtime-presentation-for={"interstation-context:" + selectedInterstation.id}
                data-runtime-anchor-ref={anchorId}
                data-anchor-object-id={selectedInterstation.id}
                data-native-x={point.x.toFixed(3)}
                data-native-y={point.y.toFixed(3)}
                data-pixel-density={runtimePixelDensity(zoom, "context").toFixed(3)}
                data-tag-side={tagOnLeft ? "left" : "right"}
                data-tag-vertical-side={tagAbove ? "above" : "below"}
                transform={"translate(" + point.x + " " + point.y + ")"}
                pointerEvents="none"
              >
                <g className="native-runtime-counter-scale" transform={"scale(" + markerScale + ")"}>
                  <g transform={"translate(" + (tagOnLeft ? -202 : 18) + " " + (tagAbove ? -52 : 20) + ")"}>
                    <rect width="184" height="32" rx="7"/>
                    <text x="8" y="13" className="native-object-tag__title">
                      {lineLabel(selectedInterstation.lineCode) + " · INTERSTATION"}
                    </text>
                    <text x="8" y="25" className="native-object-tag__meta">
                      {trainCount + " trains · " + incidentCount + " incidents · " +
                        selectedInterstation.collapsedStopCount + " contracted stops"}
                    </text>
                  </g>
                </g>
              </g>,
              operationalForeground,
              "interstation-context-presentation-" + selectedInterstation.id,
              ),
            ];
          })()}
        </div>

        <aside className="native-map__inspector" id="text-text-overview-network-inspector" aria-label="Network object inspector">
          <div className="native-map__kpis" id="text-text-overview-network-status" aria-label="Current network indicators">
            <div><small>ACTIVE INCIDENTS</small><strong>{simulation.metrics.activeIncidentCount}</strong></div>
            <div><small>PUNCTUALITY</small><strong>{simulation.metrics.networkPunctualityPercent}%</strong></div>
            <div><small>TRAINS</small><strong>{simulation.metrics.fleetSize}</strong></div>
            <div><small>HELD</small><strong>{simulation.metrics.heldTrainCount}</strong></div>
            <div><small>BLOCKED ZONES</small><strong>{simulation.metrics.blockedInterstationCount}</strong></div>
            <div><small>DECISION REV.</small><strong>{simulation.decisionRevision}</strong></div>
          </div>
          {selectedIncident ? (
            <>
              <header>
                <small>INCIDENT · {selectedIncident.id}</small>
                <strong>{selectedIncident.title}</strong>
                <span>{selectedIncident.location} · {selectedIncident.owner}</span>
              </header>
              <div className="native-map__inspector-body">
                <div>
                  <dl className="native-map__facts">
                    <div><dt>Line</dt><dd>{lineLabel(selectedIncident.lineCode)}</dd></div>
                    <div><dt>Severity</dt><dd>{selectedIncident.severity}</dd></div>
                    <div>
                      <dt>Occurrence</dt>
                      <dd>
                        <time dateTime={new Date(selectedIncident.startedAt).toISOString()}>
                          {formatIncidentTime(selectedIncident.startedAt)}
                        </time>
                      </dd>
                    </div>
                    <div><dt>Restriction</dt><dd>{selectedIncident.restrictionMode}</dd></div>
                    <div><dt>Decision rev.</dt><dd>{simulation.decisionRevision}</dd></div>
                    <div><dt>Impacted trains</dt><dd>{selectedIncident.impactedTrainIds.length}</dd></div>
                    <div><dt>Source</dt><dd>versioned operational state</dd></div>
                  </dl>
                  <p className="panel-copy">{selectedIncident.summary}</p>
                  <div className="native-map__impact-list">
                    {impactedTrains.slice(0, 6).map((train) => (
                      <span key={train.id}>
                        <b>{train.mission} · {train.circulationId}</b>
                        <em>{formatDelay(train.delaySeconds)}</em>
                      </span>
                    ))}
                    {impactedTrains.length === 0 && (
                      <span><b>No train currently inside the impact window</b><em>protected upstream</em></span>
                    )}
                  </div>
                </div>
                <div className="native-map__agent">
                  <small>WEBMCP TOOL PATH</small>
                  <p>
                    A WebMCP-compatible client can inspect this exact revision and compare
                    responses. Any state-changing action still requires visible operator approval.
                  </p>
                  <code>
                    inspect_incident_decision_context → search_operational_procedures →
                    get_operational_procedure → assess_operator_procedure_choice →
                    apply_reviewed_procedure_step
                  </code>
                  <button type="button" className="button button--secondary" onClick={() => {
                    window.location.hash = "/incidents";
                  }}>
                    Open cross-domain incident queue
                  </button>
                </div>
              </div>
            </>
          ) : selectedTrain ? (
            <>
              <header>
                <small>TRAIN · {selectedTrain.id}</small>
                <strong>{selectedTrain.circulationId} · mission {selectedTrain.mission}</strong>
                <span>{stationName(selectedTrain.originStationCode)} → {stationName(selectedTrain.destinationStationCode)}</span>
              </header>
              <div className="native-map__inspector-body">
                <dl className="native-map__facts">
                  <div><dt>Line</dt><dd>{lineLabel(selectedTrain.lineCode)}</dd></div>
                  <div><dt>Status</dt><dd>{selectedTrain.status}</dd></div>
                  <div><dt>Location type</dt><dd>{selectedTrain.location.type}</dd></div>
                  <div><dt>Location</dt><dd>{selectedTrain.location.type === "station"
                    ? stationName(selectedTrain.location.id)
                    : stationName(selectedTrain.fromStationCode) + " — " + stationName(selectedTrain.toStationCode)}</dd></div>
                  <div><dt>Delay</dt><dd>{formatDelay(selectedTrain.delaySeconds)}</dd></div>
                  <div><dt>Passengers</dt><dd>{selectedTrain.passengers}</dd></div>
                  <div><dt>Next station</dt><dd>{stationName(selectedTrain.nextStationCode)}</dd></div>
                  <div><dt>Quality</dt><dd>{selectedTrain.quality}</dd></div>
                </dl>
                <div className="native-map__agent">
                  <small>AGENT CONTEXT</small>
                  <p>Use inspect_network_digital_twin with line {selectedTrain.lineCode}, then inspect the related incident context.</p>
                </div>
              </div>
            </>
          ) : selectedStation ? (
            <>
              <header>
                <small>STATION · {selectedStation.code}</small>
                <strong>{selectedStation.name}</strong>
                <span>{selectedStation.lines.map(lineLabel).join(" · ")}</span>
              </header>
              <div className="native-map__inspector-body">
                <dl className="native-map__facts">
                  <div><dt>Native object</dt><dd>{selectedStation.svgId}</dd></div>
                  <div><dt>Lines</dt><dd>{selectedStation.lines.length}</dd></div>
                  <div><dt>Trains at station</dt><dd>{simulation.trains.filter(
                    (train) => train.location.type === "station" && train.location.id === selectedStation.code,
                  ).length}</dd></div>
                  <div><dt>Visual</dt><dd>{selectedStation.visual.status}</dd></div>
                  <div><dt>Provenance</dt><dd>IDFM GTFS crosswalk</dd></div>
                </dl>
                <div className="native-map__inspector-actions" id="text-text-overview-station-incident-actions">
                  <button
                    type="button"
                    className="button button--danger"
                    data-testid="native-declare-incident"
                    data-incident-target-type="station"
                    data-incident-target-id={selectedStation.code}
                    data-incident-line-code={focusedLine && selectedStation.lines.includes(focusedLine)
                      ? focusedLine
                      : selectedStation.lines[0]}
                    aria-label={`Declare an incident at ${selectedStation.name}`}
                    onClick={() => onDeclareIncident({
                      targetType: "station",
                      targetId: selectedStation.code,
                      lineCode: focusedLine && selectedStation.lines.includes(focusedLine)
                        ? focusedLine
                        : selectedStation.lines[0],
                    })}
                  >
                    <Icon name="alert" size={15} /> Declare incident
                  </button>
                </div>
              </div>
            </>
          ) : selectedInterstation ? (
            <>
              <header>
                <small>INTERSTATION · {selectedInterstation.lineCode}</small>
                <strong>
                  {stationName(selectedInterstation.fromStationCode)} — {stationName(selectedInterstation.toStationCode)}
                </strong>
                <span>{selectedInterstation.id}</span>
              </header>
              <div className="native-map__inspector-body">
                <dl className="native-map__facts">
                  <div><dt>Path parts</dt><dd>{selectedInterstation.pathIds.length}</dd></div>
                  <div><dt>Collapsed stops</dt><dd>{selectedInterstation.collapsedStopCount}</dd></div>
                  <div><dt>Endpoint model</dt><dd>{selectedInterstation.endpointModel}</dd></div>
                  <div><dt>State</dt><dd>{activeAffectedIds.has(selectedInterstation.id) ? "restricted" : "available"}</dd></div>
                </dl>
                <div className="native-map__inspector-actions" id="text-text-overview-interstation-incident-actions">
                  <button
                    type="button"
                    className="button button--danger"
                    data-testid="native-declare-incident"
                    data-incident-target-type="interstation"
                    data-incident-target-id={selectedInterstation.id}
                    data-incident-line-code={selectedInterstation.lineCode}
                    aria-label={`Declare an incident between ${stationName(selectedInterstation.fromStationCode)} and ${stationName(selectedInterstation.toStationCode)}`}
                    onClick={() => onDeclareIncident({
                      targetType: "interstation",
                      targetId: selectedInterstation.id,
                      lineCode: selectedInterstation.lineCode,
                    })}
                  >
                    <Icon name="alert" size={15} /> Declare incident
                  </button>
                </div>
              </div>
            </>
          ) : selectedLine ? (
            <>
              <header>
                <small>LINE · {selectedLine.code}</small>
                <strong>{selectedLine.name}</strong>
                <span>Native rendered scope</span>
              </header>
              <div className="native-map__inspector-body">
                <dl className="native-map__facts">
                  <div><dt>Stations</dt><dd>{selectedLine.stationCodes.length}</dd></div>
                  <div><dt>Interstations</dt><dd>{selectedLine.interstationIds.length}</dd></div>
                  <div><dt>Mode</dt><dd>{selectedLine.mode}</dd></div>
                  <div><dt>Trains in scope</dt><dd>{simulation.trains.filter((train) => train.lineCode === selectedLine.code).length}</dd></div>
                </dl>
              </div>
            </>
          ) : (
            <div className="native-map__empty">
              <div>
                <Icon name="network" size={30}/>
                <strong>Select a problem or zoom into operations</strong>
                <p>
                  At overview level only durable problem indicators are shown.
                  Zoom reveals missions, delays and exact native objects.
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>

      <footer className="native-network__footer" id="text-text-overview-network-legend">
        <span><i className="train"/>Train / mission at operational zoom</span>
        <span><i className="incident"/>Operational incident</span>
        <span><i className="works"/>Engineering works</span>
        <span><i className="power"/>Power constraint</span>
        <span className="truth">
          <Icon name="shield" size={13}/> Native RATP schematic + IDFM crosswalk · versioned operational state · operator-approved actions
        </span>
      </footer>
    </article>
  );
}
