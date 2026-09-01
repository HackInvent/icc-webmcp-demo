import { describe, expect, it } from "vitest";
import { NATIVE_LINES } from "./nativeNetwork";
import {
  DEMO_TRACTION_METHODOLOGY,
  ROLLING_STOCK_FAMILIES,
  ROLLING_STOCK_LINES,
  estimateTractionByLoad,
  getReferenceCapacity,
} from "./rollingStock";

describe("rolling-stock reference catalogue", () => {
  it("covers every native Metro and RER line exactly once", () => {
    expect(ROLLING_STOCK_LINES).toHaveLength(21);
    expect(new Set(ROLLING_STOCK_LINES.map((profile) => profile.lineCode))).toEqual(
      new Set(NATIVE_LINES.map((line) => line.code)),
    );
    for (const profile of ROLLING_STOCK_LINES) {
      expect(profile.assignments.length).toBeGreaterThan(0);
      expect(getReferenceCapacity(profile.lineCode)).toBeGreaterThan(0);
      for (const assignment of profile.assignments) {
        const family = ROLLING_STOCK_FAMILIES[assignment.familyId];
        expect(family?.sourceUrl).toMatch(/^https:\/\//);
        expect(["high", "medium", "low"]).toContain(family?.confidence);
        expect(family?.standingDensity === null || Number(family?.standingDensity) > 0).toBe(true);
      }
    }
  });

  it("keeps published reference capacities and reference formations explicit", () => {
    expect(getReferenceCapacity("M14")).toBe(932);
    expect(getReferenceCapacity("RER_A")).toBe(2610);
    expect(getReferenceCapacity("RER_B")).toBe(1700);
    expect(getReferenceCapacity("RER_D")).toBe(1861);
  });

  it("returns an uncalibrated relative index and never fake kWh", () => {
    const empty = estimateTractionByLoad({ familyId: "mp05", passengers: 0 });
    const loaded = estimateTractionByLoad({ familyId: "mp05", passengers: 500 });
    const steel = estimateTractionByLoad({ familyId: "mf01", passengers: 500 });

    expect(loaded.classification).toBe("DEMO ESTIMATE");
    expect(loaded.calibrated).toBe(false);
    expect(loaded.passengerMassKg).toBe(80);
    expect(loaded.payloadMassTonnes).toBe(40);
    expect(loaded.relativeTractionIndexPerTrainKm).toBeGreaterThan(empty.relativeTractionIndexPerTrainKm);
    expect(loaded.relativeTractionIndexPerTrainKm).not.toBe(steel.relativeTractionIndexPerTrainKm);
    expect(loaded.outputUnit).not.toMatch(/kWh/i);
    expect(DEMO_TRACTION_METHODOLOGY.warning).toMatch(/never.*kWh/i);
  });
});
