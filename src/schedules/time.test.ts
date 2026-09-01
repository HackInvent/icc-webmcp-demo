import { describe, expect, it } from "vitest";
import { formatScheduleMinutes } from "./time";

describe("schedule time formatting", () => {
  it("marks services that arrive on the following operating day", () => {
    expect(formatScheduleMinutes(23 * 60 + 30)).toBe("23:30");
    expect(formatScheduleMinutes(24 * 60 + 30)).toBe("00:30 +1d");
    expect(formatScheduleMinutes(48 * 60 + 5)).toBe("00:05 +2d");
  });
});
