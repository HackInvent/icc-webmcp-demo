import type { PowerStatus } from "./domain";
import {
  NATIVE_LINE_BY_CODE,
  NATIVE_LINES,
  type NativeLine,
  type NativeLineCode,
} from "./nativeNetwork";
import type { NativeIncident, NativeSimulationSnapshot } from "./nativeSimulation";
import { buildNativeLineSynoptic } from "./regulationModel";

const TRACTION_POWER_LINE_ORDER: readonly NativeLineCode[] = [
  "M1", "M2", "M3", "M3BIS", "M4", "M5", "M6", "M7", "M7BIS", "M8", "M9", "M10", "M11", "M12", "M13", "M14",
  "RER_A", "RER_B", "RER_C", "RER_D", "RER_E",
];

export const TRACTION_POWER_LINES: readonly NativeLine[] = Object.freeze(
  TRACTION_POWER_LINE_ORDER.map((lineCode) => {
    const line = NATIVE_LINE_BY_CODE.get(lineCode);
    if (!line) throw new Error(`Missing native traction-power line ${lineCode}`);
    return line;
  }),
);

const DETAILED_LINE_CODES = new Set<NativeLineCode>(["RER_A", "RER_B", "M13", "M14"]);

export interface ProjectedPowerSection {
  id: string;
  name: string;
  rangeLabel: string;
  fromStationName: string;
  toStationName: string;
  stationCodes: readonly string[];
  interstationIds: readonly string[];
  status: PowerStatus;
  linkedIncidentIds: readonly string[];
}

export interface ProjectedTractionPowerLine {
  line: NativeLine;
  sections: readonly ProjectedPowerSection[];
  routeStationCount: number;
  routeInterstationCount: number;
  activePowerIncidentCount: number;
}

export function isDetailedTractionPowerLine(lineCode: NativeLineCode): lineCode is "RER_A" | "RER_B" | "M13" | "M14" {
  return DETAILED_LINE_CODES.has(lineCode);
}

export function tractionPowerShortLabel(lineCode: NativeLineCode): string {
  if (lineCode.startsWith("RER_")) return lineCode.slice(-1);
  return NATIVE_LINE_BY_CODE.get(lineCode)?.label ?? lineCode.replace(/^M/, "");
}

export function lineBadgeTextColor(color: string): "#07131e" | "#ffffff" {
  const value = color.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "#ffffff";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#07131e" : "#ffffff";
}

function sectionCountForInterstations(interstationCount: number): number {
  if (interstationCount <= 1) return 1;
  return Math.min(4, Math.max(2, Math.ceil(interstationCount / 8)));
}

function powerIncidentsForLine(
  nativeSimulation: NativeSimulationSnapshot | undefined,
  lineCode: NativeLineCode,
): readonly NativeIncident[] {
  return nativeSimulation?.incidents.filter((incident) =>
    incident.lineCode === lineCode && incident.type === "power" && incident.status === "active"
  ) ?? [];
}

function incidentTouchesSection(incident: NativeIncident, section: ProjectedPowerSection): boolean {
  if (incident.target.type === "line") return true;
  if (incident.target.type === "station" && section.stationCodes.includes(incident.target.id)) return true;
  if (incident.target.type === "interstation" && section.interstationIds.includes(incident.target.id)) return true;
  return incident.affectedStationCodes.some((stationCode) => section.stationCodes.includes(stationCode)) ||
    incident.affectedInterstationIds.some((interstationId) => section.interstationIds.includes(interstationId));
}

export function projectedTractionPowerSectionCount(lineCode: NativeLineCode): number {
  const synoptic = buildNativeLineSynoptic(lineCode);
  const route = synoptic.lanes.find((lane) => lane.kind === "main") ?? synoptic.lanes[0];
  const interstationCount = route?.cells.filter((cell) => cell.type === "interstation").length ?? 0;
  return sectionCountForInterstations(interstationCount);
}

export function buildProjectedTractionPowerLine(
  lineCode: NativeLineCode,
  nativeSimulation?: NativeSimulationSnapshot,
): ProjectedTractionPowerLine {
  const line = NATIVE_LINE_BY_CODE.get(lineCode) ?? NATIVE_LINES[0];
  if (!line) throw new Error(`Unknown native traction-power line ${lineCode}`);

  const synoptic = buildNativeLineSynoptic(lineCode);
  const route = synoptic.lanes.find((lane) => lane.kind === "main") ?? synoptic.lanes[0];
  const routeStations = route?.cells.filter((cell) => cell.type === "station") ?? [];
  const routeInterstations = route?.cells.filter((cell) => cell.type === "interstation") ?? [];
  const sectionCount = sectionCountForInterstations(routeInterstations.length);
  const incidents = powerIncidentsForLine(nativeSimulation, lineCode);

  const baseSections: ProjectedPowerSection[] = Array.from({ length: sectionCount }, (_, index) => {
    const startEdge = Math.floor(index * routeInterstations.length / sectionCount);
    const endEdge = Math.max(startEdge + 1, Math.floor((index + 1) * routeInterstations.length / sectionCount));
    const sectionInterstations = routeInterstations.slice(startEdge, endEdge);
    const sectionStations = routeStations.slice(startEdge, Math.min(routeStations.length, endEdge + 1));
    const fallbackStation = routeStations[Math.min(startEdge, Math.max(0, routeStations.length - 1))];
    const fromStation = sectionStations[0] ?? fallbackStation;
    const toStation = sectionStations[sectionStations.length - 1] ?? fromStation;
    const fromStationName = fromStation?.label ?? line.name;
    const toStationName = toStation?.label ?? fromStationName;
    return {
      id: `MODEL-PWR-${lineCode.replace("_", "-")}-${String(index + 1).padStart(2, "0")}`,
      name: `${tractionPowerShortLabel(lineCode)} section ${String(index + 1).padStart(2, "0")}`,
      rangeLabel: `${fromStationName} — ${toStationName}`,
      fromStationName,
      toStationName,
      stationCodes: sectionStations.map((station) => station.id),
      interstationIds: sectionInterstations.map((interstation) => interstation.id),
      status: "energized" as const,
      linkedIncidentIds: [],
    };
  });

  const matchedIncidentIds = new Set<string>();
  const sections = baseSections.map((section) => {
    const linked = incidents.filter((incident) => incidentTouchesSection(incident, section));
    linked.forEach((incident) => matchedIncidentIds.add(incident.id));
    return linked.length === 0 ? section : {
      ...section,
      status: "degraded" as const,
      linkedIncidentIds: linked.map((incident) => incident.id),
    };
  });

  const unmatched = incidents.filter((incident) => !matchedIncidentIds.has(incident.id));
  if (unmatched.length > 0 && sections[0]) {
    sections[0] = {
      ...sections[0],
      status: "degraded",
      linkedIncidentIds: [...sections[0].linkedIncidentIds, ...unmatched.map((incident) => incident.id)],
    };
  }

  return {
    line,
    sections,
    routeStationCount: routeStations.length,
    routeInterstationCount: routeInterstations.length,
    activePowerIncidentCount: incidents.length,
  };
}
