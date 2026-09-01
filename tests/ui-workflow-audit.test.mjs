import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendShiftLog,
  buildShiftReportHtml,
  createShiftWorkspace,
} from "../server/shift-report.mjs";

const modalSource = readFileSync(
  new URL("../src/components/NativeIncidentDecisionModal.tsx", import.meta.url),
  "utf8",
);
const networkSource = readFileSync(
  new URL("../src/components/RatpNetworkSchematic.tsx", import.meta.url),
  "utf8",
);

function sourceSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}

describe("incident decision workspace audit contracts", () => {
  it("keeps the four decision phases in one workspace with a permanent procedure link", () => {
    const workspace = sourceSlice(
      modalSource,
      '<Modal\n      contentId="text-text-modal-native-incident-decision"',
      "</Modal>",
    );

    const phaseLabels = [
      "Situation & impact",
      "Action options & consequences",
      "Procedure execution",
      "Closure",
    ];
    let previousPhase = -1;
    for (const label of phaseLabels) {
      const phase = modalSource.indexOf(`label: "${label}"`);
      expect(phase).toBeGreaterThan(previousPhase);
      previousPhase = phase;
    }
    expect(workspace.match(/STEP [1-4] OF 4/g)).toHaveLength(4);
    expect(workspace).toContain('className="incident-workspace"');
    expect(workspace).toContain('className="incident-workspace__procedure-ribbon"');
    expect(workspace).toContain("procedurePath(decision.procedure.procedureId)");
    expect(workspace.indexOf("incident-workspace__procedure-ribbon"))
      .toBeLessThan(workspace.indexOf('activeStage === "situation"'));
    expect(workspace).not.toContain('contentId="text-text-modal-native-incident-unavailable"');
  });

  it("shows agent work, operational plans, and recorded receipts inside that workspace", () => {
    const workspace = sourceSlice(
      modalSource,
      '<Modal\n      contentId="text-text-modal-native-incident-decision"',
      "</Modal>",
    );

    expect(modalSource).toContain("AGENT WORKING · PROCEDURE-GROUNDED ANALYSIS");
    expect(modalSource).toContain('className="incident-agent-working" role="status"');
    expect(workspace).toContain("<AnalysisProgress progress={progress}/>");
    expect(modalSource).toContain("OPERATIONAL PLAN · OPERATOR APPROVAL REQUIRED");
    expect(workspace).toContain("<OperationalPlanCard plan={plan}/>");
    expect(workspace).toContain("selectedOperationalPlan && <OperationalPlanCard");
    expect(workspace).toContain('className="incident-completed-history"');
    expect(workspace).toContain("receiptForStep(step.stepId)");
    expect(workspace).toContain("Persisted completion · current operational record");
    expect(workspace).toContain('data-testid="operator-evidence-reference"');
    expect(workspace).toContain("operatorEvidenceReference");
    expect(workspace).toContain("Authority reference ·");
    expect(workspace.indexOf("incident-completed-history"))
      .toBeLessThan(workspace.indexOf('activeStage === "closure"'));
  });
});

describe("end-of-shift narrative audit contracts", () => {
  it("renders one narrative per incident without a table and orders its actions chronologically", () => {
    const openedAt = Date.UTC(2026, 7, 28, 6, 0, 0);
    const shift = createShiftWorkspace({
      recordedAt: openedAt,
      operationalTime: openedAt,
      nativeIncidents: [],
      detailedIncidents: [],
    });
    const incidentId = "INC-RERA-AUDIT";

    appendShiftLog(shift, {
      category: "incident",
      eventType: "incident-present",
      actor: "system",
      recordedAt: openedAt + 60_000,
      operationalTime: openedAt + 60_000,
      title: "Train immobilised at platform",
      summary: "Protected incident awaiting operator response.",
      incidentId,
      entityIds: [incidentId, "TRAIN-RERA-01"],
      durationSeconds: 0,
    });
    appendShiftLog(shift, {
      category: "operator-action",
      eventType: "procedure-step-applied",
      actor: "operator",
      recordedAt: openedAt + 5 * 60_000,
      operationalTime: openedAt + 5 * 60_000,
      title: "Protection recorded",
      summary: "Approaching movement held at the preceding station.",
      incidentId,
      entityIds: [incidentId],
      durationSeconds: 240,
    });
    appendShiftLog(shift, {
      category: "operator-action",
      eventType: "maintenance-dispatched",
      actor: "operator",
      recordedAt: openedAt + 9 * 60_000,
      operationalTime: openedAt + 9 * 60_000,
      title: "Maintenance dispatched",
      summary: "Rescue team assigned to the immobilised train.",
      incidentId,
      entityIds: [incidentId],
      durationSeconds: 480,
    });

    const html = buildShiftReportHtml(shift);
    const narrativeStart = html.indexOf(`(${incidentId})`);
    const firstAction = html.indexOf("Protection recorded", narrativeStart);
    const secondAction = html.indexOf("Maintenance dispatched", narrativeStart);

    expect(html).toContain("<h2>Incident narratives and actions</h2>");
    expect(html).not.toMatch(/<table(?:\s|>)/i);
    expect(html.match(new RegExp(`\\(${incidentId}\\)`, "g"))).toHaveLength(1);
    expect(html.slice(narrativeStart)).toMatch(/<p>Protected incident awaiting operator response\./);
    expect(html.slice(narrativeStart)).toContain("<ol>");
    expect(firstAction).toBeGreaterThan(narrativeStart);
    expect(secondAction).toBeGreaterThan(firstAction);
  });
});

describe("native network bus portal audit contracts", () => {
  it("anchors an active BUS icon to a native SVG station through the operational foreground portal", () => {
    const positioning = sourceSlice(
      networkSource,
      "function positionedBusServices(response: unknown)",
      "export function RatpNetworkSchematic",
    );
    const portal = sourceSlice(
      networkSource,
      "{artworkEpoch > 0 && activeBusServices.map((service) => {",
      '"bus-service-" + service.id,\n            );',
    );

    expect(positioning).toContain('measure.kind !== "shuttle-bus"');
    expect(positioning).toContain('measure.status !== "active"');
    expect(positioning).toContain("point: station.anchor");
    expect(portal).toContain("createPortal(");
    expect(portal).toContain("operationalForegroundLayersRef.current?.state");
    expect(portal).toContain('className="native-bus-marker"');
    expect(portal).toContain("data-bus-service-id={service.id}");
    expect(portal).toContain('transform={"translate(" + service.point.x + " " + service.point.y + ")"}');
    expect(portal).toContain("<text x=\"13\" y=\"-9\">BUS</text>");
    expect(portal).toContain("foreground,");
  });
});
