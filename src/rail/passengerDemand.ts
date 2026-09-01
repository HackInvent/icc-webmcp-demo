import { getOfficialLineRidership } from "./lineRidership";
import { NATIVE_LINES, type NativeLineCode } from "./nativeNetwork";

export type NativePassengerDemandVolumeProvenance =
  | "official-annual-passenger-journeys"
  | "official-daily-passenger-journeys";

export interface NativeStationPassengerState {
  id: string;
  lineCode: NativeLineCode;
  stationId: string;
  waitingPassengers: number;
  arrivalRemainder: number;
  arrivalsPerSecond: number;
  totalGeneratedPassengers: number;
  totalBoardedPassengers: number;
  totalAlightedPassengers: number;
  lastBoardedPassengers: number;
  lastAlightedPassengers: number;
  lastExchangeAt: number | null;
  demandVolumeProvenance: NativePassengerDemandVolumeProvenance;
  referenceYear: number;
}

function lineDemand(lineCode: NativeLineCode, stationCount: number): {
  passengersPerStationSecond: number;
  demandVolumeProvenance: NativePassengerDemandVolumeProvenance;
  referenceYear: number;
} {
  const official = getOfficialLineRidership(lineCode);
  if (!official) throw new Error(`Missing official passenger volume for ${lineCode}`);
  const daily = official.dailyPassengerJourneys;
  return {
    passengersPerStationSecond: daily === null
      ? official.annualPassengerJourneys / stationCount / (365 * 24 * 60 * 60)
      : daily / stationCount / (24 * 60 * 60),
    demandVolumeProvenance: daily === null
      ? "official-annual-passenger-journeys"
      : "official-daily-passenger-journeys",
    referenceYear: official.referenceYear,
  };
}

export function nativeStationPassengerId(
  lineCode: NativeLineCode,
  stationId: string,
): string {
  return `passenger:${lineCode}:${stationId}`;
}

/**
 * Builds one deterministic passenger queue per line/station pair.
 * The rate is the published annual volume divided by line station count and
 * seconds per 365-day year. Daily RER references use station count and 86,400
 * seconds directly. There is no interchange, headway, capacity or load factor.
 */
export function createNativeStationPassengerStates(): NativeStationPassengerState[] {
  return NATIVE_LINES.flatMap((line) => {
    const demand = lineDemand(line.code, line.stationCodes.length);
    return line.stationCodes.map((stationId) => {
      const arrivalsPerSecond = demand.passengersPerStationSecond;
      return {
        id: nativeStationPassengerId(line.code, stationId),
        lineCode: line.code,
        stationId,
        waitingPassengers: 0,
        arrivalRemainder: 0,
        arrivalsPerSecond,
        totalGeneratedPassengers: 0,
        totalBoardedPassengers: 0,
        totalAlightedPassengers: 0,
        lastBoardedPassengers: 0,
        lastAlightedPassengers: 0,
        lastExchangeAt: null,
        demandVolumeProvenance: demand.demandVolumeProvenance,
        referenceYear: demand.referenceYear,
      };
    });
  }).sort((left, right) =>
    left.lineCode.localeCompare(right.lineCode) || left.stationId.localeCompare(right.stationId)
  );
}

export function accumulateNativeStationPassengers(
  states: readonly NativeStationPassengerState[],
  elapsedMilliseconds: number,
): NativeStationPassengerState[] {
  const elapsedSeconds = elapsedMilliseconds / 1_000;
  return states.map((state) => {
    const accumulated = state.arrivalRemainder + state.arrivalsPerSecond * elapsedSeconds;
    let arrivals = Math.floor(accumulated);
    let arrivalRemainder = Math.round((accumulated - arrivals) * 1e12) / 1e12;
    // Quantising the carry keeps repeated x1 ticks bit-for-bit equivalent to
    // x2/x4. A rounded carry of exactly one is promoted to a whole passenger.
    if (arrivalRemainder >= 1) {
      arrivals += 1;
      arrivalRemainder = 0;
    }
    return {
      ...state,
      waitingPassengers: state.waitingPassengers + arrivals,
      arrivalRemainder,
      totalGeneratedPassengers: state.totalGeneratedPassengers + arrivals,
    };
  });
}
