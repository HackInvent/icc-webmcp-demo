import type {
  CircuitView,
  DriverResource,
  Incident,
  PowerSection,
  RailEvent,
  RailSnapshot,
  SimulationState,
  TrainView,
} from "./domain";
import {
  NATIVE_SCENARIOS,
  createNativeSimulationSnapshotFromConfiguration,
  type NativeIncident,
  type NativeScenarioId,
  type NativeSimulationSnapshot,
  type NativeSimulationSpeed,
  type NativeStationPassengerState,
  type NativeTrainState,
} from "./nativeSimulation";
import {
  assertSnapshotInvariants,
  normalizeDetailedIncidentCode,
  type DetailedIncidentWithOptionalCode,
} from "./simulation";

export const SIMULATION_CONFIGURATION_SCHEMA =
  "paris-icc-simulation-configuration-v1" as const;
export const MAX_SIMULATION_CONFIGURATION_BYTES = 4_000_000;

export interface SerializedNativeIncident
  extends Omit<NativeIncident, "startedAt"> {
  occurrenceTime: string;
}

export interface SerializedDetailedIncident
  extends Omit<Incident, "startedAt"> {
  occurrenceTime: string;
}

export interface SimulationConfigurationV1 {
  schema: typeof SIMULATION_CONFIGURATION_SCHEMA;
  name: string;
  description: string;
  exportedAt: string;
  simulationTime: string;
  speed: NativeSimulationSpeed;
  nativeNetwork: {
    scenarioId: NativeScenarioId;
    scenarioName: string;
    trains: NativeTrainState[];
    stationPassengers: NativeStationPassengerState[];
    incidents: SerializedNativeIncident[];
  };
  detailedCorridor: {
    scenarioName: string;
    trains: TrainView[];
    circuits: CircuitView[];
    drivers: DriverResource[];
    incidents: SerializedDetailedIncident[];
    powerSections: PowerSection[];
    events: RailEvent[];
  };
}

export interface ParsedSimulationConfiguration {
  name: string;
  nativeSnapshot: NativeSimulationSnapshot;
  detailedState: SimulationState;
}

export class SimulationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationConfigurationError";
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SimulationConfigurationError(label + " must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function asObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new SimulationConfigurationError(label + " must be an array.");
  }
  return value.map((item, index) => asRecord(item, label + "[" + index + "]"));
}

function asString(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new SimulationConfigurationError(
      label + " must be a non-empty string of at most " + maximum + " characters.",
    );
  }
  return value.trim();
}

function asTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new SimulationConfigurationError(
      label + " must be an ISO-8601 date-time string.",
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new SimulationConfigurationError(
      label + " is not a valid ISO-8601 date-time.",
    );
  }
  return timestamp;
}

function asSpeed(value: unknown): NativeSimulationSpeed {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 4) {
    throw new SimulationConfigurationError(
      "speed must be one of 0, 1, 2 or 4.",
    );
  }
  return value;
}

function serializeNativeIncident(
  incident: NativeIncident,
): SerializedNativeIncident {
  const { startedAt, ...rest } = cloneJson(incident);
  return {
    ...rest,
    occurrenceTime: new Date(startedAt).toISOString(),
  };
}

function serializeDetailedIncident(
  incident: Incident,
): SerializedDetailedIncident {
  const { startedAt, ...rest } = cloneJson(incident);
  return {
    ...rest,
    occurrenceTime: new Date(startedAt).toISOString(),
  };
}

function parseIncident<T>(
  raw: Record<string, unknown>,
  label: string,
): T & { startedAt: number } {
  const occurrenceTime = asTimestamp(raw.occurrenceTime, label + ".occurrenceTime");
  const { occurrenceTime: ignored, startedAt: legacyStartedAt, ...rest } = raw;
  void ignored;
  void legacyStartedAt;
  return {
    ...cloneJson(rest),
    startedAt: occurrenceTime,
  } as T & { startedAt: number };
}

export function createSimulationConfiguration(
  nativeSnapshot: NativeSimulationSnapshot,
  detailedState: SimulationState,
): SimulationConfigurationV1 {
  const exportedAt = new Date().toISOString();
  return {
    schema: SIMULATION_CONFIGURATION_SCHEMA,
    name: nativeSnapshot.scenarioName + " configuration",
    description:
      "Editable starting state for the local Paris ICC deterministic simulation.",
    exportedAt,
    simulationTime: new Date(nativeSnapshot.timestamp).toISOString(),
    speed: nativeSnapshot.speed,
    nativeNetwork: {
      scenarioId: nativeSnapshot.scenarioId,
      scenarioName: nativeSnapshot.scenarioName,
      trains: cloneJson(nativeSnapshot.trains) as NativeTrainState[],
      stationPassengers: cloneJson(nativeSnapshot.stationPassengers) as NativeStationPassengerState[],
      incidents: nativeSnapshot.incidents.map(serializeNativeIncident),
    },
    detailedCorridor: {
      scenarioName: detailedState.snapshot.scenarioName,
      trains: cloneJson(detailedState.snapshot.trains),
      circuits: cloneJson(detailedState.snapshot.circuits),
      drivers: cloneJson(detailedState.snapshot.drivers),
      incidents: detailedState.snapshot.incidents.map(serializeDetailedIncident),
      powerSections: cloneJson(detailedState.snapshot.powerSections),
      events: cloneJson(detailedState.snapshot.events),
    },
  };
}

export function serializeSimulationConfiguration(
  nativeSnapshot: NativeSimulationSnapshot,
  detailedState: SimulationState,
): string {
  return JSON.stringify(
    createSimulationConfiguration(nativeSnapshot, detailedState),
    null,
    2,
  ) + "\n";
}

export function parseSimulationConfiguration(
  text: string,
): ParsedSimulationConfiguration {
  if (typeof text !== "string" || text.length === 0) {
    throw new SimulationConfigurationError("The configuration file is empty.");
  }
  if (new TextEncoder().encode(text).length > MAX_SIMULATION_CONFIGURATION_BYTES) {
    throw new SimulationConfigurationError(
      "The configuration file exceeds the 4 MB safety limit.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new SimulationConfigurationError("The configuration file is not valid JSON.");
  }

  try {
    const root = asRecord(decoded, "configuration");
    if (root.schema !== SIMULATION_CONFIGURATION_SCHEMA) {
      throw new SimulationConfigurationError(
        "Unsupported configuration schema. Expected " +
          SIMULATION_CONFIGURATION_SCHEMA +
          ".",
      );
    }
    const name = asString(root.name, "name");
    const simulationTime = asTimestamp(root.simulationTime, "simulationTime");
    const speed = asSpeed(root.speed);
    const native = asRecord(root.nativeNetwork, "nativeNetwork");
    const detailed = asRecord(root.detailedCorridor, "detailedCorridor");

    const scenarioId = asString(
      native.scenarioId,
      "nativeNetwork.scenarioId",
      40,
    ) as NativeScenarioId;
    if (!NATIVE_SCENARIOS.some((scenario) => scenario.id === scenarioId)) {
      throw new SimulationConfigurationError(
        "nativeNetwork.scenarioId is not a supported scenario.",
      );
    }
    const scenarioName = asString(
      native.scenarioName,
      "nativeNetwork.scenarioName",
    );
    const nativeTrains = asObjectArray(
      native.trains,
      "nativeNetwork.trains",
    ) as unknown as NativeTrainState[];
    const nativeStationPassengers = native.stationPassengers === undefined
      ? undefined
      : asObjectArray(
        native.stationPassengers,
        "nativeNetwork.stationPassengers",
      ) as unknown as NativeStationPassengerState[];
    const nativeIncidents = asObjectArray(
      native.incidents,
      "nativeNetwork.incidents",
    ).map((incident, index) =>
      parseIncident<Omit<NativeIncident, "startedAt">>(
        incident,
        "nativeNetwork.incidents[" + index + "]",
      ),
    ) as NativeIncident[];

    const nativeSnapshot = createNativeSimulationSnapshotFromConfiguration({
      timestamp: simulationTime,
      speed,
      scenarioId,
      scenarioName,
      trains: nativeTrains,
      stationPassengers: nativeStationPassengers,
      incidents: nativeIncidents,
    });

    const detailedSnapshot: RailSnapshot = {
      decisionRevision: 1,
      revision: 1,
      timestamp: simulationTime,
      source: "simulation",
      scenarioName: asString(
        detailed.scenarioName,
        "detailedCorridor.scenarioName",
      ),
      trains: asObjectArray(
        detailed.trains,
        "detailedCorridor.trains",
      ) as unknown as TrainView[],
      circuits: asObjectArray(
        detailed.circuits,
        "detailedCorridor.circuits",
      ) as unknown as CircuitView[],
      drivers: asObjectArray(
        detailed.drivers,
        "detailedCorridor.drivers",
      ) as unknown as DriverResource[],
      incidents: asObjectArray(
        detailed.incidents,
        "detailedCorridor.incidents",
      ).map((incident, index) =>
        normalizeDetailedIncidentCode(
          parseIncident<Omit<DetailedIncidentWithOptionalCode, "startedAt">>(
            incident,
            "detailedCorridor.incidents[" + index + "]",
          ),
        ),
      ) as Incident[],
      powerSections: asObjectArray(
        detailed.powerSections,
        "detailedCorridor.powerSections",
      ) as unknown as PowerSection[],
      events: asObjectArray(
        detailed.events,
        "detailedCorridor.events",
      ) as unknown as RailEvent[],
    };
    assertSnapshotInvariants(detailedSnapshot);

    return {
      name,
      nativeSnapshot,
      detailedState: {
        speed,
        snapshot: detailedSnapshot,
      },
    };
  } catch (error) {
    if (error instanceof SimulationConfigurationError) throw error;
    const message = error instanceof Error ? error.message : "unknown validation error";
    throw new SimulationConfigurationError(
      "The configuration is inconsistent: " + message,
    );
  }
}
