import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildPassengerFlowView,
  passengerFlowHeatColor,
} from "../src/passenger/passengerFlowModel.ts";
import { PassengerFlowPage } from "../src/pages/PassengerFlowPage.tsx";
import { NATIVE_STATIONS } from "../src/rail/nativeNetwork.ts";
import { createNativeSimulationSnapshot } from "../src/rail/nativeSimulation.ts";
import { getMaximumTrainCapacity } from "../src/rail/rollingStock.ts";
import { createSimulationState } from "../src/rail/simulation.ts";

function passengerState(lineCode, stationId, waitingPassengers, arrivalsPerSecond) {
  return {
    id: `passenger:${lineCode}:${stationId}`,
    lineCode,
    stationId,
    waitingPassengers,
    arrivalRemainder: 0,
    arrivalsPerSecond,
    totalGeneratedPassengers: waitingPassengers,
    totalBoardedPassengers: 28,
    totalAlightedPassengers: 17,
    lastBoardedPassengers: 6,
    lastAlightedPassengers: 4,
    lastExchangeAt: Date.UTC(2026, 7, 30, 8, 14, 20),
    demandVolumeProvenance: "official-annual-passenger-journeys",
    referenceYear: 2025,
  };
}

describe("Passenger flow UI audit", () => {
  it("aggregates station-line queues, filters lines and renders the native-map heat layer", () => {
    const interchange = NATIVE_STATIONS.find((station) => station.lines.includes("M1") && station.lines.includes("M4"));
    expect(interchange).toBeDefined();
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const simulation = {
      ...initial,
      trains: [],
      stationPassengers: [
        passengerState("M1", interchange.code, 240, 1.25),
        passengerState("M4", interchange.code, 180, 0.75),
      ],
    };
    const detailed = createSimulationState().snapshot;

    const all = buildPassengerFlowView(simulation, detailed);
    const line = buildPassengerFlowView(simulation, detailed, "M1");
    expect(all.stations.find((item) => item.station.code === interchange.code)?.queuePassengers).toBe(420);
    expect(line.stations.find((item) => item.station.code === interchange.code)?.queuePassengers).toBe(240);
    expect(line.stations.find((item) => item.station.code === interchange.code)?.arrivalsPerSecond).toBe(1.25);
    const lineStation = line.stations.find((item) => item.station.code === interchange.code);
    expect(lineStation?.totalBoarded).toBe(28);
    expect(lineStation?.capacityReferencePlaces).toBe(getMaximumTrainCapacity("M1"));
    expect(lineStation?.loadPercent).toBe(Math.round(240 / getMaximumTrainCapacity("M1") * 100));
    expect(all.totalOnboardPassengers).toBe(0);

    const html = renderToStaticMarkup(createElement(PassengerFlowPage, {
      simulation,
      detailedSnapshot: detailed,
    }));
    expect(html).toContain('id="text-text-passenger-flow-page"');
    expect(html).toContain("Passenger flow");
    expect(html).toContain("Auditable demand formula");
    expect(html).toContain("Waiting queue");
    expect(html).toContain("Last boarded");
    expect(html).toContain("Last alighted");
    expect(html).toContain('data-testid="passenger-flow-line-filter"');
    expect(html).toContain('data-testid="passenger-flow-map"');
    expect(html.match(/data-testid="passenger-flow-station-marker"/g)).toHaveLength(NATIVE_STATIONS.length);
    expect(html).toContain("ratp-network-native");
    expect(html).toContain("Paris Metro and RER station passenger-pressure heatmap");
    expect(html).toContain("0% · light green");
    expect(html).toContain("50% · half train capacity");
    expect(html).toContain("100% · one train capacity");
    expect(html).toContain("200% · two train capacities");
    expect(html).toContain('data-queue-capacity-percent="0"');
    expect(html).toContain("fill:#b8f3cf");
    expect(html).toContain('r="5"');
  });

  it("maps station queues to the exact train-capacity heat anchors", () => {
    const station = NATIVE_STATIONS.find((candidate) => candidate.lines.includes("M1"));
    expect(station).toBeDefined();
    const capacity = getMaximumTrainCapacity("M1");
    const anchors = [
      { percent: 0, level: "quiet", color: "#b8f3cf" },
      { percent: 50, level: "moderate", color: "#f4d35e" },
      { percent: 100, level: "high", color: "#e63946" },
      { percent: 200, level: "critical", color: "#111317" },
    ];

    for (const anchor of anchors) {
      const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
      const simulation = {
        ...initial,
        trains: [],
        stationPassengers: [passengerState("M1", station.code, capacity * anchor.percent / 100, 0)],
      };
      const view = buildPassengerFlowView(simulation, createSimulationState().snapshot, "M1");
      const stationFlow = view.stations.find((item) => item.station.code === station.code);
      expect(stationFlow?.capacityReferencePlaces).toBe(capacity);
      expect(stationFlow?.loadPercent).toBe(anchor.percent);
      expect(stationFlow?.level).toBe(anchor.level);
      expect(passengerFlowHeatColor(stationFlow?.loadPercent ?? -1)).toBe(anchor.color);
    }

    expect(passengerFlowHeatColor(250)).toBe("#111317");
  });
});
