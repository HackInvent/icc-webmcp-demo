import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createNativeSimulationSnapshot } from "../rail/nativeSimulation";
import { createSimulationState } from "../rail/simulation";
import { SimulatorPage } from "./SimulatorPage";

describe("SimulatorPage", () => {
  it("renders the shared live model as an accessible object registry", () => {
    const detailed = createSimulationState();
    const native = createNativeSimulationSnapshot();

    const html = renderToStaticMarkup(createElement(SimulatorPage, {
      snapshot: detailed.snapshot,
      nativeSimulation: native,
      onSelect: vi.fn(),
      onCreateIncident: vi.fn(),
      onInsertTrain: vi.fn(),
    }));

    expect(html).toContain("Simulation data");
    expect(html).toContain("SIMULATED OBJECT REGISTRY");
    expect(html).not.toContain("Export config");
    expect(html).not.toContain("Import config");
    expect(html).not.toContain('data-testid="export-simulation-configuration"');
    expect(html).not.toContain('data-testid="import-simulation-configuration"');
    expect(html).not.toContain("configuration-file-input");
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(8);
    expect(html).toContain("Operational location");
    expect(html).toContain("Dwell remaining");
    expect(html).toContain(native.trains[0].id);
    expect(html).toContain(String(native.trains.length));
    expect(html).toContain(String(detailed.snapshot.powerSections.length));
    expect(html).toContain('id="text-text-simulator-train-insertion"');
    expect(html).toContain('data-control-owner="operator"');
    expect(html).toContain("Insert a reinforcement train");
    expect(html).toContain("separate from incident-driven agent recommendations");
    expect(html).toContain('data-testid="sim-train-insertion-line"');
    expect(html).toContain('data-testid="sim-train-insertion-station"');
    expect(html).toContain('data-testid="sim-train-insertion-direction"');
    expect(html).toContain('data-testid="sim-train-insertion-submit"');
    expect(html).toContain("Discrete station occupation");
  });
});
