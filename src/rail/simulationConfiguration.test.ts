import { describe, expect, it } from "vitest";
import {
  SIMULATION_CONFIGURATION_SCHEMA,
  SimulationConfigurationError,
  createSimulationConfiguration,
  parseSimulationConfiguration,
  serializeSimulationConfiguration,
} from "./simulationConfiguration";
import {
  createNativeNetworkController,
  createNativeSimulationSnapshot,
} from "./nativeSimulation";
import { NATIVE_INTERSTATIONS } from "./nativeNetwork";
import { assertSnapshotInvariants, createSimulationState } from "./simulation";

describe("simulation configuration import/export", () => {
  it("round-trips both engines with explicit incident occurrence times", () => {
    const native = createNativeSimulationSnapshot({ scenarioId: "multi-event" });
    const detailed = createSimulationState();
    const json = serializeSimulationConfiguration(native, detailed);
    const document = JSON.parse(json) as Record<string, any>;

    expect(document.schema).toBe(SIMULATION_CONFIGURATION_SCHEMA);
    expect(document.simulationTime).toBe(new Date(native.timestamp).toISOString());
    expect(document.nativeNetwork.incidents).toHaveLength(native.incidents.length);
    expect(document.nativeNetwork.stationPassengers).toHaveLength(
      native.stationPassengers.length,
    );
    expect(document.nativeNetwork.incidents.every(
      (incident: Record<string, unknown>) =>
        typeof incident.occurrenceTime === "string" && !("startedAt" in incident),
    )).toBe(true);
    expect(document.detailedCorridor.incidents.every(
      (incident: Record<string, unknown>) =>
        typeof incident.occurrenceTime === "string" && !("startedAt" in incident),
    )).toBe(true);

    const parsed = parseSimulationConfiguration(json);
    expect(parsed.nativeSnapshot.timestamp).toBe(native.timestamp);
    expect(parsed.detailedState.snapshot.timestamp).toBe(native.timestamp);
    expect(parsed.nativeSnapshot.trains.map((train) => train.location)).toEqual(
      native.trains.map((train) => train.location),
    );
    expect(parsed.nativeSnapshot.incidents.map((incident) => incident.startedAt)).toEqual(
      native.incidents.map((incident) => incident.startedAt),
    );
    expect(parsed.nativeSnapshot.stationPassengers).toEqual(native.stationPassengers);
    expect(parsed.detailedState.snapshot.incidents.map((incident) => incident.startedAt)).toEqual(
      detailed.snapshot.incidents.map((incident) => incident.startedAt),
    );
    expect(parsed.detailedState.snapshot.incidents.map((incident) => incident.incidentCode)).toEqual(
      detailed.snapshot.incidents.map((incident) => incident.incidentCode),
    );
    expect(() => assertSnapshotInvariants(parsed.detailedState.snapshot)).not.toThrow();
  });

  it("classifies a legacy detailed incident when its code and structured metadata are absent", () => {
    const configuration = createSimulationConfiguration(
      createNativeSimulationSnapshot(),
      createSimulationState(),
    );
    const legacy = configuration.detailedCorridor.incidents.find(
      (incident) => incident.id === "INC-2407",
    ) as unknown as Record<string, unknown>;
    delete legacy.incidentCode;
    delete legacy.target;
    delete legacy.effect;

    const parsed = parseSimulationConfiguration(JSON.stringify(configuration));
    const restored = parsed.detailedState.snapshot.incidents.find(
      (incident) => incident.id === "INC-2407",
    );

    expect(restored?.incidentCode).toBe("ICC-INC-PAX-STA-CLS-001");
    expect(legacy).not.toHaveProperty("incidentCode");
    expect(() => assertSnapshotInvariants(parsed.detailedState.snapshot)).not.toThrow();
  });

  it("round-trips manual shuttles and preserves them in the imported reset baseline", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const edge = NATIVE_INTERSTATIONS.find((candidate) => candidate.lineCode === "M4")!;
    controller.insertShuttle({
      lineCode: "M4",
      departureStationId: edge.fromStationCode,
      arrivalStationId: edge.toStationCode,
    });
    controller.tick();
    const source = controller.getSnapshot();
    const configuration = createSimulationConfiguration(source, createSimulationState());

    expect(configuration.nativeNetwork.shuttles).toHaveLength(1);
    const parsed = parseSimulationConfiguration(JSON.stringify(configuration));
    expect(parsed.nativeSnapshot.shuttles).toEqual(source.shuttles);

    const restored = createNativeNetworkController({ scenarioId: "multi-event" });
    restored.loadConfiguration(parsed.nativeSnapshot);
    restored.tick();
    expect(restored.reset().shuttles).toEqual(source.shuttles);

    const legacy = structuredClone(configuration) as Record<string, any>;
    delete legacy.nativeNetwork.shuttles;
    expect(parseSimulationConfiguration(JSON.stringify(legacy)).nativeSnapshot.shuttles).toEqual([]);
  });

  it("accepts an edited baseline and makes native Reset return to it", () => {
    const native = createNativeSimulationSnapshot({ scenarioId: "multi-event" });
    const detailed = createSimulationState();
    const configuration = createSimulationConfiguration(native, detailed);
    configuration.name = "Edited morning baseline";
    configuration.nativeNetwork.trains[0].delaySeconds = 777;
    configuration.nativeNetwork.stationPassengers[0].waitingPassengers = 77;
    configuration.nativeNetwork.stationPassengers[0].arrivalRemainder = 0.25;
    configuration.nativeNetwork.stationPassengers[0].totalGeneratedPassengers = 120;
    configuration.nativeNetwork.stationPassengers[0].totalBoardedPassengers = 43;
    configuration.nativeNetwork.incidents[0].occurrenceTime =
      "2026-08-29T07:15:00.000Z";

    const parsed = parseSimulationConfiguration(
      JSON.stringify(configuration),
    );
    expect(parsed.name).toBe("Edited morning baseline");
    expect(parsed.nativeSnapshot.trains[0].delaySeconds).toBe(777);
    expect(parsed.nativeSnapshot.stationPassengers[0]).toEqual(expect.objectContaining({
      waitingPassengers: 77,
      arrivalRemainder: 0.25,
      totalGeneratedPassengers: 120,
      totalBoardedPassengers: 43,
    }));
    expect(parsed.nativeSnapshot.incidents[0].startedAt).toBe(
      Date.parse("2026-08-29T07:15:00.000Z"),
    );

    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const loaded = controller.loadConfiguration(parsed.nativeSnapshot);
    expect(loaded.trains[0].delaySeconds).toBe(777);
    controller.tick();
    const reset = controller.reset();
    expect(reset.timestamp).toBe(parsed.nativeSnapshot.timestamp);
    expect(reset.trains[0].delaySeconds).toBe(777);
    expect(reset.stationPassengers[0]).toEqual(expect.objectContaining({
      waitingPassengers: 77,
      arrivalRemainder: 0.25,
      totalGeneratedPassengers: 120,
      totalBoardedPassengers: 43,
    }));
    expect(reset.incidents[0].startedAt).toBe(
      Date.parse("2026-08-29T07:15:00.000Z"),
    );
  });

  it("imports a legacy configuration without passenger queues from an empty baseline", () => {
    const configuration = createSimulationConfiguration(
      createNativeSimulationSnapshot({ scenarioId: "nominal" }),
      createSimulationState(),
    );
    delete (configuration.nativeNetwork as Partial<
      typeof configuration.nativeNetwork
    >).stationPassengers;

    const parsed = parseSimulationConfiguration(JSON.stringify(configuration));
    expect(parsed.nativeSnapshot.stationPassengers.length).toBeGreaterThan(0);
    expect(parsed.nativeSnapshot.stationPassengers.every((state) =>
      state.waitingPassengers === 0 &&
      state.arrivalRemainder === 0 &&
      state.totalGeneratedPassengers === 0 &&
      state.totalBoardedPassengers === 0 &&
      state.totalAlightedPassengers === 0 &&
      state.lastBoardedPassengers === 0 &&
      state.lastAlightedPassengers === 0 &&
      state.lastExchangeAt === null
    )).toBe(true);
  });

  it("normalizes missing passenger exchange counters in an older configuration", () => {
    const configuration = createSimulationConfiguration(
      createNativeSimulationSnapshot({ scenarioId: "nominal" }),
      createSimulationState(),
    );
    const legacyState = configuration.nativeNetwork.stationPassengers[0] as unknown as
      Record<string, unknown>;
    legacyState.waitingPassengers = 12;
    delete legacyState.totalGeneratedPassengers;
    delete legacyState.totalBoardedPassengers;
    delete legacyState.totalAlightedPassengers;
    delete legacyState.lastBoardedPassengers;
    delete legacyState.lastAlightedPassengers;
    delete legacyState.lastExchangeAt;

    const restored = parseSimulationConfiguration(JSON.stringify(configuration))
      .nativeSnapshot.stationPassengers[0];
    expect(restored).toEqual(expect.objectContaining({
      waitingPassengers: 12,
      totalGeneratedPassengers: 0,
      totalBoardedPassengers: 0,
      totalAlightedPassengers: 0,
      lastBoardedPassengers: 0,
      lastAlightedPassengers: 0,
      lastExchangeAt: null,
    }));
  });


  it("preserves a scheduled incident target, effect, occurrence and status", () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const snapshot = controller.getSnapshot();
    const train = snapshot.trains.find((candidate) => candidate.lineCode === "RER_A")!;
    const occurrenceTime = snapshot.timestamp + 75_000;
    const created = controller.createIncident({
      lineCode: train.lineCode,
      target: { type: "train", id: train.id },
      effect: "stop-train",
      occurrenceTime,
      title: "Scheduled train immobilisation",
      summary: "Exercise import and export must preserve the complete incident contract.",
      type: "rolling-stock",
      severity: "high",
    });

    const json = serializeSimulationConfiguration(
      controller.getSnapshot(),
      createSimulationState(),
    );
    const document = JSON.parse(json) as Record<string, any>;
    const serialized = document.nativeNetwork.incidents.find(
      (incident: Record<string, unknown>) => incident.id === created.id,
    );
    expect(serialized).toEqual(expect.objectContaining({
      target: { type: "train", id: train.id },
      effect: "stop-train",
      status: "planned",
      activatedAt: null,
      occurrenceTime: new Date(occurrenceTime).toISOString(),
    }));
    expect(serialized).not.toHaveProperty("startedAt");

    const parsed = parseSimulationConfiguration(json);
    const restored = parsed.nativeSnapshot.incidents.find(
      (incident) => incident.id === created.id,
    );
    expect(restored).toEqual(expect.objectContaining({
      target: { type: "train", id: train.id },
      effect: "stop-train",
      status: "planned",
      startedAt: occurrenceTime,
      activatedAt: null,
    }));
  });

  it("rejects files without an explicit occurrenceTime before mutation", () => {
    const configuration = createSimulationConfiguration(
      createNativeSimulationSnapshot(),
      createSimulationState(),
    );
    const incident = configuration.nativeNetwork.incidents[0] as unknown as Record<string, unknown>;
    delete incident.occurrenceTime;

    expect(() => parseSimulationConfiguration(JSON.stringify(configuration)))
      .toThrowError(SimulationConfigurationError);
    expect(() => parseSimulationConfiguration(JSON.stringify(configuration)))
      .toThrow(/occurrenceTime/);
  });
});
