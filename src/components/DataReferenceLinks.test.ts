import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PageKey } from "../navigation";
import {
  DataReferenceLinks,
  RATP_SVG_REFERENCE_URL,
  WIKIPEDIA_NETWORK_REFERENCE_URL,
  pageUsesNativeNetworkSvg,
} from "./DataReferenceLinks";

const ALL_PAGE_KEYS: readonly PageKey[] = [
  "overview",
  "passenger-flow",
  "simulator",
  "procedures",
  "schedules",
  "incidents",
  "regulation",
  "power",
  "scada",
  "buses",
  "rolling-stock",
  "log",
  "report",
  "detail",
];

describe("view data-reference links", () => {
  it("publishes the Wikipedia network reference on every application view", () => {
    for (const page of ALL_PAGE_KEYS) {
      const html = renderToStaticMarkup(createElement(DataReferenceLinks, { page }));
      expect(html).toContain(`href="${WIKIPEDIA_NETWORK_REFERENCE_URL}"`);
      expect(html).toContain("Wikipedia · Île-de-France network");
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noreferrer"');
    }
  });

  it("adds the requested RATP link only where the native SVG is rendered", () => {
    for (const page of ALL_PAGE_KEYS) {
      const html = renderToStaticMarkup(createElement(DataReferenceLinks, { page }));
      expect(html.includes(`href="${RATP_SVG_REFERENCE_URL}"`)).toBe(
        page === "overview" || page === "passenger-flow",
      );
      expect(pageUsesNativeNetworkSvg(page)).toBe(
        page === "overview" || page === "passenger-flow",
      );
    }
  });
});
