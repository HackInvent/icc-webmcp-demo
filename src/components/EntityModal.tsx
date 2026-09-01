import { useEffect, useState } from "react";
import { detailPath, navigate } from "../navigation";
import type { CircuitClosureReason, CircuitView, EntitySelection, IncidentStatus, LineId, NewIncidentInput, PassengerFeedMode, RailSnapshot, Severity } from "../rail/domain";
import { MAX_CIRCUIT_CLOSURE_NOTE_LENGTH } from "../rail/simulation";
import { lineDefinition } from "../rail/topology";
import { formatDelay, formatTime, incidentStatusLabel, lineLabel, severityLabel, severityTone, trainStatusLabel } from "../utils";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { StatusPill } from "./StatusPill";

interface EntityModalProps {
  selection: EntitySelection;
  snapshot: RailSnapshot;
  onClose: () => void;
  onIncidentStatus: (id: string, status: IncidentStatus) => void;
  onPower: (id: string, status: "energized" | "isolated") => void;
  onRegulate: (trainId: string, action: "priority" | "hold" | "turnback") => void;
  onCreateIncident: (input: NewIncidentInput) => void;
  onCloseCircuit: (circuitId: string, reason: CircuitClosureReason, note: string) => void;
  onReopenCircuit: (circuitId: string) => void;
  onPassengerFeedMode: (mode: PassengerFeedMode) => void;
  onRefreshPassengerFeed: () => void;
}

function formatFeedTimestamp(value: string | null | undefined): string {
  if (!value) return "Not refreshed";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

interface CircuitClosureControlProps {
  circuit: CircuitView;
  onCloseCircuit: (circuitId: string, reason: CircuitClosureReason, note: string) => void;
  onReopenCircuit: (circuitId: string) => void;
  testIdPrefix?: "circuit" | "circuit-detail";
}

export function CircuitClosureControl({
  circuit,
  onCloseCircuit,
  onReopenCircuit,
  testIdPrefix = "circuit",
}: CircuitClosureControlProps) {
  const [reason, setReason] = useState<CircuitClosureReason>("works");
  const [note, setNote] = useState("");
  const occupied = circuit.state === "occupied" || Boolean(circuit.occupiedBy);
  const closure = circuit.closure;
  const scenarioBlocked = circuit.state === "blocked" && !closure;
  const reserved = circuit.state === "reserved" || circuit.reservedBy !== null;
  const closeDisabled = occupied || scenarioBlocked || reserved;

  useEffect(() => {
    setReason("works");
    setNote("");
  }, [circuit.id, closure !== null]);

  if (closure) {
    return (
      <section id={`text-text-${testIdPrefix}-closure-control`} className="circuit-closure circuit-closure--active" aria-label="Manual track circuit closure">
        <header>
          <span><Icon name="alert" size={17} /></span>
          <div>
            <small>MANUAL CLOSURE · OPERATOR CONTROL</small>
            <strong>Closed for {closure.reason}</strong>
          </div>
          <StatusPill tone="danger">Closed</StatusPill>
        </header>
        <dl>
          <div><dt>Reason</dt><dd>{closure.reason === "works" ? "Engineering works" : "Operational incident"}</dd></div>
          <div><dt>Closed at</dt><dd>{formatTime(closure.closedAt)}</dd></div>
          <div><dt>Operator note</dt><dd>{closure.note || "No note supplied"}</dd></div>
          {closure.reference && <div><dt>Reference</dt><dd>{closure.reference}</dd></div>}
        </dl>
        <button
          type="button"
          className="button button--primary button--block"
          data-testid={`${testIdPrefix}-reopen-track-circuit`}
          onClick={() => onReopenCircuit(circuit.id)}
        >
          <Icon name="reset" size={15} /> Reopen track circuit
        </button>
        <p>Reopening updates the current operational state and audit trail.</p>
      </section>
    );
  }

  return (
    <section id={`text-text-${testIdPrefix}-closure-control`} className="circuit-closure" aria-label="Close track circuit">
      <header>
        <span><Icon name="shield" size={17} /></span>
        <div>
          <small>LOCAL COMMAND</small>
          <strong>Close this track circuit</strong>
        </div>
        <StatusPill tone="purple">Operator approval</StatusPill>
      </header>
      <fieldset>
        <legend>Closure reason</legend>
        <label className={reason === "works" ? "active" : ""}>
          <input
            type="radio"
            name={`${testIdPrefix}-closure-reason`}
            value="works"
            checked={reason === "works"}
            data-testid={`${testIdPrefix}-closure-reason-works`}
            onChange={() => setReason("works")}
          />
          <span><strong>Works</strong><small>Planned engineering possession</small></span>
        </label>
        <label className={reason === "incident" ? "active" : ""}>
          <input
            type="radio"
            name={`${testIdPrefix}-closure-reason`}
            value="incident"
            checked={reason === "incident"}
            data-testid={`${testIdPrefix}-closure-reason-incident`}
            onChange={() => setReason("incident")}
          />
          <span><strong>Incident</strong><small>Unplanned operating restriction</small></span>
        </label>
      </fieldset>
      <label className="circuit-closure__note">
        <span>Operator note <em>optional</em></span>
        <textarea
          value={note}
          rows={2}
          maxLength={MAX_CIRCUIT_CLOSURE_NOTE_LENGTH}
          data-testid={`${testIdPrefix}-closure-note`}
          placeholder="Short operational context"
          onChange={(event) => setNote(event.target.value)}
        />
        <small>{note.length}/{MAX_CIRCUIT_CLOSURE_NOTE_LENGTH}</small>
      </label>
      <button
        type="button"
        className="button button--danger button--block"
        disabled={closeDisabled}
        aria-describedby={closeDisabled ? `${testIdPrefix}-closure-blocked` : undefined}
        data-testid={`${testIdPrefix}-close-track-circuit`}
        onClick={() => onCloseCircuit(circuit.id, reason, note.trim())}
      >
        <Icon name="alert" size={15} /> Close track circuit
      </button>
      {occupied ? (
        <p id={`${testIdPrefix}-closure-blocked`} className="circuit-closure__blocked">
          <Icon name="train" size={14} /> Closure is disabled while {circuit.occupiedBy ?? "a train"} occupies this circuit.
        </p>
      ) : scenarioBlocked ? (
        <p id={`${testIdPrefix}-closure-blocked`} className="circuit-closure__blocked">
          <Icon name="alert" size={14} /> This circuit is already blocked in the current operational state. Resolve the incident or power isolation first.
        </p>
      ) : reserved ? (
        <p id={`${testIdPrefix}-closure-blocked`} className="circuit-closure__blocked">
          <Icon name="clock" size={14} /> This circuit is reserved{circuit.reservedBy ? ` for ${circuit.reservedBy}` : ""}. Wait until the route is released.
        </p>
      ) : (
        <p>No live signalling command is sent. Reopening remains available from this record.</p>
      )}
    </section>
  );
}

function openFull(selection: EntitySelection, onClose: () => void) {
  if (selection.type === "source") return;
  onClose();
  navigate(detailPath(selection.type, selection.id));
}

function NewIncidentModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: NewIncidentInput) => void;
}) {
  const [type, setType] = useState<NewIncidentInput["type"]>("infrastructure");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [lineId, setLineId] = useState<LineId>("RER_A");
  const [location, setLocation] = useState("Auber — track 2");
  const [summary, setSummary] = useState(
    "Report requires assessment. Field verification requested.",
  );
  const valid = location.trim().length > 0 && summary.trim().length > 0;

  return (
    <Modal
      contentId="text-text-modal-report-incident"
      title="Report an incident"
      eyebrow="OPERATIONS LOG"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!valid}
            onClick={() => onCreate({ type, severity, lineId, location, summary })}
          >
            Add to operations log
          </button>
        </>
      )}
    >
      <div className="form-grid" id="text-text-modal-report-incident-form">
        <label>
          <span>Category</span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as NewIncidentInput["type"])}
          >
            <option value="infrastructure">Infrastructure</option>
            <option value="passenger">Passenger</option>
            <option value="rolling-stock">Rolling stock</option>
            <option value="power">Power</option>
          </select>
        </label>
        <label>
          <span>Severity</span>
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value as Severity)}
          >
            <option value="low">Minor</option>
            <option value="medium">Moderate</option>
            <option value="high">Major</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="form-grid__full">
          <span>Line</span>
          <select value={lineId} onChange={(event) => setLineId(event.target.value as LineId)}>
            <option value="RER_A">RER A</option>
            <option value="RER_B">RER B</option>
            <option value="M13">Metro 13</option>
            <option value="M14">Metro 14</option>
          </select>
        </label>
        <label className="form-grid__full">
          <span>Location</span>
          <input
            value={location}
            maxLength={120}
            required
            onChange={(event) => setLocation(event.target.value)}
          />
        </label>
        <label className="form-grid__full">
          <span>Operational description</span>
          <textarea
            value={summary}
            maxLength={500}
            required
            rows={4}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
      </div>
      <div className="modal-note" id="text-text-modal-report-incident-locality-notice">
        <Icon name="shield" size={18}/>
        <p>This report remains in the operational workspace and is not sent to an external operator system.</p>
      </div>
    </Modal>
  );
}

export function EntityModal({ selection, snapshot, onClose, onIncidentStatus, onPower, onRegulate, onCreateIncident, onCloseCircuit, onReopenCircuit, onPassengerFeedMode, onRefreshPassengerFeed }: EntityModalProps) {
  if (selection.type === "source") {
    const feed = snapshot.passengerFeed;
    const activeMode = feed?.mode ?? "simulation";
    return (
      <Modal
        contentId="text-text-modal-data-source"
        title="Data source"
        eyebrow="OPERATIONAL CONNECTOR"
        onClose={onClose}
        footer={<><span className="footer-note"><Icon name="shield" size={15}/> Read-only passenger connector</span><button type="button" className="button button--secondary" disabled={feed?.status === "loading"} onClick={onRefreshPassengerFeed}><Icon name="reset" size={15}/> {feed?.status === "loading" ? "Refreshing…" : "Refresh source"}</button></>}
      >
        <div className="source-options" id="text-text-modal-data-source-options">
          <button type="button" className={`source-option${activeMode === "simulation" ? " source-option--active" : ""}`} onClick={() => onPassengerFeedMode("simulation")}><span className="source-option__icon"><Icon name="play" size={20}/></span><span><strong>ICC operational state</strong><small>Traffic, CDV, incidents, power and D-1 resources · passenger feed disabled</small></span><StatusPill tone={activeMode === "simulation" ? "ok" : "neutral"}>{activeMode === "simulation" ? "Active" : "Available"}</StatusPill></button>
          <button type="button" className={`source-option${activeMode === "prim-replay" ? " source-option--active" : ""}`} onClick={() => onPassengerFeedMode("prim-replay")}><span className="source-option__icon"><Icon name="activity" size={20}/></span><span><strong>PRIM contract replay</strong><small>Offline fixture through the production SIRI Lite parser · estimated values</small></span><StatusPill tone={activeMode === "prim-replay" ? "ok" : "neutral"}>{activeMode === "prim-replay" ? "Active" : "Available"}</StatusPill></button>
          <button type="button" className={`source-option${activeMode === "prim-live" ? " source-option--active" : ""}`} onClick={() => onPassengerFeedMode("prim-live")}><span className="source-option__icon"><Icon name="radio" size={20}/></span><span><strong>IDFM PRIM live</strong><small>Authenticated server proxy · four official line references · read-only</small></span><StatusPill tone={activeMode === "prim-live" && feed?.status === "ready" ? "ok" : activeMode === "prim-live" && feed?.status === "error" ? "danger" : "neutral"}>{activeMode === "prim-live" ? feed?.status ?? "loading" : "Requires server key"}</StatusPill></button>
        </div>
        {feed && activeMode !== "simulation" && (
          <div className="source-contract" id="text-text-modal-data-source-contract">
            <header><span><strong>{feed.provider}</strong><small>{feed.contract}</small></span><span><strong>{feed.observations.length}</strong><small>estimated calls · {formatFeedTimestamp(feed.receivedAt)}</small></span></header>
            <div>{feed.lines.map((line) => <span key={line.lineId}><b>{line.lineId.replace("_", " ")}</b><code>{line.lineRef}</code><StatusPill tone={line.status === "ready" ? "ok" : "danger"}>{line.status === "ready" ? `${line.observationCount} calls` : "unavailable"}</StatusPill></span>)}</div>
          </div>
        )}
        <div id="text-text-modal-data-source-provenance" className={`modal-note${feed?.error ? " modal-note--warning" : ""}`}><Icon name="shield" size={18}/><p>{feed?.error ?? "PRIM observations remain a separate read-only evidence layer. Every layer keeps its provenance visible to the operator and agent."}</p></div>
      </Modal>
    );
  }

  if (selection.type === "incident" && selection.id === "NEW") {
    return <NewIncidentModal onClose={onClose} onCreate={onCreateIncident} />;
  }

  const train = selection.type === "train" ? snapshot.trains.find((candidate) => candidate.id === selection.id) : undefined;
  if (train) {
    const circuit = snapshot.circuits.find((candidate) => candidate.id === train.circuitId);
    const line = lineDefinition(train.lineId);
    return (
      <Modal contentId="text-text-modal-train" title={train.circulationId} eyebrow={`${line.name} · ${train.id}`} onClose={onClose} footer={<><span className="footer-note">Latest position · rev. {snapshot.revision}</span><button type="button" className="button button--secondary" onClick={() => openFull(selection, onClose)}>Open full record <Icon name="external" size={15}/></button></>} wide>
        <div className="modal-hero-row" id="text-text-modal-train-summary"><div className="modal-line-badge" style={{ background: line.color, color: line.textColor }}>{line.shortName}</div><div><span>{train.origin} → {train.destination}</span><strong>Next stop · {train.nextStop}</strong></div><StatusPill tone={train.status === "running" ? "ok" : "warning"}>{trainStatusLabel(train.status)}</StatusPill><b className={train.delaySeconds >= 300 ? "delay delay--high" : "delay"}>{formatDelay(train.delaySeconds)}</b></div>
        <div className="modal-stats" id="text-text-modal-train-statistics"><div><span>Current track circuit</span><strong>{train.circuitId}</strong><small>Discrete occupied object</small></div><div><span>Detection state</span><strong>{circuit?.state ?? "unknown"}</strong><small>Released only on the next object transition</small></div><div><span>Driver</span><strong>{train.driverId ?? "Automatic"}</strong><small>{train.driverId ? "Pseudonymized token" : "Automatic operation"}</small></div><div><span>Load</span><strong>{train.passengers} passengers</strong><small>Operational estimate</small></div></div>
        <div className="track-occupation-banner" id="text-text-modal-train-occupation"><i style={{ background: line.color }}/><span><strong>{train.circuitId} occupied</strong><small>No interpolated position inside the track circuit</small></span></div>
        <div className="regulation-actions" id="text-text-modal-train-regulation-actions"><header><div><span>REGULATION ACTIONS</span><strong>Review in the current operational context</strong></div><StatusPill tone="purple">Operator approval</StatusPill></header><div><button type="button" onClick={() => onRegulate(train.id, "priority")}><Icon name="activity" size={18}/><span><strong>Give priority</strong><small>Estimated gain · 2 min</small></span></button><button type="button" onClick={() => onRegulate(train.id, "hold")}><Icon name="pause" size={18}/><span><strong>Hold for 36 s</strong><small>Restore headway</small></span></button><button type="button" onClick={() => onRegulate(train.id, "turnback")}><Icon name="reset" size={18}/><span><strong>Turn back</strong><small>Reverse the service</small></span></button></div></div>
      </Modal>
    );
  }

  const circuit = selection.type === "circuit" ? snapshot.circuits.find((candidate) => candidate.id === selection.id) : undefined;
  if (circuit) {
    const section = snapshot.powerSections.find((candidate) => candidate.id === circuit.electricalSectionId);
    return (
      <Modal contentId="text-text-modal-track-circuit" title={circuit.id} eyebrow="TRACK CIRCUIT" onClose={onClose} footer={<button type="button" className="button button--secondary" onClick={() => openFull(selection, onClose)}>Open full record <Icon name="external" size={15}/></button>}>
        <div className="object-status" id="text-text-modal-track-circuit-status"><span className={`object-status__indicator object-status__indicator--${circuit.state}`}/><div><span>{circuit.closure ? "Availability status" : "Detection status"}</span><strong>{circuit.closure ? `Closed for ${circuit.closure.reason}` : circuit.state === "occupied" ? `Occupied by ${circuit.occupiedBy}` : circuit.state === "blocked" ? "Section blocked" : "Clear"}</strong></div><StatusPill tone={circuit.closure || circuit.state === "blocked" ? "danger" : circuit.state === "occupied" ? "info" : "ok"}>{circuit.closure ? "closed" : circuit.state}</StatusPill></div>
        <dl className="definition-grid" id="text-text-modal-track-circuit-properties"><div><dt>Line</dt><dd>{lineLabel(circuit.lineId)}</dd></div><div><dt>Direction</dt><dd>{circuit.direction === 1 ? "Track A" : "Track R"}</dd></div><div><dt>Section</dt><dd>{circuit.fromStation} → {circuit.toStation}</dd></div><div><dt>Length</dt><dd>{circuit.lengthMeters} m</dd></div><div><dt>Speed limit</dt><dd>{circuit.speedLimitKmh} km/h</dd></div><div><dt>Power supply</dt><dd>{section?.status ?? "unknown"} · {section?.voltage ?? "—"} V</dd></div></dl>
        <CircuitClosureControl circuit={circuit} onCloseCircuit={onCloseCircuit} onReopenCircuit={onReopenCircuit} />
      </Modal>
    );
  }

  const driver = selection.type === "driver" ? snapshot.drivers.find((candidate) => candidate.id === selection.id) : undefined;
  if (driver) {
    return (
      <Modal contentId="text-text-modal-driver" title={driver.id} eyebrow="PSEUDONYMIZED DRIVER RESOURCE" onClose={onClose} footer={<><span className="footer-note"><Icon name="shield" size={15}/> Identity restricted to the HR system</span><button type="button" className="button button--secondary" onClick={() => openFull(selection, onClose)}>Open full record <Icon name="external" size={15}/></button></>}>
        <div className="object-status" id="text-text-modal-driver-summary"><span className="driver-avatar-large"><Icon name="users" size={23}/></span><div><span>Depot · {driver.depot}</span><strong>{driver.shiftStart} — {driver.shiftEnd}</strong></div><StatusPill tone={driver.status === "relief-risk" ? "warning" : driver.status === "reserve" ? "info" : "ok"}>{driver.status}</StatusPill></div>
        <dl className="definition-grid" id="text-text-modal-driver-properties"><div><dt>Qualifications</dt><dd>{driver.qualifications.map(lineLabel).join(", ")}</dd></div><div><dt>Cumulative driving time</dt><dd>{driver.dutyMinutes} min</dd></div><div><dt>Assignment</dt><dd>{driver.assignedTrainId ?? "Reserve"}</dd></div><div><dt>Margin to next relief</dt><dd>{driver.status === "relief-risk" ? "6 min · under monitoring" : "18 min"}</dd></div></dl>
        <div className="modal-note" id="text-text-modal-driver-data-protection"><Icon name="shield" size={18}/><p>No names, absence reasons, personal statements, or medical data are present in this control center.</p></div>
      </Modal>
    );
  }

  const incident = selection.type === "incident" ? snapshot.incidents.find((candidate) => candidate.id === selection.id) : undefined;
  if (incident) {
    return (
      <Modal contentId="text-text-modal-incident" title={incident.title} eyebrow={`${incident.id} · ${incident.location}`} onClose={onClose} wide footer={<><button type="button" className="button button--secondary" onClick={() => openFull(selection, onClose)}>Open full record <Icon name="external" size={15}/></button>{incident.status === "active" && <button type="button" className="button button--primary" onClick={() => onIncidentStatus(incident.id, "acknowledged")}>Acknowledge</button>}{incident.status === "acknowledged" && <button type="button" className="button button--primary" onClick={() => onIncidentStatus(incident.id, "resolved")}>Close incident</button>}</>}>
        <div className="modal-hero-row" id="text-text-modal-incident-summary"><span className={`severity-mark severity-mark--${severityTone(incident.severity)}`}><Icon name={incident.type === "power" ? "bolt" : "alert"} size={20}/></span><div><span>{severityLabel(incident.severity)} · {incident.type}</span><strong>{incident.owner}</strong></div><StatusPill tone={incident.status === "active" ? "danger" : incident.status === "planned" ? "info" : "warning"}>{incidentStatusLabel(incident.status)}</StatusPill><time>{formatTime(incident.startedAt)}</time></div>
        <p className="incident-summary" id="text-text-modal-incident-description">{incident.summary}</p>
        <div className="incident-modal-grid" id="text-text-modal-incident-impact"><div><span>Affected trains</span><strong>{incident.impactedTrainIds.length}</strong><div className="mini-chips">{incident.impactedTrainIds.map((id) => <i key={id}>{id}</i>)}</div></div><div><span>Blocked track circuits</span><strong>{incident.blockedCircuitIds.length}</strong><div className="mini-chips">{incident.blockedCircuitIds.map((id) => <i key={id}>{id}</i>)}</div></div><div className="incident-actions-log"><span>Actions taken</span>{incident.actions.map((action, index) => <p key={action}><i>{index + 1}</i>{action}</p>)}</div></div>
      </Modal>
    );
  }

  const power = selection.type === "power" ? snapshot.powerSections.find((candidate) => candidate.id === selection.id) : undefined;
  if (power) {
    const line = lineDefinition(power.lineIds[0]);
    return (
      <Modal contentId="text-text-modal-power" title={power.name} eyebrow={`${power.id} · ${power.substation}`} onClose={onClose} footer={<><span className="footer-note"><Icon name="shield" size={15}/> Operator-controlled action</span><button type="button" className="button button--secondary" onClick={() => openFull(selection, onClose)}>Open full record</button>{power.status === "isolated" ? <button type="button" className="button button--primary" onClick={() => onPower(power.id, "energized")}>Restore power</button> : <button type="button" className="button button--danger" onClick={() => onPower(power.id, "isolated")}>Isolate section</button>}</>}>
        <div className="modal-hero-row" id="text-text-modal-power-summary"><div className="modal-line-badge" style={{ background: line.color, color: line.textColor }}>{line.shortName}</div><div><span>Traction section</span><strong>{power.status === "energized" ? "Nominal power supply" : power.status === "degraded" ? "Under monitoring" : "Section isolated"}</strong></div><StatusPill tone={power.status === "energized" ? "ok" : power.status === "degraded" ? "warning" : "danger"}>{power.status}</StatusPill></div>
        <div className="gauge-grid" id="text-text-modal-power-measurements"><div className="gauge"><span>Voltage</span><strong>{power.voltage}</strong><em>V / {power.nominalVoltage} V</em><div><i style={{ width: `${power.voltage / power.nominalVoltage * 100}%` }}/></div></div><div className="gauge"><span>Current</span><strong>{power.currentAmps}</strong><em>amperes</em><div><i style={{ width: `${Math.min(100, power.currentAmps / 22)}%` }}/></div></div><div className="gauge"><span>Load</span><strong>{power.status === "isolated" ? "N/A" : power.loadPercent}</strong><em>{power.status === "isolated" ? "Unavailable while isolated" : "% capacity"}</em><div><i style={{ width: `${power.status === "isolated" ? 0 : power.loadPercent}%` }}/></div></div></div>
        <div className="modal-note modal-note--warning" id="text-text-modal-power-safety-notice"><Icon name="alert" size={18}/><p>In a live environment, this action would require field authorization and would never be executed directly by the agent.</p></div>
      </Modal>
    );
  }

  return <Modal contentId="text-text-modal-object-unavailable" title="Object unavailable" onClose={onClose}><div className="empty-state"><Icon name="search" size={26}/><p>This object does not exist in the current snapshot.</p></div></Modal>;
}
