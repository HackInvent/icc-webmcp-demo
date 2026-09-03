import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PowerDiagram } from "../components/PowerDiagram";
import {
  advanceNativeSimulation,
  createNativeSimulationSnapshot,
} from "../rail/nativeSimulation";
import { createInitialSnapshot } from "../rail/scenario";
import { TRACTION_POWER_LINES, buildProjectedTractionPowerLine } from "../rail/tractionPowerView";
import { PowerPage } from "./PowerPage";

describe("traction power line view", () => {
  it("offers all 16 Metro and 5 RER lines while preserving detailed telemetry on the active reference line", () => {
    const snapshot = createInitialSnapshot();
    const nativeSimulation = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const html = renderToStaticMarkup(createElement(PowerPage, {
      snapshot,
      nativeSimulation,
      onSelect: () => undefined,
    }));

    expect(html.match(/role="tab"/g)).toHaveLength(21);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/class="power-line-tabs__dot"/g)).toHaveLength(21);
    expect(html).toContain('aria-label="Metro 1, 3 modelled sections"');
    expect(html).toContain('id="power-line-tab-M1"');
    expect(html).toContain('id="power-line-tab-M7BIS"');
    expect(html).toContain('id="power-line-tab-RER_E"');
    expect(html.match(/tabindex="-1"/g)).toHaveLength(20);
    expect(html).toContain("21 selectable lines");
    expect(html).toContain("RER A traction supply");
    expect(html).toContain("OPERATING CORRIDOR");
    expect(html).not.toContain("SIMULATED OPERATING CORRIDOR");
    expect(html).toContain('data-line-id="RER_A"');
    expect(html.match(/data-power-section-id=/g)).toHaveLength(2);
    expect(html).toContain('data-power-section-id="PWR-RA-OUEST"');
    expect(html).toContain('data-power-section-id="PWR-RA-EST"');
    expect(html).not.toContain('data-power-section-id="PWR-RB-NORD"');
    expect(PowerPage.toString()).toContain("onKeyDown");
    expect(PowerPage.toString()).toContain("ArrowRight");
  });

  it("renders a non-empty topology projection when a line has no detailed electrical telemetry", () => {
    const snapshot = createInitialSnapshot();
    const nativeSimulation = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const lineDemand = buildProjectedTractionPowerLine("M1", nativeSimulation);
    const html = renderToStaticMarkup(createElement(PowerPage, {
      snapshot,
      nativeSimulation,
      initialLineCode: "M1",
      onSelect: () => undefined,
    }));

    expect(html).toContain("Metro 1 traction supply");
    expect(html).toContain('data-line-id="M1"');
    expect(html).toContain('data-power-projection="topology"');
    expect(html.match(/data-power-model-section-id=/g)).toHaveLength(3);
    expect(html).toContain('data-power-model-section-id="MODEL-PWR-M1-01"');
    expect(html).toContain("Simulated traction demand");
    expect(html).toContain("Trains supplied");
    expect(html).toContain("2 running");
    expect(html).toContain("TRAIN-LINKED OPERATIONAL SIMULATION");
    expect(lineDemand.simulatedDemandMw).toBeGreaterThan(0);
    expect(html).toContain(`<strong>${lineDemand.simulatedDemandMw.toFixed(2)} MW</strong>`);
  });

  it("builds a named, non-empty power coverage model for every selectable line", () => {
    const nativeSimulation = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    expect(TRACTION_POWER_LINES).toHaveLength(21);
    for (const line of TRACTION_POWER_LINES) {
      const view = buildProjectedTractionPowerLine(line.code, nativeSimulation);
      expect(view.sections.length, line.code).toBeGreaterThan(0);
      expect(view.routeStationCount, line.code).toBeGreaterThan(1);
      expect(view.routeInterstationCount, line.code).toBeGreaterThan(0);
      expect(view.sections.every((section) => section.rangeLabel.includes("—")), line.code).toBe(true);
      expect(view.suppliedTrainCount, line.code).toBe(2);
      expect(view.runningTrainCount, line.code).toBe(2);
      expect(view.simulatedDemandMw, line.code).toBeGreaterThan(0);
      expect(view.sections.reduce((sum, section) => sum + section.suppliedTrainIds.length, 0), line.code)
        .toBe(view.suppliedTrainCount);
      expect(view.sections.reduce((sum, section) => sum + section.simulatedDemandMw, 0), line.code)
        .toBeCloseTo(view.simulatedDemandMw, 2);
    }
  });

  it("changes demand with movement while retaining auxiliary demand for stopped trains", () => {
    const initial = createNativeSimulationSnapshot({ scenarioId: "nominal" });
    const startupDemand = buildProjectedTractionPowerLine("M1", initial).simulatedDemandMw;
    const movingDemand = buildProjectedTractionPowerLine(
      "M1",
      advanceNativeSimulation(initial),
    ).simulatedDemandMw;
    const stopped = {
      ...initial,
      trains: initial.trains.map((train) => train.lineCode === "M1"
        ? { ...train, status: "stopped" as const, speedKmh: 0 }
        : train),
    };
    const stoppedDemand = buildProjectedTractionPowerLine("M1", stopped).simulatedDemandMw;

    expect(startupDemand).toBeGreaterThan(0);
    expect(movingDemand).toBeGreaterThan(startupDemand);
    expect(stoppedDemand).toBeGreaterThan(0);
    expect(stoppedDemand).toBeLessThan(startupDemand);
  });

  it("places the selected line electrical sections over its station and circuit sequence", () => {
    const snapshot = createInitialSnapshot();
    const html = renderToStaticMarkup(createElement(PowerDiagram, {
      snapshot,
      lineId: "RER_B",
      onSelect: () => undefined,
    }));

    expect(html).toContain('aria-label="RER B single-line electrical diagram"');
    expect(html.match(/data-electrical-section-id=/g)).toHaveLength(2);
    expect(html.match(/data-circuit-id=/g)).toHaveLength(5);
    expect(html.match(/data-station-name=/g)).toHaveLength(6);
    expect(html).toContain('data-electrical-section-id="PWR-RB-NORD"');
    expect(html).toContain("power-node--degraded");
    expect(html).toContain("Gare du Nord");
    expect(html).not.toContain("Metro 13 south");
  });
});
