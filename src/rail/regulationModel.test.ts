import { describe, expect, it } from "vitest";
import { NATIVE_LINES } from "./nativeNetwork";
import { createNativeSimulationSnapshot } from "./nativeSimulation";
import {
  buildNativeLineAxis,
  buildNativeLineSynoptic,
  buildNativeRegulationQueue,
  calculateNativeLineMetrics,
  calculateOperationalCellCrowding,
  deriveNativeShiftWindow,
  trainsAtOperationalCell,
} from "./regulationModel";

describe("native regulation model", () => {
  it("covers every native station and interstation, including branches and detached termini", () => {
    for (const line of NATIVE_LINES) {
      const synoptic = buildNativeLineSynoptic(line.code);
      const interstationIds = synoptic.lanes.flatMap((lane) =>
        lane.cells.flatMap((cell) => cell.type === "interstation" ? [cell.id] : []),
      );
      const primaryStationIds = synoptic.lanes.flatMap((lane) =>
        lane.cells.flatMap((cell) =>
          cell.type === "station" && cell.primaryOccurrence ? [cell.id] : []
        ),
      );
      expect(synoptic.uniqueStationCount, line.code).toBe(line.stationCodes.length);
      expect(synoptic.uniqueInterstationCount, line.code).toBe(line.interstationIds.length);
      expect(interstationIds, `${line.code} interstations appear once`).toHaveLength(new Set(interstationIds).size);
      expect([...interstationIds].sort(), `${line.code} complete interstation set`).toEqual([...line.interstationIds].sort());
      expect([...primaryStationIds].sort(), `${line.code} complete station set`).toEqual([...line.stationCodes].sort());
    }
    expect(buildNativeLineSynoptic("M13").lanes.some((lane) => lane.kind === "branch")).toBe(true);
    expect(buildNativeLineSynoptic("RER_A").lanes.some((lane) => lane.kind === "isolated")).toBe(true);
  });

  it("places every simulated train only on its exact station or interstation object", () => {
    const snapshot = createNativeSimulationSnapshot({ scenarioId: "multi-event" });
    const axis = buildNativeLineAxis(snapshot, "RER_A");
    expect(axis.length).toBeGreaterThan(3);
    const occupied = axis.flatMap((cell) => trainsAtOperationalCell(snapshot.trains, cell));
    expect(new Set(occupied.map((train) => train.id))).toEqual(
      new Set(snapshot.trains.filter((train) => train.lineCode === "RER_A").map((train) => train.id)),
    );
    expect(occupied).toHaveLength(new Set(occupied.map((train) => train.id)).size);
  });

  it("derives honest current-state and shift-to-now KPI estimates from the operational clock", () => {
    const snapshot = createNativeSimulationSnapshot({ scenarioId: "multi-event" });
    const metrics = calculateNativeLineMetrics(snapshot, "RER_A");
    const shift = deriveNativeShiftWindow(snapshot.timestamp);
    expect(metrics.trainCount).toBe(2);
    expect(metrics.referenceCapacityPerTrain).toBe(2610);
    expect(metrics.estimatedEnergyIndex).toBeGreaterThan(0);
    expect(metrics.estimatedShiftEnergyIndex).toBeGreaterThan(metrics.estimatedEnergyIndex);
    expect(metrics.shiftWindow).toEqual(shift);
    expect(shift.name).toBe("Early");
    expect(shift.startLabel).toBe("06:00");
    expect(shift.elapsedMinutes).toBe(420);
    expect(metrics.highestObjectCrowdingPercent).toBeGreaterThan(0);
  });

  it("derives station and interstation passenger pressure without inventing continuous positions", () => {
    const snapshot = createNativeSimulationSnapshot({ scenarioId: "multi-event" });
    const train = snapshot.trains.find((candidate) => candidate.lineCode === "RER_A");
    expect(train).toBeDefined();
    if (!train) return;
    const exact = calculateOperationalCellCrowding(
      snapshot.trains,
      train.location,
      "RER_A",
    );
    const approaching = calculateOperationalCellCrowding(
      snapshot.trains,
      { type: "station", id: train.toStationCode, primaryOccurrence: true },
      "RER_A",
    );
    expect(exact.basis).toBe("exact-occupation");
    expect(exact.passengerPressure).toBeGreaterThanOrEqual(train.passengers);
    expect(approaching.basis).toBe("station-and-approaching-flow");
    expect(approaching.passengerPressure).toBeGreaterThan(0);
  });

  it("sorts a current-state regulation queue deterministically", () => {
    const snapshot = createNativeSimulationSnapshot({ scenarioId: "multi-event" });
    const queue = buildNativeRegulationQueue(snapshot, "RER_A");
    expect(queue.some((item) => item.kind === "incident" && item.incidentId === "INC-RERA-SIGNAL")).toBe(true);
    expect(queue).toEqual([...queue].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)));
  });
});
