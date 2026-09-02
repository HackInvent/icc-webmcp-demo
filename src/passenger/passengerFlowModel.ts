import type { RailSnapshot } from "../rail/domain";
import {
  NATIVE_STATIONS,
  type NativeLineCode,
  type NativeStation,
} from "../rail/nativeNetwork";
import type {
  NativeSimulationSnapshot,
  NativeTrainState,
} from "../rail/nativeSimulation";
import { getMaximumTrainCapacity } from "../rail/rollingStock";
import { effectivePassengerArrivalRate } from "../rail/operationalTime";

export type PassengerFlowLevel = "quiet" | "moderate" | "high" | "critical";

const PASSENGER_HEAT_STOPS = Object.freeze([
  { percent: 0, color: [184, 243, 207] as const },
  { percent: 50, color: [244, 211, 94] as const },
  { percent: 100, color: [230, 57, 70] as const },
  { percent: 200, color: [17, 19, 23] as const },
]);

function hexChannel(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

/** Continuous station-queue heat color: green 0%, yellow 50%, red 100%, black 200%. */
export function passengerFlowHeatColor(loadPercent: number): string {
  const value = Number.isFinite(loadPercent) ? Math.min(200, Math.max(0, loadPercent)) : 0;
  const upperIndex = PASSENGER_HEAT_STOPS.findIndex((stop) => value <= stop.percent);
  const upper = PASSENGER_HEAT_STOPS[upperIndex < 0 ? PASSENGER_HEAT_STOPS.length - 1 : upperIndex];
  const lower = PASSENGER_HEAT_STOPS[Math.max(0, (upperIndex < 0 ? PASSENGER_HEAT_STOPS.length - 1 : upperIndex) - 1)];
  if (upper.percent === lower.percent) {
    return `#${upper.color.map(hexChannel).join("")}`;
  }
  const progress = (value - lower.percent) / (upper.percent - lower.percent);
  return `#${upper.color.map((channel, index) => hexChannel(lower.color[index] + (channel - lower.color[index]) * progress)).join("")}`;
}

export interface PassengerFlowContribution {
  train: NativeTrainState;
  relationship: "at-station";
  passengers: number;
}

export interface PassengerFlowStation {
  station: NativeStation;
  passengerPressure: number;
  queuePassengers: number;
  arrivalsPerSecond: number | null;
  totalGenerated: number | null;
  totalBoarded: number | null;
  totalAlighted: number | null;
  lastBoarded: number | null;
  lastAlighted: number | null;
  lastExchangeAt: number | null;
  capacityReferencePlaces: number;
  loadPercent: number;
  level: PassengerFlowLevel;
  serviceCalls: number;
  contributions: PassengerFlowContribution[];
  source: "train-occupation" | "modelled-queue";
}

export interface PassengerFlowView {
  stations: PassengerFlowStation[];
  totalOnboardPassengers: number;
  totalQueuePassengers: number;
  totalGeneratedPassengers: number;
  totalBoardedPassengers: number;
  totalAlightedPassengers: number;
  passengerPressure: number;
  activeStationCount: number;
  highPressureStationCount: number;
  averageLoadPercent: number;
  busiestStation: PassengerFlowStation | null;
  feedStatus: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStationName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/saint/g, "st")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levelFor(loadPercent: number): PassengerFlowLevel {
  if (loadPercent >= 200) return "critical";
  if (loadPercent >= 100) return "high";
  if (loadPercent >= 50) return "moderate";
  return "quiet";
}

function futureStationRecords(simulation: NativeSimulationSnapshot): UnknownRecord[] {
  const source = simulation as unknown as UnknownRecord;
  const passengerState = record(source.passengerState);
  const candidates = [
    source.passengerFlows,
    source.stationPassengers,
    source.stationPassengerFlows,
    source.stationFlows,
    passengerState?.stations,
  ];
  return candidates.flatMap((candidate) => Array.isArray(candidate)
    ? candidate.map(record).filter((item): item is UnknownRecord => item !== null)
    : []);
}

interface FuturePassengerFlow {
  passengers: number;
  arrivalsPerSecond: number | null;
  totalGenerated: number | null;
  totalBoarded: number | null;
  totalAlighted: number | null;
  lastBoarded: number | null;
  lastAlighted: number | null;
  lastExchangeAt: number | null;
}

function futureFlowByStation(
  simulation: NativeSimulationSnapshot,
  lineCode: NativeLineCode | null,
): Map<string, FuturePassengerFlow> {
  const flows = new Map<string, FuturePassengerFlow>();
  const stationByName = new Map(NATIVE_STATIONS.map((station) => [normalizeStationName(station.name), station.code]));
  for (const item of futureStationRecords(simulation)) {
    const itemLine = text(item.lineCode) ?? text(item.lineId);
    if (lineCode !== null && itemLine !== null && itemLine !== lineCode) continue;
    const stationName = text(item.stationName);
    const key = text(item.stationCode) ?? text(item.stationId) ?? text(item.code)
      ?? (stationName ? stationByName.get(normalizeStationName(stationName)) ?? null : null);
    if (!key) continue;
    const passengers = finiteNumber(item.waitingPassengers)
      ?? finiteNumber(item.estimatedPassengers)
      ?? finiteNumber(item.passengerCount)
      ?? finiteNumber(item.passengers);
    if (passengers === null) continue;
    const previous = flows.get(key);
    const perMinute = finiteNumber(item.arrivalsPerMinute);
    const nominalArrivalRate = finiteNumber(item.arrivalsPerSecond) ?? (perMinute === null ? null : perMinute / 60);
    const arrivalRate = nominalArrivalRate === null
      ? null
      : effectivePassengerArrivalRate(nominalArrivalRate, simulation.timestamp);
    const totalGenerated = finiteNumber(item.totalGeneratedPassengers);
    const totalBoarded = finiteNumber(item.totalBoardedPassengers);
    const totalAlighted = finiteNumber(item.totalAlightedPassengers);
    const boarded = finiteNumber(item.lastBoardedPassengers) ?? finiteNumber(item.lastBoarded);
    const alighted = finiteNumber(item.lastAlightedPassengers) ?? finiteNumber(item.lastAlighted);
    const exchangeAt = finiteNumber(item.lastExchangeAt);
    flows.set(key, {
      passengers: (previous?.passengers ?? 0) + Math.max(0, Math.round(passengers)),
      arrivalsPerSecond: arrivalRate === null ? previous?.arrivalsPerSecond ?? null : (previous?.arrivalsPerSecond ?? 0) + arrivalRate,
      totalGenerated: totalGenerated === null ? previous?.totalGenerated ?? null : (previous?.totalGenerated ?? 0) + Math.max(0, Math.round(totalGenerated)),
      totalBoarded: totalBoarded === null ? previous?.totalBoarded ?? null : (previous?.totalBoarded ?? 0) + Math.max(0, Math.round(totalBoarded)),
      totalAlighted: totalAlighted === null ? previous?.totalAlighted ?? null : (previous?.totalAlighted ?? 0) + Math.max(0, Math.round(totalAlighted)),
      lastBoarded: boarded === null ? previous?.lastBoarded ?? null : (previous?.lastBoarded ?? 0) + Math.max(0, Math.round(boarded)),
      lastAlighted: alighted === null ? previous?.lastAlighted ?? null : (previous?.lastAlighted ?? 0) + Math.max(0, Math.round(alighted)),
      lastExchangeAt: exchangeAt === null ? previous?.lastExchangeAt ?? null : Math.max(previous?.lastExchangeAt ?? 0, exchangeAt),
    });
  }
  return flows;
}

export function buildPassengerFlowView(
  simulation: NativeSimulationSnapshot,
  detailedSnapshot?: RailSnapshot,
  lineCode: NativeLineCode | null = null,
): PassengerFlowView {
  const trains = simulation.trains.filter((train) => lineCode === null || train.lineCode === lineCode);
  const contributions = new Map<string, PassengerFlowContribution[]>();
  const append = (stationCode: string, contribution: PassengerFlowContribution) => {
    contributions.set(stationCode, [...(contributions.get(stationCode) ?? []), contribution]);
  };
  for (const train of trains) {
    if (train.location.type === "station") {
      append(train.location.id, { train, relationship: "at-station", passengers: train.passengers });
    }
  }

  const futureFlows = futureFlowByStation(simulation, lineCode);
  const observationCounts = new Map<string, number>();
  const stationByName = new Map(NATIVE_STATIONS.map((station) => [normalizeStationName(station.name), station.code]));
  for (const observation of detailedSnapshot?.passengerFeed?.observations ?? []) {
    if (lineCode !== null && observation.lineId !== lineCode) continue;
    const stationCode = stationByName.get(normalizeStationName(observation.stopPointName));
    if (stationCode) observationCounts.set(stationCode, (observationCounts.get(stationCode) ?? 0) + 1);
  }

  const visibleStations = NATIVE_STATIONS.filter((station) => lineCode === null || station.lines.includes(lineCode));
  const stations = visibleStations.map<PassengerFlowStation>((station) => {
    const stationContributions = contributions.get(station.code) ?? [];
    const modelPressure = stationContributions.reduce((sum, item) => sum + item.passengers, 0);
    const future = futureFlows.get(station.code) ?? futureFlows.get(station.svgId);
    const referenceLines = lineCode === null ? station.lines : [lineCode];
    const capacityReferencePlaces = [...new Set(referenceLines)].reduce(
      (sum, referenceLine) => sum + getMaximumTrainCapacity(referenceLine),
      0,
    );
    const queuePassengers = future?.passengers ?? 0;
    const passengerPressure = modelPressure + queuePassengers;
    const loadPercent = capacityReferencePlaces > 0
      ? Math.round(queuePassengers / capacityReferencePlaces * 100)
      : 0;
    return {
      station,
      passengerPressure,
      queuePassengers,
      arrivalsPerSecond: future?.arrivalsPerSecond ?? null,
      totalGenerated: future?.totalGenerated ?? null,
      totalBoarded: future?.totalBoarded ?? null,
      totalAlighted: future?.totalAlighted ?? null,
      lastBoarded: future?.lastBoarded ?? null,
      lastAlighted: future?.lastAlighted ?? null,
      lastExchangeAt: future?.lastExchangeAt ?? null,
      capacityReferencePlaces,
      loadPercent,
      level: levelFor(loadPercent),
      serviceCalls: observationCounts.get(station.code) ?? 0,
      contributions: stationContributions,
      source: future ? "modelled-queue" : "train-occupation",
    };
  }).sort((left, right) =>
    right.passengerPressure - left.passengerPressure || left.station.name.localeCompare(right.station.name)
  );
  const active = stations.filter((station) => station.passengerPressure > 0);
  const totalLoad = active.reduce((sum, station) => sum + station.loadPercent, 0);
  return {
    stations,
    totalOnboardPassengers: trains.reduce((sum, train) => sum + train.passengers, 0),
    totalQueuePassengers: stations.reduce((sum, station) => sum + station.queuePassengers, 0),
    totalGeneratedPassengers: stations.reduce((sum, station) => sum + (station.totalGenerated ?? 0), 0),
    totalBoardedPassengers: stations.reduce((sum, station) => sum + (station.totalBoarded ?? 0), 0),
    totalAlightedPassengers: stations.reduce((sum, station) => sum + (station.totalAlighted ?? 0), 0),
    passengerPressure: active.reduce((sum, station) => sum + station.passengerPressure, 0),
    activeStationCount: active.length,
    highPressureStationCount: active.filter((station) => station.level === "high" || station.level === "critical").length,
    averageLoadPercent: active.length ? Math.round(totalLoad / active.length) : 0,
    busiestStation: active[0] ?? null,
    feedStatus: detailedSnapshot?.passengerFeed?.status ?? "operational estimate",
  };
}
