import { useId, useMemo, useState } from "react";
import type { RailSnapshot } from "../rail/domain";
import {
  NATIVE_INTERSTATIONS,
  NATIVE_LINES,
  NATIVE_STATION_BY_CODE,
  NATIVE_STATIONS,
  type NativeLineCode,
} from "../rail/nativeNetwork";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import type { SimulatorIncidentDraft } from "../rail/simulatorIncident";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

interface SimulatorIncidentModalProps {
  snapshot: RailSnapshot;
  nativeSimulation: NativeSimulationSnapshot;
  initialLine: NativeLineCode | "ALL";
  initialTarget?: {
    targetType: "station" | "interstation";
    targetId: string;
    lineCode: NativeLineCode;
  };
  context?: "simulation" | "operations";
  onClose: () => void;
  onSubmit: (draft: SimulatorIncidentDraft) =>
    | { ok: boolean; message: string }
    | void
    | Promise<{ ok: boolean; message: string } | void>;
}

type TargetType = SimulatorIncidentDraft["targetType"];
type IncidentType = SimulatorIncidentDraft["type"];
type IncidentEffect = SimulatorIncidentDraft["effect"];

interface Option<T extends string> {
  value: T;
  label: string;
}

interface TargetOption {
  value: string;
  label: string;
  detail: string;
}

export interface StationIncidentChoice {
  value: string;
  label: string;
  detail: string;
  type: IncidentType;
  effect: IncidentEffect;
}

const TARGET_TYPES: readonly Option<TargetType>[] = [
  { value: "train", label: "Train" },
  { value: "station", label: "Station" },
  { value: "interstation", label: "Interstation" },
  { value: "power", label: "Electrical section" },
  { value: "line", label: "SCADA / line" },
];

const INCIDENT_TYPES: Record<TargetType, readonly Option<IncidentType>[]> = {
  train: [
    { value: "rolling-stock", label: "Rolling stock" },
    { value: "passenger", label: "Passenger event" },
    { value: "external", label: "External event" },
  ],
  station: [
    { value: "passenger", label: "Passenger event" },
    { value: "security", label: "Security / abandoned baggage" },
    { value: "infrastructure", label: "Infrastructure" },
    { value: "works", label: "Engineering works" },
    { value: "external", label: "External event" },
  ],
  interstation: [
    { value: "infrastructure", label: "Infrastructure" },
    { value: "works", label: "Engineering works" },
    { value: "external", label: "External event" },
  ],
  power: [
    { value: "power", label: "Power supply" },
    { value: "infrastructure", label: "Infrastructure" },
    { value: "works", label: "Engineering works" },
    { value: "external", label: "External event" },
  ],
  line: [
    { value: "communications", label: "Supervision communications" },
    { value: "infrastructure", label: "Control infrastructure" },
    { value: "external", label: "External event" },
  ],
};

const INCIDENT_EFFECTS: Record<TargetType, readonly Option<IncidentEffect>[]> = {
  train: [
    { value: "stop-train", label: "Immobilise the selected train" },
    { value: "tow-train", label: "Severe failure · towing required" },
  ],
  station: [
    { value: "station-closure", label: "Close station access" },
    { value: "station-dwell", label: "Extend station dwell" },
    { value: "abandoned-baggage", label: "Abandoned baggage · police response" },
  ],
  interstation: [
    { value: "block-interstation", label: "Block the interstation" },
    { value: "reduce-speed", label: "Apply a speed restriction" },
  ],
  power: [
    { value: "degrade-power", label: "Degrade electrical supply" },
    { value: "isolate-power", label: "Isolate electrical section" },
  ],
  line: [
    { value: "communication-degraded", label: "Degraded supervision link" },
    { value: "communication-loss", label: "Loss of supervision communications" },
  ],
};

export const STATION_INCIDENT_CHOICES: readonly StationIncidentChoice[] = [
  {
    value: "works:station-closure",
    label: "Station closure for engineering works",
    detail: "Engineering works · station closure",
    type: "works",
    effect: "station-closure",
  },
  {
    value: "security:abandoned-baggage",
    label: "Abandoned baggage",
    detail: "Security · police response",
    type: "security",
    effect: "abandoned-baggage",
  },
  {
    value: "passenger:station-dwell",
    label: "Extended dwell for passenger flow",
    detail: "Passenger event · extended station dwell",
    type: "passenger",
    effect: "station-dwell",
  },
];

const SEVERITIES: readonly Option<SimulatorIncidentDraft["severity"]>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Moderate" },
  { value: "high", label: "Major" },
  { value: "critical", label: "Critical" },
];

const PARIS_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function parisParts(timestamp: number): Record<string, string> {
  return Object.fromEntries(
    PARIS_TIME_FORMAT.formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function toParisDateTimeLocal(timestamp: number): string {
  const parts = parisParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function fromParisDateTimeLocal(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return Number.NaN;
  const requested = match.slice(1).map(Number);
  const requestedAsUtc = Date.UTC(
    requested[0],
    requested[1] - 1,
    requested[2],
    requested[3],
    requested[4],
    requested[5] ?? 0,
  );
  let timestamp = requestedAsUtc;

  // datetime-local carries no zone. Resolve it deterministically as Paris ICC time,
  // independently from the demo browser's own time zone.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = parisParts(timestamp);
    const actualAsUtc = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
      Number(actual.second),
    );
    timestamp += requestedAsUtc - actualAsUtc;
  }
  return timestamp;
}

function formatParisDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(timestamp);
}

function lineName(lineCode: string): string {
  return NATIVE_LINES.find((line) => line.code === lineCode)?.name ?? lineCode.replace("_", " ");
}

function initialLineCode(
  requested: NativeLineCode | "ALL",
  nativeSimulation: NativeSimulationSnapshot,
): NativeLineCode {
  if (requested !== "ALL") return requested;
  return nativeSimulation.trains[0]?.lineCode ?? "RER_A";
}

function lineOptionsFor(
  targetType: TargetType,
  snapshot: RailSnapshot,
  nativeSimulation: NativeSimulationSnapshot,
): readonly NativeLineCode[] {
  if (targetType === "train") {
    const available = new Set(nativeSimulation.trains.map((train) => train.lineCode));
    return NATIVE_LINES.filter((line) => available.has(line.code)).map((line) => line.code);
  }
  if (targetType === "power") {
    const available = new Set<string>(snapshot.powerSections.flatMap((section) => section.lineIds));
    return NATIVE_LINES.filter((line) => available.has(line.code)).map((line) => line.code);
  }
  return NATIVE_LINES.map((line) => line.code);
}

function targetOptionsFor(
  targetType: TargetType,
  lineCode: NativeLineCode,
  snapshot: RailSnapshot,
  nativeSimulation: NativeSimulationSnapshot,
): TargetOption[] {
  if (targetType === "train") {
    return nativeSimulation.trains
      .filter((train) => train.lineCode === lineCode)
      .map((train) => {
        const location = train.location.type === "station"
          ? NATIVE_STATION_BY_CODE.get(train.location.id)?.name ?? train.location.id
          : (() => {
              const interstation = NATIVE_INTERSTATIONS.find((item) => item.id === train.location.id);
              if (!interstation) return train.location.id;
              const from = NATIVE_STATION_BY_CODE.get(interstation.fromStationCode)?.name ?? interstation.fromStationCode;
              const to = NATIVE_STATION_BY_CODE.get(interstation.toStationCode)?.name ?? interstation.toStationCode;
              return `${from} → ${to}`;
            })();
        return {
          value: train.id,
          label: `${train.id} · mission ${train.mission}`,
          detail: `${train.status} · ${location} · ${train.passengers} passengers`,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }
  if (targetType === "station") {
    return NATIVE_STATIONS
      .filter((station) => station.lines.includes(lineCode))
      .map((station) => ({
        value: station.code,
        label: station.name,
        detail: `${station.code} · ${station.lines.map(lineName).join(", ")}`,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }
  if (targetType === "interstation") {
    return NATIVE_INTERSTATIONS
      .filter((interstation) => interstation.lineCode === lineCode)
      .map((interstation) => {
        const from = NATIVE_STATION_BY_CODE.get(interstation.fromStationCode)?.name ?? interstation.fromStationCode;
        const to = NATIVE_STATION_BY_CODE.get(interstation.toStationCode)?.name ?? interstation.toStationCode;
        return {
          value: interstation.id,
          label: `${from} — ${to}`,
          detail: interstation.id,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }
  if (targetType === "line") {
    const line = NATIVE_LINES.find((candidate) => candidate.code === lineCode);
    return line ? [{ value: lineCode, label: line.name, detail: `${line.label} · ATS, field communications and passenger-information chain` }] : [];
  }
  return snapshot.powerSections
    .filter((section) => section.lineIds.some((sectionLine) => sectionLine === lineCode))
    .map((section) => ({
      value: section.id,
      label: section.name,
      detail: `${section.id} · ${section.status} · ${section.voltage.toLocaleString("en-GB")} V`,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function defaultCopy(targetType: TargetType, effect: IncidentEffect, targetLabel: string): { title: string; summary: string } {
  const target = targetLabel || "Selected operational object";
  const copy: Record<IncidentEffect, { title: string; summary: string }> = {
    "stop-train": {
      title: `Train immobilised — ${target}`,
      summary: "The selected train must be protected and held while the operating team assesses the cause.",
    },
    "station-closure": {
      title: `Station closure for engineering works — ${target}`,
      summary: "Engineering works prevent trains from passing through or stopping at the station. Protect the scope and establish provisional services on each side.",
    },
    "station-dwell": {
      title: `Extended dwell — ${target}`,
      summary: "Passenger flow conditions require longer dwell times and will propagate delay to following services.",
    },
    "block-interstation": {
      title: `Interstation blocked — ${target}`,
      summary: "The interstation must be protected against train movements until the restriction is removed.",
    },
    "reduce-speed": {
      title: `Speed restriction — ${target}`,
      summary: "A temporary speed restriction applies through the selected interstation and affects line capacity.",
    },
    "tow-train": {
      title: `Severe train failure — ${target}`,
      summary: "The train is immobilised and requires a protected rescue and towing operation with a three-hour nominal planning duration.",
    },
    "abandoned-baggage": {
      title: `Abandoned baggage — ${target}`,
      summary: "Trains cannot pass through or stop at the protected station until explicit police clearance. Establish provisional services and passenger alternatives; nominal resolution is one hour.",
    },
    "communication-degraded": {
      title: `SCADA communications degraded — ${target}`,
      summary: "Supervision telemetry is degraded. Preserve the last trusted state and dispatch communications maintenance.",
    },
    "communication-loss": {
      title: `SCADA communications lost — ${target}`,
      summary: "The end-to-end supervision channel is unavailable. Apply the line communication procedure and maintain independent control evidence.",
    },
    "degrade-power": {
      title: `Degraded power supply — ${target}`,
      summary: "Available traction power is reduced, lowering operating performance on the supplied circuits.",
    },
    "isolate-power": {
      title: `Electrical isolation — ${target}`,
      summary: "The selected electrical section is isolated and supplied train movements must be stopped.",
    },
  };
  return copy[effect] ?? {
    title: `${targetType} incident — ${target}`,
    summary: "The incident requires an operational assessment.",
  };
}

export function incidentImpactCopy(effect: IncidentEffect, speedLimitKmh = "30"): string {
  switch (effect) {
    case "stop-train":
      return "Only the selected train is immobilised; its delay and downstream service impact will accumulate.";
    case "tow-train":
      return "The selected train remains protected and stopped while a three-hour nominal towing operation is prepared and executed.";
    case "abandoned-baggage":
      return "Trains cannot pass through or stop at the protected station until explicit police clearance. Establish provisional services and passenger alternatives; plan for one hour nominally.";
    case "communication-degraded":
      return "The line remains supervised with degraded telemetry while maintenance is dispatched and independent evidence is maintained.";
    case "communication-loss":
      return "The line supervision chain is unavailable; maintenance dispatch and protected local control are required before restoration.";
    case "station-closure":
      return "Engineering works prevent trains from passing through or stopping at this station. Establish provisional services on each side of the closure.";
    case "station-dwell":
      return "Every call at this station receives additional dwell, propagating delay through the route.";
    case "block-interstation":
      return "The selected interstation is blocked and approaching trains are held at a protected location.";
    case "reduce-speed":
      return `Trains crossing this interstation are capped at ${speedLimitKmh || "the selected"} km/h.`;
    case "degrade-power":
      return "Traction performance is reduced on every circuit supplied by this electrical section.";
    case "isolate-power":
      return "Every supplied circuit loses traction power and affected trains are stopped.";
  }
}

export function SimulatorIncidentModal({
  snapshot,
  nativeSimulation,
  initialLine,
  initialTarget,
  context = "simulation",
  onClose,
  onSubmit,
}: SimulatorIncidentModalProps) {
  const formId = useId();
  const initialTargetType = initialTarget?.targetType ?? "train";
  const [targetType, setTargetType] = useState<TargetType>(initialTargetType);
  const [lineCode, setLineCode] = useState<NativeLineCode>(() =>
    initialTarget?.lineCode ?? initialLineCode(initialLine, nativeSimulation));
  const [targetId, setTargetId] = useState(initialTarget?.targetId ?? "");
  const initialStationChoice = STATION_INCIDENT_CHOICES[0];
  const [type, setType] = useState<IncidentType>(initialTargetType === "station"
    ? initialStationChoice.type
    : INCIDENT_TYPES[initialTargetType][0].value);
  const [severity, setSeverity] = useState<SimulatorIncidentDraft["severity"]>("high");
  const [effect, setEffect] = useState<IncidentEffect>(initialTargetType === "station"
    ? initialStationChoice.effect
    : INCIDENT_EFFECTS[initialTargetType][0].value);
  const [occurrenceValue, setOccurrenceValue] = useState(() => toParisDateTimeLocal(nativeSimulation.timestamp));
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [speedLimitKmh, setSpeedLimitKmh] = useState("30");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const availableLines = useMemo(
    () => lineOptionsFor(targetType, snapshot, nativeSimulation),
    [nativeSimulation, snapshot, targetType],
  );
  const effectiveLine = availableLines.includes(lineCode) ? lineCode : availableLines[0] ?? lineCode;
  const targetOptions = useMemo(
    () => targetOptionsFor(targetType, effectiveLine, snapshot, nativeSimulation),
    [effectiveLine, nativeSimulation, snapshot, targetType],
  );
  const effectiveTargetId = targetOptions.some((option) => option.value === targetId)
    ? targetId
    : targetOptions[0]?.value ?? "";
  const selectedTarget = targetOptions.find((option) => option.value === effectiveTargetId);
  const selectedStationChoice = targetType === "station"
    ? STATION_INCIDENT_CHOICES.find((choice) => choice.type === type && choice.effect === effect) ?? STATION_INCIDENT_CHOICES[0]
    : null;
  const generatedCopy = defaultCopy(targetType, effect, selectedTarget?.label ?? "");
  const currentSimulationTime = targetType === "power" ? snapshot.timestamp : nativeSimulation.timestamp;
  const occurrenceTime = fromParisDateTimeLocal(occurrenceValue);
  const isPlanned = Number.isFinite(occurrenceTime) && occurrenceTime > currentSimulationTime;

  const updateTargetType = (nextTargetType: TargetType) => {
    const lines = lineOptionsFor(nextTargetType, snapshot, nativeSimulation);
    const nextLine = lines.includes(lineCode) ? lineCode : lines[0] ?? lineCode;
    const nextStationChoice = STATION_INCIDENT_CHOICES[0];
    const nextEffect = nextTargetType === "station"
      ? nextStationChoice.effect
      : INCIDENT_EFFECTS[nextTargetType][0].value;
    const nextTargets = targetOptionsFor(nextTargetType, nextLine, snapshot, nativeSimulation);
    const copy = defaultCopy(nextTargetType, nextEffect, nextTargets[0]?.label ?? "");
    setTargetType(nextTargetType);
    setLineCode(nextLine);
    setTargetId(nextTargets[0]?.value ?? "");
    setType(nextTargetType === "station"
      ? nextStationChoice.type
      : INCIDENT_TYPES[nextTargetType][0].value);
    setEffect(nextEffect);
    setOccurrenceValue(toParisDateTimeLocal(nextTargetType === "power" ? snapshot.timestamp : nativeSimulation.timestamp));
    setTitle(copy.title);
    setSummary(copy.summary);
    setError("");
  };

  const updateLine = (nextLine: NativeLineCode) => {
    const nextTargets = targetOptionsFor(targetType, nextLine, snapshot, nativeSimulation);
    const copy = defaultCopy(targetType, effect, nextTargets[0]?.label ?? "");
    setLineCode(nextLine);
    setTargetId(nextTargets[0]?.value ?? "");
    setTitle(copy.title);
    setSummary(copy.summary);
    setError("");
  };

  const updateTarget = (nextTargetId: string) => {
    const nextTarget = targetOptions.find((option) => option.value === nextTargetId);
    const copy = defaultCopy(targetType, effect, nextTarget?.label ?? "");
    setTargetId(nextTargetId);
    setTitle(copy.title);
    setSummary(copy.summary);
    setError("");
  };

  const updateStationIncident = (value: string) => {
    const choice = STATION_INCIDENT_CHOICES.find((candidate) => candidate.value === value);
    if (!choice) return;
    const copy = defaultCopy("station", choice.effect, selectedTarget?.label ?? "");
    setType(choice.type);
    setEffect(choice.effect);
    setTitle(copy.title);
    setSummary(copy.summary);
    setError("");
  };

  const updateEffect = (nextEffect: IncidentEffect) => {
    const copy = defaultCopy(targetType, nextEffect, selectedTarget?.label ?? "");
    setEffect(nextEffect);
    if (nextEffect === "tow-train") setType("rolling-stock");
    if (nextEffect === "station-closure") setType("works");
    if (nextEffect === "station-dwell") setType("passenger");
    if (nextEffect === "abandoned-baggage") setType("security");
    if (nextEffect === "communication-degraded" || nextEffect === "communication-loss") setType("communications");
    setTitle(copy.title);
    setSummary(copy.summary);
    setError("");
  };

  const submit = async () => {
    if (submitting) return;
    const resolvedTitle = title.trim() || generatedCopy.title;
    const resolvedSummary = summary.trim() || generatedCopy.summary;
    const parsedSpeedLimit = Number(speedLimitKmh);
    if (!availableLines.length) {
      setError(`No ${targetType} object is available in the current operational state.`);
      return;
    }
    if (!effectiveTargetId || !selectedTarget) {
      setError(`Select an existing ${targetType} object before creating the incident.`);
      return;
    }
    if (!Number.isFinite(occurrenceTime)) {
      setError("Enter a valid occurrence date and time in Paris operational time.");
      return;
    }
    if (effect === "reduce-speed" && (!Number.isFinite(parsedSpeedLimit) || parsedSpeedLimit < 5 || parsedSpeedLimit > 90)) {
      setError("The speed restriction must be between 5 and 90 km/h.");
      return;
    }
    if (!resolvedTitle || !resolvedSummary) {
      setError("Provide a title and an operational summary.");
      return;
    }

    const draft: SimulatorIncidentDraft = {
      targetType,
      targetId: effectiveTargetId,
      lineCode: effectiveLine,
      type,
      severity,
      effect,
      occurrenceTime,
      title: resolvedTitle,
      summary: resolvedSummary,
      ...(effect === "reduce-speed" ? { speedLimitKmh: parsedSpeedLimit } : {}),
    };

    setSubmitting(true);
    try {
      const result = await onSubmit(draft);
      if (result && !result.ok) {
        setError(result.message);
        return;
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The incident could not be created.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      contentId="text-text-modal-simulator-incident"
      title={context === "operations" ? "Declare an incident" : "Add a simulated incident"}
      eyebrow={context === "operations" ? "NETWORK OPERATIONS" : "SIMULATION CONTROL"}
      onClose={onClose}
      wide
      footer={(
        <>
          <span className="footer-note"><Icon name="shield" size={14} /> {context === "operations" ? "Recorded in the operational state" : "Local deterministic simulation only"}</span>
          <button type="button" className="button button--secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            type="submit"
            form={formId}
            className="button button--danger"
            data-testid="sim-incident-submit"
            disabled={submitting || !selectedTarget || !Number.isFinite(occurrenceTime)}
          >
            <Icon name={isPlanned ? "calendar" : "alert"} size={15} />
            {submitting ? "Saving…" : isPlanned ? "Schedule incident" : "Activate incident"}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className="sim-incident-form"
        data-testid="sim-incident-modal"
        data-incident-type={type}
        data-incident-effect={effect}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <section
          className="sim-incident-clock"
          id="text-text-modal-simulator-incident-clock"
          aria-label={context === "operations" ? "Operational time context" : "Simulation time context"}
        >
          <span><Icon name="clock" size={17} /></span>
          <div>
            <small>{context === "operations" ? "CURRENT OPERATIONAL CLOCK" : "CURRENT SIMULATION CLOCK"} · EUROPE/PARIS</small>
            <strong>{formatParisDateTime(currentSimulationTime)}</strong>
          </div>
          <b className={isPlanned ? "sim-incident-clock__planned" : "sim-incident-clock__active"}>
            {isPlanned ? "PLANNED" : "IMMEDIATE"}
          </b>
        </section>

        <fieldset className="sim-incident-target-types" id="text-text-modal-simulator-incident-target-type" data-testid="sim-incident-target-type">
          <legend>Affected object</legend>
          {TARGET_TYPES.map((option) => (
            <label key={option.value} className={targetType === option.value ? "active" : ""}>
              <input
                type="radio"
                name={`${formId}-target-type`}
                value={option.value}
                checked={targetType === option.value}
                data-testid={`sim-incident-target-type-${option.value}`}
                onChange={() => updateTargetType(option.value)}
              />
              <Icon
                name={option.value === "train" ? "train" : option.value === "power" ? "bolt" : option.value === "station" ? "pin" : "network"}
                size={17}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>

        <div className="sim-incident-grid" id="text-text-modal-simulator-incident-form-fields">
          <label>
            <span>Line</span>
            <select data-testid="sim-incident-line" value={effectiveLine} onChange={(event) => updateLine(event.target.value as NativeLineCode)}>
              {availableLines.map((code) => <option key={code} value={code}>{lineName(code)}</option>)}
            </select>
          </label>
          <label>
            <span>{context === "operations" ? "Affected network object" : "Actual simulation object"}</span>
            <select
              value={effectiveTargetId}
              data-testid="sim-incident-target"
              required
              aria-invalid={!selectedTarget}
              onChange={(event) => updateTarget(event.target.value)}
            >
              {!targetOptions.length && <option value="">No object available on this line</option>}
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {selectedTarget && <small>{selectedTarget.detail}</small>}
          </label>
          {targetType === "station" ? (
            <label id="text-text-modal-simulator-station-incident-choice">
              <span>Station incident</span>
              <select
                data-testid="sim-incident-station-choice"
                value={selectedStationChoice?.value}
                onChange={(event) => updateStationIncident(event.target.value)}
              >
                {STATION_INCIDENT_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
              {selectedStationChoice && <small>{selectedStationChoice.detail}</small>}
            </label>
          ) : (
            <label>
              <span>Incident category</span>
              <select data-testid="sim-incident-category" value={type} onChange={(event) => setType(event.target.value as IncidentType)}>
                {INCIDENT_TYPES[targetType].map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Operational severity</span>
            <select value={severity} onChange={(event) => setSeverity(event.target.value as SimulatorIncidentDraft["severity"])}>
              {SEVERITIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {targetType !== "station" && (
            <label>
              <span>{context === "operations" ? "Operational impact" : "Simulation impact"}</span>
              <select data-testid="sim-incident-effect" value={effect} onChange={(event) => updateEffect(event.target.value as IncidentEffect)}>
                {INCIDENT_EFFECTS[targetType].map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          )}
          {effect === "reduce-speed" && (
            <label>
              <span>Restricted speed (km/h)</span>
              <input
                type="number"
                min="5"
                max="90"
                step="5"
                value={speedLimitKmh}
                required
                onChange={(event) => setSpeedLimitKmh(event.target.value)}
              />
            </label>
          )}
          <label className={effect === "reduce-speed" ? "" : "sim-incident-grid__span-two"}>
            <span>Occurrence time · Europe/Paris</span>
            <input
              type="datetime-local"
              step="1"
              value={occurrenceValue}
              min={toParisDateTimeLocal(currentSimulationTime)}
              data-testid="sim-incident-occurrence"
              required
              aria-describedby={`${formId}-occurrence-help`}
              aria-invalid={!Number.isFinite(occurrenceTime)}
              onChange={(event) => {
                setOccurrenceValue(event.target.value);
                setError("");
              }}
            />
            <small id={`${formId}-occurrence-help`}>
              {isPlanned
                ? `Will activate automatically at ${formatParisDateTime(occurrenceTime)}.`
                : context === "operations"
                  ? "Will affect the operational state immediately after confirmation."
                  : "Will affect the simulation immediately after confirmation."}
            </small>
          </label>
          <label className="sim-incident-grid__span-two">
            <span>Incident title</span>
            <input
              type="text"
              value={title || generatedCopy.title}
              maxLength={120}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="sim-incident-grid__span-two">
            <span>Operational summary</span>
            <textarea
              rows={3}
              value={summary || generatedCopy.summary}
              maxLength={500}
              required
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
        </div>

        <section id="text-text-modal-simulator-incident-impact-preview" className={`sim-incident-preview sim-incident-preview--${severity}`} aria-label={context === "operations" ? "Operational impact preview" : "Simulated impact preview"}>
          <span><Icon name={targetType === "power" ? "bolt" : "activity"} size={19} /></span>
          <div>
            <small>{isPlanned ? "SCHEDULED IMPACT" : "IMMEDIATE IMPACT"} · {lineName(effectiveLine)}</small>
            <strong>{selectedTarget?.label ?? "No target selected"}</strong>
            <p>{incidentImpactCopy(effect, speedLimitKmh)}</p>
          </div>
        </section>

        <div className="sim-incident-error" id="text-text-modal-simulator-incident-error" role="alert" aria-live="assertive" aria-atomic="true">
          {error && <><Icon name="alert" size={15} /><span>{error}</span></>}
        </div>
      </form>
    </Modal>
  );
}
