import { describe, expect, it } from "vitest";
import { getOfficialLineRidership } from "./lineRidership";
import { NATIVE_LINES } from "./nativeNetwork";
import {
  accumulateNativeStationPassengers,
  createNativeStationPassengerStates,
  nativeStationPassengerId,
  type NativeStationPassengerState,
} from "./passengerDemand";

describe("native passenger demand", () => {
  it("creates one empty line-specific queue per station from the strict official volume formula", () => {
    const states = createNativeStationPassengerStates();
    const expectedCount = NATIVE_LINES.reduce(
      (total, line) => total + line.stationCodes.length,
      0,
    );

    expect(states).toHaveLength(expectedCount);
    expect(new Set(states.map((state) => state.id))).toHaveLength(expectedCount);
    expect(states.every((state) =>
      state.waitingPassengers === 0 &&
      state.arrivalRemainder === 0 &&
      state.totalGeneratedPassengers === 0 &&
      state.totalBoardedPassengers === 0 &&
      state.totalAlightedPassengers === 0 &&
      state.lastBoardedPassengers === 0 &&
      state.lastAlightedPassengers === 0 &&
      state.lastExchangeAt === null
    )).toBe(true);

    const metroLine = NATIVE_LINES.find((line) => line.code === "M1")!;
    const metroVolume = getOfficialLineRidership("M1")!;
    const metroState = states.find((state) =>
      state.id === nativeStationPassengerId("M1", metroLine.stationCodes[0]!)
    )!;
    expect(metroState.arrivalsPerSecond).toBe(
      metroVolume.annualPassengerJourneys /
        metroLine.stationCodes.length /
        (365 * 24 * 60 * 60),
    );
    expect(metroState.demandVolumeProvenance).toBe(
      "official-annual-passenger-journeys",
    );
    expect(metroState.referenceYear).toBe(metroVolume.referenceYear);

    const rerLine = NATIVE_LINES.find((line) => line.code === "RER_C")!;
    const rerVolume = getOfficialLineRidership("RER_C")!;
    const rerState = states.find((state) =>
      state.id === nativeStationPassengerId("RER_C", rerLine.stationCodes[0]!)
    )!;
    expect(rerState.arrivalsPerSecond).toBe(
      rerVolume.dailyPassengerJourneys! /
        rerLine.stationCodes.length /
        (24 * 60 * 60),
    );
    expect(rerState.demandVolumeProvenance).toBe(
      "official-daily-passenger-journeys",
    );
    expect(rerState.referenceYear).toBe(rerVolume.referenceYear);
  });

  it("keeps fractional arrivals deterministic across x1, x2 and x4 elapsed time", () => {
    const seed: NativeStationPassengerState = {
      ...createNativeStationPassengerStates()[0]!,
      arrivalsPerSecond: 0.6,
    };
    const accumulated = (ticks: number) => {
      let states = [seed];
      for (let tick = 0; tick < ticks; tick += 1) {
        states = accumulateNativeStationPassengers(states, 1_000);
      }
      return states[0]!;
    };

    const x2 = accumulateNativeStationPassengers([seed], 2_000)[0]!;
    const x4 = accumulateNativeStationPassengers([seed], 4_000)[0]!;
    expect(x2).toEqual(accumulated(2));
    expect(x4).toEqual(accumulated(4));
    expect(x4).toEqual(expect.objectContaining({
      waitingPassengers: 2,
      arrivalRemainder: 0.4,
      totalGeneratedPassengers: 2,
    }));
  });
});
