import type { NativeIncidentSeverity, NativeIncidentType } from "./nativeSimulation";

export type SimulatorIncidentTargetType = "train" | "station" | "interstation" | "power" | "line";

export type SimulatorIncidentEffect =
  | "stop-train"
  | "station-closure"
  | "station-dwell"
  | "block-interstation"
  | "reduce-speed"
  | "degrade-power"
  | "isolate-power"
  | "communication-degraded"
  | "communication-loss"
  | "abandoned-baggage"
  | "tow-train";

export interface SimulatorIncidentDraft {
  targetType: SimulatorIncidentTargetType;
  targetId: string;
  lineCode: string;
  type: NativeIncidentType;
  severity: NativeIncidentSeverity;
  effect: SimulatorIncidentEffect;
  occurrenceTime: number;
  title: string;
  summary: string;
  speedLimitKmh?: number;
}

export interface SimulatorIncidentCreationResult {
  ok: boolean;
  message: string;
  incidentId?: string;
  status?: "planned" | "active";
}
