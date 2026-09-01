import topologyFixture from "./generated/ratpTopology.json";
import type { LineId } from "./domain";

export type RatpNetworkLineId =
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
  | "RER_B";

export interface RatpNetworkStop {
  id: string;
  hubId: string;
  name: string;
  longitude: number;
  latitude: number;
}

export interface RatpNetworkEdge {
  id: string;
  from: string;
  to: string;
}

export interface RatpNetworkLine {
  id: RatpNetworkLineId;
  routeId: string;
  label: string;
  name: string;
  mode: "metro" | "rer";
  color: string;
  textColor: string;
  tripCount: number;
  terminalStopIds: readonly string[];
  stops: readonly RatpNetworkStop[];
  edges: readonly RatpNetworkEdge[];
  operationalLineId?: LineId;
}

export interface RatpNetworkTopology {
  schema: string;
  generatedAt: string;
  source: {
    authority: string;
    dataset: string;
    url: string;
  };
  lineCount: number;
  stationOccurrenceCount: number;
  physicalStationCount: number;
  interstationCount: number;
  lines: readonly RatpNetworkLine[];
}

const OPERATIONAL_BINDINGS: Partial<Record<RatpNetworkLineId, LineId>> = {
  M13: "M13",
  M14: "M14",
  RER_A: "RER_A",
  RER_B: "RER_B",
};

const fixture = topologyFixture as RatpNetworkTopology;

export const RATP_NETWORK_LINES: readonly RatpNetworkLine[] = fixture.lines.map((line) => ({
  ...line,
  operationalLineId: OPERATIONAL_BINDINGS[line.id],
}));

export const RATP_NETWORK_TOPOLOGY: RatpNetworkTopology = {
  ...fixture,
  lines: RATP_NETWORK_LINES,
};

function stableIdPart(value: string): string {
  return value
    .replace(/^IDFM:/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function ratpNetworkStationId(hubId: string): string {
  return `RATP-ST-${stableIdPart(hubId)}`;
}

export function ratpNetworkZoneId(lineId: RatpNetworkLineId, fromStopId: string, toStopId: string): string {
  return `${lineId}-IZ-${stableIdPart(fromStopId)}--${stableIdPart(toStopId)}`;
}
