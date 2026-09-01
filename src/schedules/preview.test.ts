import { describe, expect, it } from "vitest";
import { createInitialSnapshot } from "../rail/scenario";
import { createSampleSchedulePlan } from "./sample";
import { buildSchedulePreview } from "./preview";

describe("deterministic schedule previews", () => {
  it("shifts both times without mutating the source plan", () => {
    const plan = createSampleSchedulePlan();
    const preview = buildSchedulePreview(
      plan,
      { kind: "shift_service", serviceId: "SVC-RB-101", deltaMinutes: 5 },
      createInitialSnapshot(),
      "agent",
    );

    expect(preview.changes.map((item) => item.field)).toEqual([
      "departureMinutes",
      "arrivalMinutes",
    ]);
    expect(preview.result.services[0].departureMinutes).toBe(335);
    expect(plan.services[0].departureMinutes).toBe(330);
    expect(preview.beforeHash).not.toBe(preview.afterHash);
    expect(preview.contextHash).toMatch(/^context-[a-f0-9]{64}$/);
    expect(preview.simulationOnly).toBe(true);
  });

  it("accepts bounded minute steps and rejects zero, fractions, and larger shifts", () => {
    const plan = createSampleSchedulePlan();
    const snapshot = createInitialSnapshot();
    expect(
      buildSchedulePreview(
        plan,
        { kind: "shift_service", serviceId: "SVC-RB-101", deltaMinutes: -15 },
        snapshot,
      ).changes,
    ).toHaveLength(2);
    [0, 1.5, 16, -16].forEach((deltaMinutes) => {
      expect(() =>
        buildSchedulePreview(
          plan,
          { kind: "shift_service", serviceId: "SVC-RB-101", deltaMinutes },
          snapshot,
        ),
      ).toThrow("non-zero integer between -15 and 15");
    });
  });

  it("previews driver, track, and cancellation actions as explicit patches", () => {
    const plan = createSampleSchedulePlan();
    const snapshot = createInitialSnapshot();
    const driver = buildSchedulePreview(
      plan,
      { kind: "reassign_driver", serviceId: "SVC-RB-101", driverToken: "ADC-RB-088" },
      snapshot,
    );
    const track = buildSchedulePreview(
      plan,
      { kind: "change_track", serviceId: "SVC-RB-101", track: "B9" },
      snapshot,
    );
    const cancel = buildSchedulePreview(
      plan,
      { kind: "cancel_service", serviceId: "SVC-RB-101" },
      snapshot,
    );

    expect(driver.changes[0]).toMatchObject({ field: "driverToken", after: "ADC-RB-088" });
    expect(track.changes[0]).toMatchObject({ field: "track", after: "B9" });
    expect(cancel.changes[0]).toMatchObject({ field: "status", after: "cancelled" });
    expect(cancel.warnings.join(" ")).toContain("passenger service");
  });

  it("rejects no-op changes before staging a preview", () => {
    const plan = createSampleSchedulePlan();
    const snapshot = createInitialSnapshot();

    expect(() =>
      buildSchedulePreview(
        plan,
        {
          kind: "reassign_driver",
          serviceId: "SVC-RB-101",
          driverToken: "ADC-RB-041",
        },
        snapshot,
      ),
    ).toThrow("already matches");
    expect(() =>
      buildSchedulePreview(
        plan,
        { kind: "change_track", serviceId: "SVC-RB-101", track: "B1" },
        snapshot,
      ),
    ).toThrow("already matches");

    plan.services[0].status = "cancelled";
    expect(() =>
      buildSchedulePreview(
        plan,
        { kind: "cancel_service", serviceId: "SVC-RB-101" },
        snapshot,
      ),
    ).toThrow("already matches");
  });
});
