import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPassengerFlowView } from "../src/passenger/passengerFlowModel.ts";
import { PassengerFlowPage } from "../src/pages/PassengerFlowPage.tsx";
import { NATIVE_STATIONS } from "../src/rail/nativeNetwork.ts";
import { createNativeSimulationSnapshot } from "../src/rail/nativeSimulation.ts";
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
    expect(lineStation?.referencePlaces).toBeGreaterThan(0);
    expect(lineStation?.loadPercent).toBeGreaterThan(0);
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
  });
});
