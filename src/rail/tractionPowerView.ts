import type { PowerStatus } from "./domain";
import {
  NATIVE_LINE_BY_CODE,
  NATIVE_LINES,
  type NativeLine,
  type NativeLineCode,
} from "./nativeNetwork";
import type { NativeIncident, NativeSimulationSnapshot, NativeTrainState } from "./nativeSimulation";
import { buildNativeLineSynoptic } from "./regulationModel";
import {
  estimateTractionByLoad,
  getReferenceAssignment,
  getRollingStockFamily,
} from "./rollingStock";

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
  simulatedDemandMw: number;
  simulatedVoltage: number;
  simulatedCurrentAmps: number;
  simulatedLoadPercent: number;
  suppliedTrainIds: readonly string[];
  runningTrainIds: readonly string[];
}

export interface ProjectedTractionPowerLine {
  line: NativeLine;
  sections: readonly ProjectedPowerSection[];
  routeStationCount: number;
  routeInterstationCount: number;
  activePowerIncidentCount: number;
  simulatedDemandMw: number;
  suppliedTrainCount: number;
  runningTrainCount: number;
  stationaryTrainCount: number;
}

const NOMINAL_VOLTAGE_BY_MODE = Object.freeze({ metro: 750, rer: 1_500 });
const SECTION_REFERENCE_POWER_MW_BY_MODE = Object.freeze({ metro: 3, rer: 10 });
// Internal nominal draw per reference formation unit. These coefficients are
// calibrated to the existing four-corridor simulation envelope, not nameplate ratings.
const RUNNING_POWER_MW_BY_TRACTION_CLASS = Object.freeze({
  "steel-wheel": 1.2,
  "rubber-tyred": 1.16,
  "rer-heavy-rail": 1.45,
});

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Instantaneous gross traction demand for the operational simulation.
 * The result deliberately remains separate from section telemetry: it links
 * visible train state and passenger load to a stable, transparent MW model.
 */
export function estimateNativeTrainTractionDemandMw(train: NativeTrainState): number {
  const assignment = getReferenceAssignment(train.lineCode);
  const family = getRollingStockFamily(assignment.familyId);
  const load = estimateTractionByLoad({
    familyId: family.id,
    formationUnits: assignment.referenceUnits,
    passengers: train.passengers,
  });
  const loadMultiplier = load.relativeTractionIndexPerTrainKm / load.emptyFormationIndex;
  const formationPower = RUNNING_POWER_MW_BY_TRACTION_CLASS[family.tractionClass] * assignment.referenceUnits;
  const stateFactor = train.status === "running"
    ? 0.75 + Math.min(1, Math.max(0, train.speedKmh) / 80) * 0.25
    : train.status === "dwelling"
      ? 0.18
      : train.status === "held"
        ? 0.12
        : 0.1;
  return round(formationPower * loadMultiplier * stateFactor, 3);
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

function sectionIndexForTrain(
  train: NativeTrainState,
  sections: readonly ProjectedPowerSection[],
): number {
  const directIndex = sections.findIndex((section) =>
    train.location.type === "station"
      ? section.stationCodes.includes(train.location.id)
      : section.interstationIds.includes(train.location.id)
  );
  if (directIndex >= 0) return directIndex;
  const currentEdgeIndex = sections.findIndex((section) =>
    section.interstationIds.includes(train.currentInterstationId)
  );
  if (currentEdgeIndex >= 0) return currentEdgeIndex;
  if (sections.length === 0) return -1;
  const routeProgress = train.routeInterstationIds.length > 1
    ? train.routeIndex / (train.routeInterstationIds.length - 1)
    : 0;
  return Math.min(sections.length - 1, Math.floor(routeProgress * sections.length));
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
      simulatedDemandMw: 0,
      simulatedVoltage: 0,
      simulatedCurrentAmps: 0,
      simulatedLoadPercent: 0,
      suppliedTrainIds: [],
      runningTrainIds: [],
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

  const lineTrains = nativeSimulation?.trains.filter((train) => train.lineCode === lineCode) ?? [];
  const trainsBySection = sections.map(() => [] as NativeTrainState[]);
  for (const train of lineTrains) {
    const sectionIndex = sectionIndexForTrain(train, sections);
    if (sectionIndex >= 0) trainsBySection[sectionIndex].push(train);
  }
  const nominalVoltage = NOMINAL_VOLTAGE_BY_MODE[line.mode];
  const sectionReferencePowerMw = SECTION_REFERENCE_POWER_MW_BY_MODE[line.mode];
  const sectionsWithDemand = sections.map((section, index) => {
    const sectionTrains = trainsBySection[index] ?? [];
    const simulatedDemandMw = round(
      sectionTrains.reduce(
        (sum, train) => sum + estimateNativeTrainTractionDemandMw(train),
        0,
      ),
      3,
    );
    const simulatedVoltage = section.status === "isolated"
      ? 0
      : Math.round(nominalVoltage * (section.status === "degraded" ? 0.9 : 0.98));
    return {
      ...section,
      simulatedDemandMw,
      simulatedVoltage,
      simulatedCurrentAmps: simulatedVoltage > 0
        ? Math.round(simulatedDemandMw * 1_000_000 / simulatedVoltage)
        : 0,
      simulatedLoadPercent: Math.min(
        200,
        Math.round(simulatedDemandMw / sectionReferencePowerMw * 100),
      ),
      suppliedTrainIds: sectionTrains.map((train) => train.id).sort(),
      runningTrainIds: sectionTrains
        .filter((train) => train.status === "running")
        .map((train) => train.id)
        .sort(),
    };
  });
  const runningTrainCount = lineTrains.filter((train) => train.status === "running").length;

  return {
    line,
    sections: sectionsWithDemand,
    routeStationCount: routeStations.length,
    routeInterstationCount: routeInterstations.length,
    activePowerIncidentCount: incidents.length,
    simulatedDemandMw: round(
      sectionsWithDemand.reduce((sum, section) => sum + section.simulatedDemandMw, 0),
      2,
    ),
    suppliedTrainCount: lineTrains.length,
    runningTrainCount,
    stationaryTrainCount: lineTrains.length - runningTrainCount,
  };
}
