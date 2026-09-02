import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOperationsRepository } from "../server/operations-repository.mjs";
import { createOperationsService } from "../server/operations-service.ts";

const DEFAULT_TIMESTAMP = Date.UTC(2026, 7, 28, 11, 0, 0);
const RETIRED_NATIVE_TIMESTAMP = Date.UTC(2026, 7, 28, 6, 30, 0);
const RETIRED_DETAILED_TIMESTAMP = Date.UTC(2026, 7, 26, 3, 42, 0);

function shiftOptionalTimestamp(value, delta) {
  return typeof value === "number" ? value + delta : value;
}

function retiredNativeBaseline(snapshot) {
  const delta = RETIRED_NATIVE_TIMESTAMP - snapshot.timestamp;
  return {
    ...structuredClone(snapshot),
    timestamp: RETIRED_NATIVE_TIMESTAMP,
    scenarioName: "Paris morning multi-event",
    incidents: snapshot.incidents.map((incident) => ({
      ...structuredClone(incident),
      startedAt: incident.startedAt + delta,
      activatedAt: shiftOptionalTimestamp(incident.activatedAt, delta),
    })),
    shuttles: snapshot.shuttles.map((shuttle) => ({
      ...structuredClone(shuttle),
      startedAt: shuttle.startedAt + delta,
    })),
    stationPassengers: snapshot.stationPassengers.map((state) => ({
      ...structuredClone(state),
      lastExchangeAt: shiftOptionalTimestamp(state.lastExchangeAt, delta),
    })),
    lastDecision: snapshot.lastDecision === null ? null : {
      ...structuredClone(snapshot.lastDecision),
      evaluatedAt: snapshot.lastDecision.evaluatedAt + delta,
    },
  };
}

function retiredDetailedBaseline(state) {
  const delta = RETIRED_DETAILED_TIMESTAMP - state.snapshot.timestamp;
  return {
    ...structuredClone(state),
    snapshot: {
      ...structuredClone(state.snapshot),
      timestamp: RETIRED_DETAILED_TIMESTAMP,
      scenarioName: "Morning peak — D-1 events",
      incidents: state.snapshot.incidents.map((incident) => ({
        ...structuredClone(incident),
        startedAt: incident.startedAt + delta,
        activatedAt: shiftOptionalTimestamp(incident.activatedAt, delta),
      })),
      powerSections: state.snapshot.powerSections.map((section) => ({
        ...structuredClone(section),
        updatedAt: section.updatedAt + delta,
      })),
      events: state.snapshot.events.map((event) => ({
        ...structuredClone(event),
        timestamp: event.timestamp + delta,
      })),
    },
  };
}

describe("retired built-in simulation baseline", () => {
  it("upgrades to 01:00 PM on explicit Reset while preserving current persistence semantics", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-baseline-"));
    const repository = await createOperationsRepository({
      databasePath: path.join(directory, "operations.sqlite"),
    });
    const service = await createOperationsService({
      repository,
      tickIntervalMs: 60_000,
    });

    try {
      const workspaceId = "retired-default-jury";
      const initial = await service.getSnapshot(workspaceId);
      const imported = await service.command(workspaceId, "jury-session", {
        commandId: "CMD-IMPORT-RETIRED-BASELINE-01",
        type: "import_configuration",
        expectedStateRevision: initial.stateRevision,
        payload: {
          name: "Retired built-in baseline fixture",
          native: retiredNativeBaseline(initial.native),
          detailed: retiredDetailedBaseline(initial.detailed),
        },
      });
      expect(imported.snapshot.native.timestamp).toBe(RETIRED_NATIVE_TIMESTAMP);
      expect(imported.snapshot.detailed.snapshot.timestamp).toBe(RETIRED_DETAILED_TIMESTAMP);

      const reset = await service.command(workspaceId, "jury-session", {
        commandId: "CMD-RESET-RETIRED-BASELINE-01",
        type: "reset_all",
        expectedStateRevision: imported.stateRevision,
        payload: {},
      });
      expect(reset.result).toMatchObject({ reset: true, baselineUpgraded: true });
      expect(reset.snapshot.native.timestamp).toBe(DEFAULT_TIMESTAMP);
      expect(reset.snapshot.detailed.snapshot.timestamp).toBe(DEFAULT_TIMESTAMP);
      expect(reset.snapshot.native.scenarioName).toBe("Paris afternoon multi-event");
      expect(reset.snapshot.detailed.snapshot.scenarioName).toBe(
        "Afternoon operations — D-1 events",
      );
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
