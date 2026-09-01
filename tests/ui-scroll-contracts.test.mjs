import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const configurationStyles = readFileSync(
  new URL("../src/configuration-modal.css", import.meta.url),
  "utf8",
);
const operationsLogStyles = readFileSync(
  new URL("../src/shift-report.css", import.meta.url),
  "utf8",
);
const networkStyles = readFileSync(
  new URL("../src/native-network.css", import.meta.url),
  "utf8",
);
const incidentStyles = readFileSync(
  new URL("../src/incident-decision.css", import.meta.url),
  "utf8",
);
const procedureEditorStyles = readFileSync(
  new URL("../src/components/ProcedureEditorModal.css", import.meta.url),
  "utf8",
);
const simulatorSource = readFileSync(
  new URL("../src/pages/SimulatorPage.tsx", import.meta.url),
  "utf8",
);
const configurationSource = readFileSync(
  new URL("../src/components/ConfigurationModal.tsx", import.meta.url),
  "utf8",
);
const operationsLogSource = readFileSync(
  new URL("../src/pages/OperationsLogPage.tsx", import.meta.url),
  "utf8",
);

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp("(?:^|})\\s*" + escaped + "\\s*\\{([^}]*)\\}", "m"));
  expect(match, "missing CSS rule " + selector).not.toBeNull();
  return match[1].replace(/\s+/g, " ");
}

describe("long-list scroll contracts", () => {
  it("bounds the configuration workspace and gives the complete agent log a vertical scroll area", () => {
    expect(cssRule(configurationStyles, "#text-text-modal-configuration")).toContain(
      "grid-template-rows: auto minmax(0, 1fr)",
    );
    expect(cssRule(
      configurationStyles,
      "#text-text-modal-configuration .modal__body",
    )).toMatch(/min-height:\s*0.*overflow:\s*hidden/);
    expect(cssRule(configurationStyles, ".configuration-panel")).toContain(
      "overflow-y: auto",
    );
    expect(cssRule(configurationStyles, ".configuration-panel--log")).toMatch(
      /grid-template-rows:\s*auto minmax\(0, 1fr\).*overflow:\s*hidden/,
    );
    expect(cssRule(configurationStyles, ".configuration-log-table-wrap")).toMatch(
      /min-height:\s*0.*overflow:\s*auto/,
    );
    expect(cssRule(configurationStyles, ".configuration-log-table th")).toMatch(
      /position:\s*sticky.*top:\s*0/,
    );
    expect(configurationSource).toContain('aria-label="Scrollable agent execution log"');
    expect(configurationSource).toMatch(/configuration-log-table-wrap[\s\S]*?tabIndex=\{0\}/);
  });

  it("keeps the other potentially long operational lists reachable", () => {
    expect(cssRule(operationsLogStyles, ".operations-log__table-wrap")).toMatch(
      /max-height:.*overflow:\s*auto/,
    );
    expect(cssRule(operationsLogStyles, ".operations-log__table th")).toMatch(
      /position:\s*sticky.*top:\s*0/,
    );
    expect(operationsLogSource).toContain('aria-label="Scrollable operations log"');
    expect(operationsLogSource).toMatch(/operations-log__table-wrap[\s\S]*?tabIndex=\{0\}/);
    expect(cssRule(styles, ".table-wrap")).toContain("overflow: auto");
    expect(cssRule(styles, ".schedule-table-wrap")).toContain("max-height:");
    expect(cssRule(styles, ".schedule-table thead th")).toMatch(
      /position:\s*sticky.*top:\s*0/,
    );
    expect(cssRule(styles, ".power-section-list")).toMatch(
      /max-height:.*overflow:\s*auto/,
    );
    expect(cssRule(styles, ".procedure-library__list")).toMatch(
      /max-height:.*overflow-y:\s*auto/,
    );
    expect(cssRule(networkStyles, ".native-map__lines")).toMatch(
      /max-height:.*overflow-y:\s*auto/,
    );
    expect(cssRule(networkStyles, ".native-map__inspector-body")).toContain(
      "overflow-y: auto",
    );
    expect(simulatorSource).toContain("rows.slice(pageStart, pageEnd)");
    expect(simulatorSource).toContain("Page {pageIndex + 1} / {pageCount}");
  });

  it("retains scrolling inside the two large procedure workspaces", () => {
    expect(cssRule(incidentStyles, ".modal--workspace .modal__body")).toMatch(
      /min-height:\s*0.*overflow-y:\s*auto/,
    );
    expect(procedureEditorStyles).toMatch(
      /\.procedure-editor__rail,[\s\S]*?\.procedure-editor__review\s*\{[\s\S]*?overflow-y:\s*auto/,
    );
  });
});
