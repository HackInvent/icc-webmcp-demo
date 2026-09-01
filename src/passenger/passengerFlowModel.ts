import type { RailSnapshot } from "../rail/domain";
import {
  NATIVE_STATIONS,
  NATIVE_LINE_BY_CODE,
  type NativeLineCode,
  type NativeStation,
} from "../rail/nativeNetwork";
import type {
  NativeSimulationSnapshot,
  NativeTrainState,
} from "../rail/nativeSimulation";
import { getReferenceCapacity } from "../rail/rollingStock";

export type PassengerFlowLevel = "quiet" | "moderate" | "busy" | "high" | "critical";

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
  referencePlaces: number;
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
  if (loadPercent >= 110) return "critical";
  if (loadPercent >= 90) return "high";
  if (loadPercent >= 65) return "busy";
  if (loadPercent >= 35) return "moderate";
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
  referencePlaces: number;
  loadPercent: number | null;
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
    const arrivalRate = finiteNumber(item.arrivalsPerSecond) ?? (perMinute === null ? null : perMinute / 60);
    const totalGenerated = finiteNumber(item.totalGeneratedPassengers);
    const totalBoarded = finiteNumber(item.totalBoardedPassengers);
    const totalAlighted = finiteNumber(item.totalAlightedPassengers);
    const boarded = finiteNumber(item.lastBoardedPassengers) ?? finiteNumber(item.lastBoarded);
    const alighted = finiteNumber(item.lastAlightedPassengers) ?? finiteNumber(item.lastAlighted);
    const exchangeAt = finiteNumber(item.lastExchangeAt);
    const explicitLoad = finiteNumber(item.loadPercent) ?? finiteNumber(item.crowdingPercent);
    const referencePlaces = itemLine && NATIVE_LINE_BY_CODE.has(itemLine as NativeLineCode)
      ? getReferenceCapacity(itemLine as NativeLineCode)
      : 0;
    flows.set(key, {
      passengers: (previous?.passengers ?? 0) + Math.max(0, Math.round(passengers)),
      referencePlaces: (previous?.referencePlaces ?? 0) + referencePlaces,
      loadPercent: explicitLoad === null ? previous?.loadPercent ?? null : Math.max(previous?.loadPercent ?? 0, explicitLoad),
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
    const trainReferencePlaces = stationContributions.reduce(
      (sum, item) => sum + getReferenceCapacity(item.train.lineCode),
      0,
    );
    const future = futureFlows.get(station.code) ?? futureFlows.get(station.svgId);
    const referencePlaces = trainReferencePlaces + (future?.referencePlaces ?? 0);
    const queuePassengers = future?.passengers ?? 0;
    const passengerPressure = modelPressure + queuePassengers;
    const loadPercent = future?.loadPercent !== null && future?.loadPercent !== undefined
      ? Math.max(0, Math.round(future.loadPercent))
      : referencePlaces > 0
        ? Math.round(passengerPressure / referencePlaces * 100)
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
      referencePlaces,
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
    passengerPressure: active.reduce((sum, station) => sum + station.passengerPressure, 0),
    activeStationCount: active.length,
    highPressureStationCount: active.filter((station) => station.level === "high" || station.level === "critical").length,
    averageLoadPercent: active.length ? Math.round(totalLoad / active.length) : 0,
    busiestStation: active[0] ?? null,
    feedStatus: detailedSnapshot?.passengerFeed?.status ?? "operational estimate",
  };
}
