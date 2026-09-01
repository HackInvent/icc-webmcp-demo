import { describe, expect, it, vi } from "vitest";
import type { RailSnapshot } from "../rail/domain";
import { createInitialSnapshot } from "../rail/scenario";
import { createSampleSchedulePlan } from "./sample";
import { ScheduleWorkspaceStore } from "./store";
import type { ScheduleWorkspaceErrorCode } from "./types";

function expectCode(action: () => unknown, code: ScheduleWorkspaceErrorCode): void {
  try {
    action();
    throw new Error("Expected action to throw.");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function setup(): { store: ScheduleWorkspaceStore; snapshot: RailSnapshot } {
  return {
    store: new ScheduleWorkspaceStore(createSampleSchedulePlan()),
    snapshot: createInitialSnapshot(),
  };
}

describe("versioned schedule workspace", () => {
  it("requires evaluate then one-shot human authorization for an agent commit", () => {
    const { store, snapshot } = setup();
    const preview = store.preview(
      { kind: "shift_service", serviceId: "SVC-RB-101", deltaMinutes: 5 },
      snapshot,
      "agent",
    );
    expectCode(
      () => store.commitPreview(preview.id, "impact-missing", "agent", snapshot),
      "IMPACT_REQUIRED",
    );
    const impact = store.evaluatePreview(preview.id, snapshot);
    expectCode(
      () => store.commitPreview(preview.id, impact.id, "agent", snapshot),
      "AUTHORIZATION_REQUIRED",
    );

    store.authorizePreview(preview.id, impact.id, snapshot);
    const receipt = store.commitPreview(preview.id, impact.id, "agent", snapshot);
    expect(receipt.actor).toBe("agent");
    expect(receipt.simulationOnly).toBe(true);
    expect(store.currentHash()).toBe(receipt.afterHash);
    expect(store.getSnapshot().authorizedPreviewId).toBeNull();
    expect(store.getSnapshot().authorizedImpactId).toBeNull();
    expect(store.getSnapshot().versions).toHaveLength(2);
    expect(store.getSnapshot().lastEvent).toContain("one-use human authorization was consumed");
    expectCode(
      () => store.commitPreview(preview.id, impact.id, "agent", snapshot),
      "PREVIEW_STALE",
    );
  });

  it("permits telemetry ticks but rejects changed decision context", () => {
    const { store, snapshot } = setup();
    const preview = store.preview(
      { kind: "change_track", serviceId: "SVC-RB-101", track: "B9" },
      snapshot,
      "agent",
    );
    const ticked: RailSnapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      timestamp: snapshot.timestamp + 12_000,
      powerSections: snapshot.powerSections.map((section) => ({
        ...section,
        voltage: section.voltage + 3,
        currentAmps: section.currentAmps + 7,
        loadPercent: section.loadPercent + 1,
        updatedAt: section.updatedAt + 12_000,
      })),
    };
    const impact = store.evaluatePreview(preview.id, ticked);
    store.authorizePreview(preview.id, impact.id, ticked);
    expect(store.commitPreview(preview.id, impact.id, "agent", ticked).afterHash).toBe(
      store.currentHash(),
    );

    const next = store.preview(
      { kind: "change_track", serviceId: "SVC-RB-205", track: "B8" },
      ticked,
      "agent",
    );
    const changedContext: RailSnapshot = {
      ...ticked,
      incidents: ticked.incidents.map((incident, index) =>
        index === 0 ? { ...incident, status: "resolved" } : incident,
      ),
    };
    expectCode(() => store.evaluatePreview(next.id, changedContext), "CONTEXT_STALE");
  });

  it("rejects authorization when decision context changed after evaluation", () => {
    const { store, snapshot } = setup();
    const preview = store.preview(
      { kind: "change_track", serviceId: "SVC-RB-101", track: "B9" },
      snapshot,
      "agent",
    );
    const impact = store.evaluatePreview(preview.id, snapshot);
    const changedContext: RailSnapshot = {
      ...snapshot,
      incidents: snapshot.incidents.map((incident, index) =>
        index === 0 ? { ...incident, status: "resolved" } : incident,
      ),
    };

    expectCode(
      () => store.authorizePreview(preview.id, impact.id, changedContext),
      "CONTEXT_STALE",
    );
    expect(store.getSnapshot().authorizedPreviewId).toBeNull();
    expect(store.getSnapshot().authorizedImpactId).toBeNull();
  });

  it("blocks live commits and candidates with newly introduced hard conflicts", () => {
    const { store, snapshot } = setup();
    const unsafe = store.preview(
      { kind: "reassign_driver", serviceId: "SVC-RB-101", driverToken: "ADC-RA-038" },
      snapshot,
      "agent",
    );
    const impact = store.evaluatePreview(unsafe.id, snapshot);
    expect(impact.hardBlocks.length).toBeGreaterThan(0);
    expectCode(() => store.authorizePreview(unsafe.id, impact.id, snapshot), "HARD_BLOCK");
    expectCode(
      () => store.commitPreview(unsafe.id, impact.id, "human", snapshot),
      "HARD_BLOCK",
    );

    store.discardPreview();
    const safe = store.preview(
      { kind: "change_track", serviceId: "SVC-RB-101", track: "B9" },
      snapshot,
    );
    const safeImpact = store.evaluatePreview(safe.id, snapshot);
    const liveSnapshot: RailSnapshot = { ...snapshot, source: "live" };
    expectCode(
      () => store.commitPreview(safe.id, safeImpact.id, "human", liveSnapshot),
      "LIVE_FORBIDDEN",
    );
  });

  it("issues receipts, notifies subscribers, and restores the exact prior hash on undo", () => {
    const { store, snapshot } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const originalHash = store.currentHash();
    const preview = store.preview(
      { kind: "change_track", serviceId: "SVC-RB-101", track: "B9" },
      snapshot,
    );
    const impact = store.evaluatePreview(preview.id, snapshot);
    const receipt = store.commitPreview(preview.id, impact.id, "human", snapshot);

    expect(receipt.id).toMatch(/^receipt-/);
    expect(receipt.beforeHash).toBe(originalHash);
    expect(store.getSnapshot().lastEvent).toContain("Human committed");
    expect(store.getSnapshot().lastEvent).toContain("No agent authorization was required");
    expect(listener).toHaveBeenCalledTimes(3);
    const restored = store.undo();
    expect(store.currentHash()).toBe(originalHash);
    expect(restored.plan.services[0].track).toBe("B1");
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("keeps published state immutable and rejects no-op previews", () => {
    const { store, snapshot } = setup();
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().versions)).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().versions[0].plan.services)).toBe(true);

    const first = store.preview(
      { kind: "cancel_service", serviceId: "SVC-RB-101" },
      snapshot,
    );
    const firstImpact = store.evaluatePreview(first.id, snapshot);
    store.commitPreview(first.id, firstImpact.id, "human", snapshot);
    expectCode(
      () => store.preview(
        { kind: "cancel_service", serviceId: "SVC-RB-101" },
        snapshot,
      ),
      "NO_CHANGES",
    );
    expect(store.getSnapshot().pendingPreview).toBeNull();
    expect(store.getSnapshot().pendingImpact).toBeNull();
  });
});
