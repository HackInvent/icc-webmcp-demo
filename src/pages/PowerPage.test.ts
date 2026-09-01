import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PowerDiagram } from "../components/PowerDiagram";
import { createInitialSnapshot } from "../rail/scenario";
import { PowerPage } from "./PowerPage";

describe("traction power line view", () => {
  it("offers every configured line while rendering only the active line sections", () => {
    const snapshot = createInitialSnapshot();
    const html = renderToStaticMarkup(createElement(PowerPage, {
      snapshot,
      onSelect: () => undefined,
    }));

    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("RER A traction supply");
    expect(html).toContain("OPERATING CORRIDOR");
    expect(html).not.toContain("SIMULATED OPERATING CORRIDOR");
    expect(html).toContain('data-line-id="RER_A"');
    expect(html.match(/data-power-section-id=/g)).toHaveLength(2);
    expect(html).toContain('data-power-section-id="PWR-RA-OUEST"');
    expect(html).toContain('data-power-section-id="PWR-RA-EST"');
    expect(html).not.toContain('data-power-section-id="PWR-RB-NORD"');
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
