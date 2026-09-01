export type LineId = "RER_A" | "RER_B" | "M13" | "M14";
export type Direction = 1 | -1;
export type DataQuality = "simulated" | "live" | "interpolated" | "stale";
export type PassengerFeedMode = "simulation" | "prim-replay" | "prim-live";
export type PassengerFeedStatus = "idle" | "loading" | "ready" | "partial" | "error";
export type TrainStatus = "running" | "dwelling" | "held" | "stopped";
export type CircuitState = "free" | "reserved" | "occupied" | "blocked";
export type CircuitClosureReason = "works" | "incident";
export type Severity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "planned" | "active" | "acknowledged" | "resolved";
export type PowerStatus = "energized" | "degraded" | "isolated";

export interface IncidentTarget {
  type: "train" | "station" | "interstation" | "power";
  id: string;
}

export type IncidentEffect =
  | "stop-train"
  | "station-closure"
  | "station-dwell"
  | "block-interstation"
  | "reduce-speed"
  | "degrade-power"
  | "isolate-power";

export interface LineDefinition {
  id: LineId;
  shortName: string;
  name: string;
  color: string;
  textColor: string;
  axis: string;
  operator: string;
  controlSystem: string;
  rollingStock: string;
  powerSupply: string;
  lineLengthKm: number;
  stationCount: number;
  termini: string[];
  simulatedCorridor: string;
  wikipediaUrl: string;
  stations: string[];
  y: number;
}

export interface TrackCircuitDefinition {
  id: string;
  label: string;
  lineId: LineId;
  direction: Direction;
  segmentIndex: number;
  fromStation: string;
  toStation: string;
  x1: number;
  x2: number;
  y: number;
  lengthMeters: number;
  speedLimitKmh: number;
  electricalSectionId: string;
}

export interface CircuitClosureMetadata {
  reason: CircuitClosureReason;
  note: string | null;
  reference: string | null;
  closedAt: number;
}

export interface CircuitView extends TrackCircuitDefinition {
  state: CircuitState;
  occupiedBy: string | null;
  circulationId: string | null;
  reservedBy: string | null;
  closure: CircuitClosureMetadata | null;
}

export interface TrainView {
  id: string;
  circulationId: string;
  lineId: LineId;
  mission: string;
  origin: string;
  destination: string;
  driverId: string | null;
  direction: Direction;
  routeIndex: number;
  circuitId: string;
  progress: number;
  speedKmh: number;
  delaySeconds: number;
  status: TrainStatus;
  nextStop: string;
  passengers: number;
  holdTicks: number;
  quality: DataQuality;
}

export interface DriverResource {
  id: string;
  depot: string;
  qualifications: LineId[];
  shiftStart: string;
  shiftEnd: string;
  dutyMinutes: number;
  status: "assigned" | "reserve" | "relief-risk" | "unavailable";
  assignedTrainId: string | null;
}

export interface Incident {
  id: string;
  incidentCode: string;
  title: string;
  type: "infrastructure" | "passenger" | "rolling-stock" | "staff" | "power" | "works" | "external";
  severity: Severity;
  status: IncidentStatus;
  lineIds: LineId[];
  location: string;
  startedAt: number;
  blockedCircuitIds: string[];
  impactedTrainIds: string[];
  owner: string;
  summary: string;
  actions: string[];
  /** Structured simulator metadata. Legacy/imported incidents may omit it. */
  target?: IncidentTarget;
  effect?: IncidentEffect;
  /** Simulation-clock timestamp at which a planned incident became active. */
  activatedAt?: number;
}

export interface NewIncidentInput {
  type: "infrastructure" | "passenger" | "rolling-stock" | "power";
  severity: Severity;
  lineId: LineId;
  location: string;
  summary: string;
}

export interface PowerSection {
  id: string;
  name: string;
  lineIds: LineId[];
  nominalVoltage: number;
  voltage: number;
  currentAmps: number;
  loadPercent: number;
  status: PowerStatus;
  substation: string;
  circuitIds: string[];
  updatedAt: number;
}

export interface RailEvent {
  id: string;
  timestamp: number;
  kind: "movement" | "incident" | "regulation" | "power" | "planning" | "circuit";
  title: string;
  detail: string;
  severity: Severity;
}

export interface PrimPassengerObservation {
  lineId: LineId;
  lineRef: string;
  journeyRef: string;
  vehicleJourneyName: string;
  directionName: string;
  destinationName: string;
  stopPointRef: string;
  stopPointName: string;
  aimedArrivalTime: string | null;
  expectedArrivalTime: string | null;
  expectedDepartureTime: string | null;
  departureStatus: string | null;
  vehicleAtStop: boolean | null;
  delaySeconds: number | null;
  observedAt: string;
  quality: Extract<DataQuality, "live" | "simulated" | "stale">;
}

export interface PassengerFeedLineStatus {
  lineId: LineId;
  lineRef: string;
  status: "ready" | "error";
  observationCount: number;
  responseTimestamp: string | null;
  error: string | null;
}

export interface PassengerFeedSnapshot {
  mode: PassengerFeedMode;
  status: PassengerFeedStatus;
  provider: "Île-de-France Mobilités PRIM";
  contract: "SIRI Lite Estimated Timetable";
  requestedAt: string | null;
  receivedAt: string | null;
  endpoint: string | null;
  observations: PrimPassengerObservation[];
  lines: PassengerFeedLineStatus[];
  limitations: string[];
  error: string | null;
}

export interface RailSnapshot {
  /**
   * Monotonic version of operator-controlled decision state. Unlike revision,
   * this value does not change when the deterministic telemetry clock ticks.
   */
  decisionRevision: number;
  revision: number;
  timestamp: number;
  source: "simulation" | "live";
  scenarioName: string;
  trains: TrainView[];
  circuits: CircuitView[];
  drivers: DriverResource[];
  incidents: Incident[];
  powerSections: PowerSection[];
  events: RailEvent[];
  passengerFeed?: PassengerFeedSnapshot;
}

export interface SimulationState {
  snapshot: RailSnapshot;
  speed: 0 | 1 | 2 | 4;
}

export type CircuitClosureRejectionReason =
  | "not_found"
  | "occupied"
  | "blocked"
  | "already_closed"
  | "already_open"
  | "invalid_note"
  | "invalid_reference"
  | "live_forbidden";

export type CircuitClosureResult =
  | {
      ok: true;
      action: "close" | "reopen";
      outcome: "closed" | "reopened";
      circuitId: string;
      message: string;
      nextState: SimulationState;
    }
  | {
      ok: false;
      action: "close" | "reopen";
      reason: CircuitClosureRejectionReason;
      circuitId: string;
      message: string;
      nextState: SimulationState;
    };

export interface EntitySelection {
  type: "train" | "circuit" | "driver" | "incident" | "power" | "source";
  id: string;
}

export interface RailDataProvider {
  readonly mode: "simulation" | "live";
  loadSnapshot(): Promise<RailSnapshot>;
  subscribe(onSnapshot: (snapshot: RailSnapshot) => void): () => void;
}
