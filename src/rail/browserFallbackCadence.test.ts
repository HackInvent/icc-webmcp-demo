import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Topbar } from "../components/Topbar";
import {
  NATIVE_SIMULATION_STEP_MS,
  createNativeNetworkController,
} from "./nativeSimulation";
import {
  STEP_MS,
  advanceSimulation,
  createSimulationState,
  setSimulationSpeed,
} from "./simulation";
import { NATIVE_BROWSER_FALLBACK_TICK_INTERVAL_MS } from "./useNativeNetworkSimulation";
import { RAIL_BROWSER_FALLBACK_TICK_INTERVAL_MS } from "./useRailSimulation";

describe("browser fallback simulation cadence", () => {
  it("advances both ×1 models by one operational second per one-second browser tick", () => {
    expect(RAIL_BROWSER_FALLBACK_TICK_INTERVAL_MS).toBe(1_000);
    expect(NATIVE_BROWSER_FALLBACK_TICK_INTERVAL_MS).toBe(1_000);
    expect(STEP_MS).toBe(1_000);
    expect(NATIVE_SIMULATION_STEP_MS).toBe(1_000);

    const detailedStart = setSimulationSpeed(createSimulationState(), 1);
    const detailedNext = advanceSimulation(detailedStart);
    expect(detailedNext.snapshot.timestamp - detailedStart.snapshot.timestamp).toBe(1_000);

    const nativeController = createNativeNetworkController({ speed: 1 });
    const nativeStart = nativeController.getSnapshot();
    const nativeNext = nativeController.tick();
    expect(nativeNext.timestamp - nativeStart.timestamp).toBe(1_000);
  });

  it("announces the one-second operational step in the Topbar", () => {
    const state = createSimulationState();
    const html = renderToStaticMarkup(createElement(Topbar, {
      currentPage: "overview",
      snapshot: state.snapshot,
      speed: 1,
      setSpeed: vi.fn(),
      onSelect: vi.fn(),
      onSource: vi.fn(),
      onConfiguration: vi.fn(),
      configurationOpen: false,
      onReset: vi.fn(),
      onSignOut: vi.fn(),
    }));

    expect(html).toContain(
      'aria-label="Operational clock controls; each step advances 1 second"',
    );
    expect(html).toContain("01:00:00 PM");
    expect(html).toContain('aria-label="Sign out"');
  });
});
