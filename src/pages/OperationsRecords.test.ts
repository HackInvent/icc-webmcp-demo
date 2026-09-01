import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShiftWorkspaceSnapshot } from "../runtime/types";
import { OperationsLogPage } from "./OperationsLogPage";
import { ShiftReportPage } from "./ShiftReportPage";

function shift(status: "draft" | "frozen" = "draft"): ShiftWorkspaceSnapshot {
  return {
    shiftId: "shift-page-test",
    startedAt: 1_788_000_000_000,
    startedOperationalTime: 1_788_000_000_000,
    nextLogSequence: 3,
    logs: [
      {
        id: "LOG-PAGE-00001",
        sequence: 1,
        category: "incident",
        eventType: "incident-created",
        actor: "system",
        recordedAt: 1_788_000_000_000,
        operationalTime: 1_788_000_000_000,
        title: "Older incident entry",
        summary: "Incident opened.",
        incidentId: "INC-001",
        entityIds: ["INC-001"],
        durationSeconds: 0,
      },
      {
        id: "LOG-PAGE-00002",
        sequence: 2,
        category: "operator-action",
        eventType: "procedure-step-recorded",
        actor: "operator",
        recordedAt: 1_788_000_120_000,
        operationalTime: 1_788_000_120_000,
        title: "Newest operator action",
        summary: "Protection recorded.",
        incidentId: "INC-001",
        entityIds: ["INC-001", "S01"],
        durationSeconds: 120,
      },
    ],
    report: {
      reportId: "report-page-test",
      status,
      title: "End-of-shift report",
      contentHtml: "<h1>End-of-shift report</h1><p>Editable draft</p>",
      createdAt: 1_788_000_000_000,
      updatedAt: 1_788_000_120_000,
      frozenAt: status === "frozen" ? 1_788_000_180_000 : null,
      generatedAt: null,
      sourceLogSequence: 2,
    },
  };
}

describe("operations records pages", () => {
  it("renders the persisted log newest first with timestamps and durations", () => {
    const html = renderToStaticMarkup(createElement(OperationsLogPage, {
      shift: shift(),
    }));
    expect(html).toContain("Operations log");
    expect(html.indexOf("Newest operator action")).toBeLessThan(
      html.indexOf("Older incident entry"),
    );
    expect(html).toContain("2m 00s");
    expect(html).toContain("LOG-PAGE-00002");
  });

  it("renders an autosaved rich editor without a Save button and locks frozen reports", () => {
    const draft = renderToStaticMarkup(createElement(ShiftReportPage, {
      shift: shift(),
    }));
    expect(draft).toContain("Draft from shift logs");
    expect(draft).toContain("Freeze &amp; print PDF");
    expect(draft).toContain("Autosave enabled · no Save button");
    expect(draft).toContain('contenteditable="true"');
    expect(draft).not.toContain(">Save<");

    const frozen = renderToStaticMarkup(createElement(ShiftReportPage, {
      shift: shift("frozen"),
    }));
    expect(frozen).toContain("Print / save PDF");
    expect(frozen).toContain("Editing locked");
    expect(frozen).toContain('contenteditable="false"');
  });
});
