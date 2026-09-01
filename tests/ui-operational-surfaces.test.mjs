import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SimulatorIncidentModal } from "../src/components/SimulatorIncidentModal.tsx";
import { createOperationalResponseState } from "../src/operations/operationalResponse.ts";
import { BusServicesPage } from "../src/pages/BusServicesPage.tsx";
import { ScadaPage } from "../src/pages/ScadaPage.tsx";
import { createNativeSimulationSnapshot } from "../src/rail/nativeSimulation.ts";
import { createSimulationState } from "../src/rail/simulation.ts";

const OPERATIONAL_TIME = Date.UTC(2026, 7, 28, 9, 0, 0);

describe("operational UI contracts", () => {
  it("renders all 21 SCADA line selectors and maps an unavailable line to offline with its dispatch", () => {
    const simulation = createNativeSimulationSnapshot({
      scenarioId: "nominal",
      startTimestamp: OPERATIONAL_TIME,
    });
    const initial = createOperationalResponseState(OPERATIONAL_TIME);
    const operationalResponse = {
      ...initial,
      lineScada: initial.lineScada.map((line) => line.lineCode === "M14"
        ? {
            ...line,
            status: "unavailable",
            communicationIncidentId: "INC-M14-COMMS",
          }
        : line),
      dispatches: [{
        dispatchId: "DISPATCH-M14-COMMS",
        incidentId: "INC-M14-COMMS",
        lineCode: "M14",
        targetType: "line",
        targetId: "M14",
        status: "dispatched",
        proposedAt: OPERATIONAL_TIME - 60_000,
        dispatchedAt: OPERATIONAL_TIME,
        completedAt: null,
        receiptId: "RECEIPT-M14-COMMS",
      }],
    };

    const html = renderToStaticMarkup(createElement(ScadaPage, {
      simulation,
      operationalResponse,
      onIncidentActivate: vi.fn(),
    }));
    const lineStrip = html.match(/<nav class="line-tab-strip"[\s\S]*?<\/nav>/)?.[0] ?? "";

    expect(lineStrip.match(/<button/g)).toHaveLength(21);
    expect(html).toContain("SCADA &amp; information architecture");
    expect(html).toContain("tone-offline");
    expect(html).toContain("Supervision link unavailable");
    expect(html).toContain("INC-M14-COMMS · maintenance dispatched");
    expect(html).toContain("Open incident procedure");
  });

  it("reads a top-level continuity measure and renders a bidirectional active shuttle", () => {
    const simulation = createNativeSimulationSnapshot({
      scenarioId: "nominal",
      startTimestamp: OPERATIONAL_TIME,
    });
    const operationalResponse = {
      ...createOperationalResponseState(OPERATIONAL_TIME),
      continuityMeasures: [{
        measureId: "MEASURE:INC-RERA-LONG:shuttle-bus",
        incidentId: "INC-RERA-LONG",
        kind: "shuttle-bus",
        lineCodes: ["RER_A"],
        status: "active",
        proposedAt: OPERATIONAL_TIME - 300_000,
        approvedAt: OPERATIONAL_TIME,
        approvedBy: "operator-test",
        completedAt: null,
        stationIds: ["IDFM:68385", "IDFM:72881"],
        connectionIds: [],
        receiptId: "RECEIPT-RERA-BUS",
        directions: ["outbound", "inbound"],
        plan: {
          kind: "shuttle-bus",
          terminusStationIds: ["IDFM:68385", "IDFM:72881"],
          directions: [
            { direction: "outbound", fromStationId: "IDFM:68385", toStationId: "IDFM:72881" },
            { direction: "inbound", fromStationId: "IDFM:72881", toStationId: "IDFM:68385" },
          ],
          fleetSize: 6,
          headwaySeconds: 600,
          vehicleCapacityPassengers: 80,
          capacityPerHour: 2_880,
          routeTravelSeconds: 1_800,
          layoverSeconds: 300,
          graphInterstationIds: [],
          cycle: {
            phase: "outbound",
            direction: "outbound",
            atStationId: null,
            cycleIndex: 0,
            phaseStartedAt: OPERATIONAL_TIME,
            nextTransitionAt: OPERATIONAL_TIME + 1_800_000,
          },
        },
        fleetSize: 99,
        headwaySeconds: 60,
        capacityPerHour: 99,
      }],
    };

    const html = renderToStaticMarkup(createElement(BusServicesPage, {
      simulation,
      operationalResponse,
      onIncidentActivate: vi.fn(),
    }));

    expect(html).toContain("Bus shuttle operations");
    expect(html).toContain("MEASURE:INC-RERA-LONG:shuttle-bus");
    expect(html).toContain("Marne-la-Vallée - Chessy");
    expect(html).toContain("Boissy-Saint-Léger");
    expect(html).toContain("OUTBOUND");
    expect(html).toContain("↔");
    expect(html).toContain("6 buses");
    expect(html).toContain("2,880/h");
    expect(html).toContain("2880 pax/h");
    expect(html).toContain("outbound");
    expect(html).not.toContain("99 buses");
    expect(html).not.toContain("No shuttle service is active");
  });

  it("exposes line/SCADA targets and every requested specialised incident effect", () => {
    const nativeSimulation = createNativeSimulationSnapshot({
      scenarioId: "nominal",
      startTimestamp: OPERATIONAL_TIME,
    });
    const detailed = createSimulationState();
    const html = renderToStaticMarkup(createElement(SimulatorIncidentModal, {
      snapshot: detailed.snapshot,
      nativeSimulation,
      initialLine: "M14",
      onClose: vi.fn(),
      onSubmit: vi.fn(),
    }));
    const source = readFileSync(
      new URL("../src/components/SimulatorIncidentModal.tsx", import.meta.url),
      "utf8",
    );

    expect(html).toContain('data-testid="sim-incident-target-type-line"');
    expect(html).toContain("SCADA / line");
    expect(html).toContain("Severe failure · towing required");

    expect(source).toMatch(/line:\s*\[[\s\S]*value:\s*"communications"/);
    expect(source).toMatch(/line:\s*\[[\s\S]*value:\s*"communication-degraded"[\s\S]*value:\s*"communication-loss"/);
    expect(source).toMatch(/station:\s*\[[\s\S]*value:\s*"abandoned-baggage"/);
    expect(source).toMatch(/train:\s*\[[\s\S]*value:\s*"tow-train"/);
    expect(source).toContain('if (nextEffect === "abandoned-baggage") setType("security")');
    expect(source).toContain('if (nextEffect === "communication-degraded" || nextEffect === "communication-loss") setType("communications")');
  });
});
