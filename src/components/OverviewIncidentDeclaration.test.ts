import { createElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSimulationState } from "../rail/simulation";
import {
  NATIVE_INTERSTATIONS,
  NATIVE_STATIONS,
  type NativeLineCode,
} from "../rail/nativeNetwork";
import { createNativeSimulationSnapshot } from "../rail/nativeSimulation";
import {
  nativeIncidentMarkerSymbol,
  RatpNetworkSchematic,
} from "./RatpNetworkSchematic";
import {
  incidentImpactCopy,
  SimulatorIncidentModal,
  STATION_INCIDENT_CHOICES,
} from "./SimulatorIncidentModal";

type ForcedMapSelection =
  | { kind: "station"; id: string }
  | { kind: "interstation"; id: string };

interface CapturedButtonProps {
  onClick?: () => void;
  [key: string]: unknown;
}

const renderHarness = vi.hoisted(() => ({
  selection: null as ForcedMapSelection | null,
  declareButtonProps: null as CapturedButtonProps | null,
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const useState = (<T,>(initialState: T | (() => T)) => {
    const resolved = typeof initialState === "function"
      ? (initialState as () => T)()
      : initialState;
    const isMapSelection = Boolean(
      resolved &&
      typeof resolved === "object" &&
      "kind" in resolved &&
      "id" in resolved &&
      (resolved.kind === "incident" || resolved.kind === "station" || resolved.kind === "interstation"),
    );
    return react.useState<T>(
      isMapSelection && renderHarness.selection
        ? renderHarness.selection as T
        : initialState,
    );
  }) as <T>(initialState: T | (() => T)) => [T, Dispatch<SetStateAction<T>>];
  return { ...react, useState };
});

function captureJsxFactory<T extends (...args: never[]) => unknown>(factory: T): T {
  return ((type: unknown, props: CapturedButtonProps | null, ...rest: unknown[]) => {
    if (type === "button" && props?.["data-testid"] === "native-declare-incident") {
      renderHarness.declareButtonProps = props;
    }
    return factory(type as never, props as never, ...rest as never[]);
  }) as unknown as T;
}

vi.mock("react/jsx-runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("react/jsx-runtime")>();
  return {
    ...runtime,
    jsx: captureJsxFactory(runtime.jsx),
    jsxs: captureJsxFactory(runtime.jsxs),
  };
});

vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return {
    ...runtime,
    jsxDEV: captureJsxFactory(runtime.jsxDEV),
  };
});

const station = NATIVE_STATIONS.find((candidate) => candidate.lines.length === 1);
const interstation = station
  ? NATIVE_INTERSTATIONS.find((candidate) => candidate.lineCode === station.lines[0])
  : undefined;

if (!station || !interstation) {
  throw new Error("The native network fixture must expose a single-line station and interstation.");
}

function selectMarkup(html: string, testId: string): string {
  const match = html.match(new RegExp(
    `<select[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?<\\/select>`,
  ));
  if (!match) throw new Error(`Missing select ${testId}.`);
  return match[0];
}

function checkedInputMarkup(html: string, testId: string): string {
  const match = html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`));
  if (!match) throw new Error(`Missing input ${testId}.`);
  return match[0];
}

describe("Station incident form choices", () => {
  it("exposes explicit station scenarios as coherent type/effect pairs", () => {
    expect(STATION_INCIDENT_CHOICES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Station closure for engineering works",
        type: "works",
        effect: "station-closure",
      }),
      expect.objectContaining({
        label: "Abandoned baggage",
        type: "security",
        effect: "abandoned-baggage",
      }),
    ]));
    expect(incidentImpactCopy("station-closure")).toMatch(/prevent trains from passing through or stopping/i);
    expect(incidentImpactCopy("station-closure")).toMatch(/provisional services/i);
    expect(incidentImpactCopy("abandoned-baggage")).toMatch(/cannot pass through or stop/i);
    expect(incidentImpactCopy("abandoned-baggage")).toMatch(/provisional services/i);
  });

  it("uses the dedicated baggage marker from the structured incident effect", () => {
    expect(nativeIncidentMarkerSymbol({
      effect: "abandoned-baggage",
      type: "security",
    })).toBe("baggage");
    expect(nativeIncidentMarkerSymbol({
      effect: "station-closure",
      type: "works",
    })).toBe("alert");
    expect(nativeIncidentMarkerSymbol({
      effect: "block-interstation",
      type: "power",
    })).toBe("power");
  });
});

describe("Overview incident declaration", () => {
  beforeEach(() => {
    vi.stubGlobal("SVGSVGElement", class SVGSVGElementStub {});
    renderHarness.selection = null;
    renderHarness.declareButtonProps = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares an incident from a selected station with an exact prefilled target", () => {
    renderHarness.selection = { kind: "station", id: station.svgId };
    const onDeclareIncident = vi.fn();

    const html = renderToStaticMarkup(createElement(RatpNetworkSchematic, {
      simulation: createNativeSimulationSnapshot(),
      onIncidentActivate: vi.fn(),
      onDeclareIncident,
    }));

    expect(html).toContain("Declare incident");
    expect(html).toContain('data-testid="native-declare-incident"');
    expect(html).toContain('data-incident-target-type="station"');
    expect(html).toContain(`data-incident-target-id="${station.code}"`);
    expect(html).toContain(`data-incident-line-code="${station.lines[0]}"`);

    renderHarness.declareButtonProps?.onClick?.();
    expect(onDeclareIncident).toHaveBeenCalledOnce();
    expect(onDeclareIncident).toHaveBeenCalledWith({
      targetType: "station",
      targetId: station.code,
      lineCode: station.lines[0],
    });
  });

  it("declares an incident from a selected interstation with an exact prefilled target", () => {
    renderHarness.selection = { kind: "interstation", id: interstation.id };
    const onDeclareIncident = vi.fn();

    const html = renderToStaticMarkup(createElement(RatpNetworkSchematic, {
      simulation: createNativeSimulationSnapshot(),
      onIncidentActivate: vi.fn(),
      onDeclareIncident,
    }));

    expect(html).toContain("Declare incident");
    expect(html).toContain('data-testid="native-declare-incident"');
    expect(html).toContain('data-incident-target-type="interstation"');
    expect(html).toContain(`data-incident-target-id="${interstation.id}"`);
    expect(html).toContain(`data-incident-line-code="${interstation.lineCode}"`);

    renderHarness.declareButtonProps?.onClick?.();
    expect(onDeclareIncident).toHaveBeenCalledOnce();
    expect(onDeclareIncident).toHaveBeenCalledWith({
      targetType: "interstation",
      targetId: interstation.id,
      lineCode: interstation.lineCode,
    });
  });

  it.each([
    {
      label: "station",
      initialTarget: {
        targetType: "station" as const,
        targetId: station.code,
        lineCode: station.lines[0] as NativeLineCode,
      },
    },
    {
      label: "interstation",
      initialTarget: {
        targetType: "interstation" as const,
        targetId: interstation.id,
        lineCode: interstation.lineCode,
      },
    },
  ])("prefills the $label target in the operational incident form", ({ initialTarget }) => {
    const html = renderToStaticMarkup(createElement(SimulatorIncidentModal, {
      snapshot: createSimulationState().snapshot,
      nativeSimulation: createNativeSimulationSnapshot(),
      initialLine: initialTarget.lineCode,
      initialTarget,
      context: "operations",
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    }));

    expect(checkedInputMarkup(
      html,
      `sim-incident-target-type-${initialTarget.targetType}`,
    )).toContain("checked");
    expect(selectMarkup(html, "sim-incident-line")).toContain(
      `<option value="${initialTarget.lineCode}" selected="">`,
    );
    expect(selectMarkup(html, "sim-incident-target")).toContain(
      `<option value="${initialTarget.targetId}" selected="">`,
    );
    expect(html).toContain("Declare an incident");
    expect(html).not.toContain("Add a simulated incident");
    if (initialTarget.targetType === "station") {
      const stationChoice = selectMarkup(html, "sim-incident-station-choice");
      expect(stationChoice).toContain('<option value="works:station-closure" selected="">Station closure for engineering works</option>');
      expect(stationChoice).toContain('<option value="security:abandoned-baggage">Abandoned baggage</option>');
      expect(html).toContain('data-incident-type="works"');
      expect(html).toContain('data-incident-effect="station-closure"');
      expect(html).toContain("prevent trains from passing through or stopping");
      expect(html).toContain("provisional services");
    }
  });
});
