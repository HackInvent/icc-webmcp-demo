import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createNativeSimulationSnapshot } from "../rail/nativeSimulation";
import { RegulationPage } from "./RegulationPage";
import { RollingStockPage } from "./RollingStockPage";

describe("rolling-stock and native regulation pages", () => {
  it("renders all 21 sourced line selectors and the visible demo-estimate boundary", () => {
    const html = renderToStaticMarkup(createElement(RollingStockPage));
    expect(html.match(/role="tab"/g)).toHaveLength(21);
    expect(html).toContain("Rolling stock &amp; load model");
    expect(html).toContain("DEMO ESTIMATE · UNCALIBRATED");
    expect(html).toContain("not kWh");
    expect(html).toContain("MI 09");
  });

  it("renders one complete active line with multiple exact train occupations and honest shift estimates", () => {
    const nativeSimulation = createNativeSimulationSnapshot({ scenarioId: "multi-event" });
    const html = renderToStaticMarkup(createElement(RegulationPage, { nativeSimulation }));
    const rerATrains = nativeSimulation.trains.filter((train) => train.lineCode === "RER_A");
    expect(html.match(/role="tab"/g)).toHaveLength(21);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("DISCRETE OCCUPATION");
    expect(html).toContain("COMPLETE NATIVE SYNOPTIC");
    expect(html).toContain("Current shift evidence boundary");
    expect(html).toContain("not historical");
    expect(html).toContain('data-complete-stations="11"');
    expect(html).toContain('data-complete-interstations="8"');
    expect(html.match(/data-station-occurrence="primary"/g)).toHaveLength(11);
    expect(html.match(/data-occupation-type="interstation"/g)).toHaveLength(8);
    expect(html).toContain("ICC-INC-INF-INT-BLK-001");
    expect(html).toContain("pax pressure");
    for (const train of rerATrains) expect(html).toContain(train.mission);
    expect(html).toContain('data-train-location="interstation"');
    expect(html).not.toContain("progress:");
    expect(html).not.toContain("translate(");
  });
});
