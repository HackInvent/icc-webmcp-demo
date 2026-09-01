import { describe, expect, it } from "vitest";
import { getOfficialLineRidership, LINE_RIDERSHIP, OFFICIAL_2025_METRO_TOTAL } from "./lineRidership";

describe("official-source line ridership reference", () => {
  it("covers all 21 native Metro and RER lines exactly once", () => {
    const expected = [
      "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11", "M12", "M13", "M14",
      "M3BIS", "M7BIS", "RER_A", "RER_B", "RER_C", "RER_D", "RER_E",
    ];
    expect(LINE_RIDERSHIP).toHaveLength(expected.length);
    expect(new Set(LINE_RIDERSHIP.map((entry) => entry.lineCode))).toEqual(new Set(expected));
  });

  it("preserves every official OMNIL 2025 Metro value and total", () => {
    const expected = new Map([
      ["M1", 168_740_000], ["M2", 92_260_000], ["M3", 80_420_000], ["M3BIS", 1_420_000],
      ["M4", 167_460_000], ["M5", 105_230_000], ["M6", 100_480_000], ["M7", 118_940_000],
      ["M7BIS", 3_390_000], ["M8", 105_540_000], ["M9", 128_770_000], ["M10", 43_730_000],
      ["M11", 52_370_000], ["M12", 84_040_000], ["M13", 117_630_000], ["M14", 152_210_000],
    ]);
    const metro = LINE_RIDERSHIP.filter((entry) => entry.mode === "metro");
    for (const entry of metro) {
      expect(entry.annualPassengerJourneys).toBe(expected.get(entry.lineCode));
      expect(entry).toMatchObject({
        referenceYear: 2025, dailyPassengerJourneys: null, annualizationMethod: "official_annual",
      });
    }
    expect(metro.reduce((total, entry) => total + entry.annualPassengerJourneys, 0))
      .toBe(OFFICIAL_2025_METRO_TOTAL);
  });

  it("annualizes every RER daily reference transparently", () => {
    const rer = LINE_RIDERSHIP.filter((entry) => entry.mode === "rer");
    expect(rer).toHaveLength(5);
    for (const entry of rer) {
      expect(entry.dailyPassengerJourneys).not.toBeNull();
      expect(entry.annualPassengerJourneys).toBe(entry.dailyPassengerJourneys! * 365);
      expect(entry.annualizationMethod).toBe("daily_reference_x_365");
      expect(entry.annualizationDays).toBe(365);
      expect(entry.limitations.join(" ")).toContain("mechanical");
    }
    expect(getOfficialLineRidership("RER_E")).toMatchObject({
      dailyPassengerJourneys: 600_000, annualPassengerJourneys: 219_000_000, referenceYear: 2025,
    });
  });

  it("exposes positive integer values and official HTTPS source URLs", () => {
    for (const entry of LINE_RIDERSHIP) {
      expect(Number.isSafeInteger(entry.annualPassengerJourneys)).toBe(true);
      expect(entry.annualPassengerJourneys).toBeGreaterThan(0);
      expect(entry.source.url).toMatch(/^https:\/\/(omnil\.cdn\.prismic\.io|www\.ratp\.fr|[^/]*iledefrance-mobilites\.fr|(?:www\.|malignee\.)?transilien\.com)\//);
    }
    expect(getOfficialLineRidership("RER_F")).toBeUndefined();
  });
});
