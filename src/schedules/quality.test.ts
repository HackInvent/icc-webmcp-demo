import { describe, expect, it } from "vitest";
import { createInitialSnapshot } from "../rail/scenario";
import { buildSchedulePreview } from "./preview";
import {
  evaluateSchedulePreview,
  hashOperationalContext,
  hashSchedulePlan,
} from "./quality";
import { createSampleSchedulePlan } from "./sample";

describe("schedule feasibility and impact analysis", () => {
  it("uses stable SHA-256 plan fingerprints independent of display metadata and row order", () => {
    const plan = createSampleSchedulePlan();
    const reordered = {
      ...createSampleSchedulePlan(),
      name: "A different display name",
      importedAt: "2030-01-01T00:00:00.000Z",
      services: [...plan.services].reverse(),
    };
    const changed = createSampleSchedulePlan();
    changed.services[0].track = "B9";

    expect(hashSchedulePlan(plan)).toMatch(/^schedule-[a-f0-9]{64}$/);
    expect(hashSchedulePlan(reordered)).toBe(hashSchedulePlan(plan));
    expect(hashSchedulePlan(changed)).not.toBe(hashSchedulePlan(plan));
  });

  it("keeps context stable across ticks but changes it for decision state", () => {
    const snapshot = createInitialSnapshot();
    const ticked = {
      ...snapshot,
      revision: snapshot.revision + 100,
      timestamp: snapshot.timestamp + 120_000,
      powerSections: snapshot.powerSections.map((section) => ({
        ...section,
        voltage: section.voltage + 17,
        currentAmps: section.currentAmps + 23,
        loadPercent: Math.min(100, section.loadPercent + 2),
        updatedAt: section.updatedAt + 120_000,
      })),
    };
    const isolated = {
      ...snapshot,
      powerSections: snapshot.powerSections.map((section, index) =>
        index === 0 ? { ...section, status: "isolated" as const } : section,
      ),
    };
    const changedIncident = {
      ...snapshot,
      incidents: snapshot.incidents.map((incident, index) =>
        index === 0 ? { ...incident, status: "resolved" as const } : incident,
      ),
    };
    const changedDriver = {
      ...snapshot,
      drivers: snapshot.drivers.map((driver, index) =>
        index === 0 ? { ...driver, qualifications: ["RER_A" as const] } : driver,
      ),
    };
    const changedClosure = {
      ...snapshot,
      circuits: snapshot.circuits.map((circuit) =>
        circuit.id === "RB-05-A"
          ? {
              ...circuit,
              state: "blocked" as const,
              closure: {
                reason: "works" as const,
                note: "Overnight renewal",
                reference: null,
                closedAt: snapshot.timestamp,
              },
            }
          : circuit,
      ),
    };

    expect(hashOperationalContext(ticked)).toBe(hashOperationalContext(snapshot));
    expect(hashOperationalContext(isolated)).not.toBe(hashOperationalContext(snapshot));
    expect(hashOperationalContext(changedIncident)).not.toBe(hashOperationalContext(snapshot));
    expect(hashOperationalContext(changedDriver)).not.toBe(hashOperationalContext(snapshot));
    expect(hashOperationalContext(changedClosure)).not.toBe(hashOperationalContext(snapshot));
  });

  it("reports a true baseline-to-candidate comparison and passenger delay-minutes", () => {
    const plan = createSampleSchedulePlan();
    const snapshot = createInitialSnapshot();
    const preview = buildSchedulePreview(
      plan,
      { kind: "shift_service", serviceId: "SVC-RB-101", deltaMinutes: 5 },
      snapshot,
      "agent",
    );
    const impact = evaluateSchedulePreview(plan, preview, snapshot);

    expect(impact.id).toMatch(/^impact-[a-f0-9]{64}$/);
    expect(impact.baselineCoverage.percent).toBe(100);
    expect(impact.coverage.percent).toBe(100);
    expect(impact.baselineConflicts).toHaveLength(2);
    expect(impact.conflicts).toHaveLength(2);
    expect(impact.baselineConflicts.filter((item) => item.kind === "driver_relief_risk")).toHaveLength(2);
    expect(impact.conflicts.filter((item) => item.kind === "driver_relief_risk")).toHaveLength(2);
    expect(impact.hardBlocks).toHaveLength(0);
    expect(impact.passengersAffected).toBe(624);
    expect(impact.passengerDelayMinutes).toBe(3_120);
    expect(impact.incidentExposure.incidentIds).toContain("INC-2410");
    expect(impact.powerExposure.sectionIds).toContain("PWR-RB-NORD");
  });

  it("warns and scores services exposed to a manually closed track circuit", () => {
    const plan = createSampleSchedulePlan();
    const baselineSnapshot = createInitialSnapshot();
    const request = {
      kind: "shift_service" as const,
      serviceId: "SVC-RB-101",
      deltaMinutes: 5,
    };
    const baselinePreview = buildSchedulePreview(plan, request, baselineSnapshot, "agent");
    const baselineImpact = evaluateSchedulePreview(plan, baselinePreview, baselineSnapshot);
    const closedSnapshot = {
      ...baselineSnapshot,
      circuits: baselineSnapshot.circuits.map((circuit) =>
        circuit.id === "RB-05-A"
          ? {
              ...circuit,
              state: "blocked" as const,
              closure: {
                reason: "works" as const,
                note: "Overnight renewal",
                reference: null,
                closedAt: baselineSnapshot.timestamp,
              },
            }
          : circuit,
      ),
    };
    const preview = buildSchedulePreview(plan, request, closedSnapshot, "agent");
    const impact = evaluateSchedulePreview(plan, preview, closedSnapshot);

    expect(impact.warnings.join(" ")).toContain("RB-05-A");
    expect(impact.warnings.join(" ")).toContain("manually closed track circuit");
    expect(impact.score).toBeLessThan(baselineImpact.score);
  });

  it("hard-blocks only newly introduced violations", () => {
    const snapshot = createInitialSnapshot();
    const plan = createSampleSchedulePlan();
    const unsafe = buildSchedulePreview(
      plan,
      { kind: "reassign_driver", serviceId: "SVC-RB-101", driverToken: "ADC-RA-038" },
      snapshot,
      "agent",
    );
    const unsafeImpact = evaluateSchedulePreview(plan, unsafe, snapshot);
    expect(unsafeImpact.hardBlocks.length).toBeGreaterThan(0);
    expect(unsafeImpact.assessment).toBe("blocked");

    const baselineWithIssue = createSampleSchedulePlan();
    baselineWithIssue.services[0].driverToken = "ADC-RA-038";
    const neutral = buildSchedulePreview(
      baselineWithIssue,
      { kind: "change_track", serviceId: "SVC-M14-041", track: "14X" },
      snapshot,
    );
    const neutralImpact = evaluateSchedulePreview(baselineWithIssue, neutral, snapshot);
    expect(neutralImpact.baselineConflicts.some((item) => item.kind === "driver_qualification")).toBe(true);
    expect(neutralImpact.hardBlocks).toHaveLength(0);
  });

  it("warns when a candidate assigns a relief-risk driver", () => {
    const snapshot = createInitialSnapshot();
    const plan = createSampleSchedulePlan();
    const existingReliefService = plan.services.find(
      (service) => service.serviceId === "SVC-RB-205",
    );
    if (!existingReliefService) throw new Error("Expected SVC-RB-205");
    existingReliefService.status = "cancelled";

    const preview = buildSchedulePreview(
      plan,
      { kind: "reassign_driver", serviceId: "SVC-RB-101", driverToken: "ADC-RB-017" },
      snapshot,
    );
    const impact = evaluateSchedulePreview(plan, preview, snapshot);
    const reliefRisk = impact.conflicts.find(
      (item) => item.kind === "driver_relief_risk" && item.serviceIds.includes("SVC-RB-101"),
    );

    expect(reliefRisk).toEqual(expect.objectContaining({ severity: "warning" }));
    expect(impact.warnings.join(" ")).toContain("modelled relief risk");
    expect(impact.hardBlocks).toHaveLength(0);
  });

  it("hard-blocks a newly introduced rolling-stock overlap", () => {
    const snapshot = createInitialSnapshot();
    const plan = createSampleSchedulePlan();
    const first = plan.services.find((service) => service.serviceId === "SVC-RB-101");
    const second = plan.services.find((service) => service.serviceId === "SVC-RB-205");
    if (!first || !second || !first.trainId) throw new Error("Expected RER B sample services");
    second.trainId = first.trainId;
    second.departureMinutes = 420;
    second.arrivalMinutes = 492;

    const preview = buildSchedulePreview(
      plan,
      { kind: "shift_service", serviceId: second.serviceId, deltaMinutes: -15 },
      snapshot,
    );
    const impact = evaluateSchedulePreview(plan, preview, snapshot);
    const overlap = impact.conflicts.find((item) => item.kind === "rolling_stock_overlap");

    expect(impact.baselineConflicts.some((item) => item.kind === "rolling_stock_overlap")).toBe(false);
    expect(overlap).toEqual(expect.objectContaining({
      severity: "hard",
      resourceId: first.trainId,
      serviceIds: [first.serviceId, second.serviceId],
    }));
    expect(impact.hardBlocks.join(" ")).toContain("Rolling stock");
  });
});
