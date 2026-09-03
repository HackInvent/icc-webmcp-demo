import type { DetailType } from "../navigation";
import { navigate, pathForPage } from "../navigation";
import type { CircuitClosureReason, EntitySelection, RailSnapshot } from "../rail/domain";
import { lineDefinition } from "../rail/topology";
import { formatDelay, formatTime, incidentStatusLabel, lineLabel, severityLabel, severityTone, trainStatusLabel } from "../utils";
import { CircuitClosureControl } from "../components/EntityModal";
import { Icon } from "../components/Icon";
import { NetworkSchematic } from "../components/NetworkSchematic";
import { StatusPill } from "../components/StatusPill";

interface DetailPageProps {
  type: DetailType;
  id: string;
  snapshot: RailSnapshot;
  onSelect: (selection: EntitySelection) => void;
  onCloseCircuit: (circuitId: string, reason: CircuitClosureReason, note: string) => void;
  onReopenCircuit: (circuitId: string) => void;
}

export function DetailPage({ type, id, snapshot, onSelect, onCloseCircuit, onReopenCircuit }: DetailPageProps) {
  const train = type === "train" ? snapshot.trains.find((candidate) => candidate.id === id) : undefined;
  const circuit = type === "circuit" ? snapshot.circuits.find((candidate) => candidate.id === id) : undefined;
  const driver = type === "driver" ? snapshot.drivers.find((candidate) => candidate.id === id) : undefined;
  const incident = type === "incident" ? snapshot.incidents.find((candidate) => candidate.id === id) : undefined;
  const power = type === "power" ? snapshot.powerSections.find((candidate) => candidate.id === id) : undefined;
  const title = train?.circulationId ?? circuit?.id ?? driver?.id ?? incident?.title ?? power?.name ?? "Item not found";
  const backPage = type === "driver" ? "schedules" : type === "incident" ? "incidents" : type === "power" ? "power" : type === "train" ? "regulation" : "overview";
  const journeyStations = train
    ? train.direction === 1
      ? lineDefinition(train.lineId).stations
      : [...lineDefinition(train.lineId).stations].reverse()
    : [];
  const relatedTrainEvents = train
    ? snapshot.events.filter((event) => {
        const searchable = `${event.title} ${event.detail}`;
        return searchable.includes(train.id) || searchable.includes(train.circulationId);
      }).slice(0, 5)
    : [];
  const incidentDecisionEvents = incident
    ? snapshot.events
        .filter((event) => event.kind === "incident" && event.title.startsWith(`${incident.id} ·`))
        .slice()
        .reverse()
    : [];

  return (
    <div className="page detail-page" id="text-text-detail-page">
      <button type="button" className="back-link" id="text-text-detail-back-navigation" onClick={() => navigate(pathForPage(backPage))}><span>←</span> Back</button>
      <header className="detail-hero" id="text-text-detail-header">
        <div><span className="page-header__eyebrow">FULL RECORD · {type.toUpperCase()}</span><h1>{title}</h1><p>Operational view captured at {formatTime(snapshot.timestamp)} · revision {snapshot.revision}</p></div>
        <StatusPill tone="purple">Operational state</StatusPill>
      </header>

      {train && <>
        <section className="detail-summary" id={`text-text-detail-${type}-summary`}>
          <article><span>Line</span><strong>{lineLabel(train.lineId)}</strong></article><article><span>Rolling stock</span><strong>{train.id}</strong></article><article><span>Delay</span><strong className={train.delaySeconds >= 300 ? "delay delay--high" : "delay"}>{formatDelay(train.delaySeconds)}</strong></article><article><span>Status</span><strong>{trainStatusLabel(train.status)}</strong></article><article><span>Driver</span><button type="button" className="inline-link" disabled={!train.driverId} onClick={() => train.driverId && onSelect({ type: "driver", id: train.driverId })}>{train.driverId ?? "Automatic"}</button></article>
        </section>
        <article className="panel detail-map" id="text-text-detail-train-route"><header className="panel__header"><div><span className="panel__eyebrow">ROUTE</span><h2>{train.origin} → {train.destination}</h2></div><StatusPill tone={train.status === "running" ? "ok" : "warning"}>{trainStatusLabel(train.status)}</StatusPill></header><NetworkSchematic snapshot={snapshot} selectedLine={train.lineId} onSelect={onSelect} compact/></article>
        <section className="detail-columns" id="text-text-detail-train-supporting-information">
          <article className="panel" id="text-text-detail-train-journey-progress">
            <header className="panel__header"><h2>Journey progress</h2></header>
            <div className="journey-list">
              {journeyStations.map((station, index) => {
                const isNext = station === train.nextStop;
                const isServed = !isNext && index <= train.routeIndex;
                return <div className={isNext ? "current" : isServed ? "done" : ""} key={station}><i/><span><strong>{station}</strong><small>{isNext ? "Next stop" : isServed ? "Served" : `Scheduled +${index * 3 + 2} min`}</small></span></div>;
              })}
            </div>
          </article>
          <article className="panel" id="text-text-detail-train-related-events">
            <header className="panel__header"><h2>Related events</h2></header>
            {relatedTrainEvents.length > 0 ? <div className="detail-events">{relatedTrainEvents.map((event) => <div key={event.id}><time>{formatTime(event.timestamp)}</time><i/><span><strong>{event.title}</strong><small>{event.detail}</small></span></div>)}</div> : <p className="panel-copy">No recorded event references this train.</p>}
          </article>
        </section>
      </>}

      {circuit && <>
        <section className="detail-summary" id={`text-text-detail-${type}-summary`}><article><span>Status</span><strong>{circuit.closure ? `Closed · ${circuit.closure.reason}` : circuit.state}</strong></article><article><span>Line</span><strong>{lineLabel(circuit.lineId)}</strong></article><article><span>Direction</span><strong>{circuit.direction === 1 ? "Track A" : "Track R"}</strong></article><article><span>Length</span><strong>{circuit.lengthMeters} m</strong></article><article><span>Occupancy</span><button type="button" className="inline-link" disabled={!circuit.occupiedBy} onClick={() => circuit.occupiedBy && onSelect({ type: "train", id: circuit.occupiedBy })}>{circuit.occupiedBy ?? "Clear"}</button></article></section>
        <article className="panel detail-map" id="text-text-detail-circuit-location"><header className="panel__header"><div><span className="panel__eyebrow">LOCATION</span><h2>{circuit.fromStation} → {circuit.toStation}</h2></div></header><NetworkSchematic snapshot={snapshot} selectedLine={circuit.lineId} onSelect={onSelect} compact/></article>
        <section className="circuit-detail-command" id="text-text-detail-circuit-command"><CircuitClosureControl circuit={circuit} onCloseCircuit={onCloseCircuit} onReopenCircuit={onReopenCircuit} testIdPrefix="circuit-detail" /></section>
      </>}

      {driver && <>
        <section className="detail-summary" id={`text-text-detail-${type}-summary`}><article><span>Resource token</span><strong>{driver.id}</strong></article><article><span>Depot</span><strong>{driver.depot}</strong></article><article><span>Shift</span><strong>{driver.shiftStart} — {driver.shiftEnd}</strong></article><article><span>Driving time</span><strong>{driver.dutyMinutes} min</strong></article><article><span>Status</span><strong>{driver.status}</strong></article></section>
        <section className="detail-columns" id="text-text-detail-driver-information"><article className="panel" id="text-text-detail-driver-qualifications"><header className="panel__header"><h2>Available qualifications</h2></header><div className="qualification-list">{driver.qualifications.map((lineId) => <div key={lineId}><Icon name="shield" size={18}/><span><strong>{lineLabel(lineId)}</strong><small>Operator policy approved for this operational context</small></span><StatusPill tone="ok">Valid</StatusPill></div>)}</div></article><article className="panel" id="text-text-detail-driver-data-protection"><header className="panel__header"><h2>Data protection</h2></header><div className="privacy-copy"><Icon name="shield" size={26}/><p>The cockpit only uses a pseudonymous token, a capacity profile, and the required qualifications. The driver's real identity remains confined to the operator's HR system.</p></div></article></section>
      </>}

      {incident && <>
        <section className="detail-summary" id={`text-text-detail-${type}-summary`}><article><span>ID</span><strong>{incident.id}</strong></article><article><span>Severity</span><strong>{severityLabel(incident.severity)}</strong></article><article><span>Status</span><strong>{incidentStatusLabel(incident.status)}</strong></article><article><span>Owner</span><strong>{incident.owner}</strong></article><article><span>Affected trains</span><strong>{incident.impactedTrainIds.length}</strong></article></section>
        <section className="detail-columns" id="text-text-detail-incident-information"><article className="panel" id="text-text-detail-incident-timeline"><header className="panel__header"><h2>Operational timeline</h2></header><div className="journey-list"><div className="done"><i/><span><strong>Incident opened</strong><small>{formatTime(incident.startedAt)}</small></span></div>{incident.actions.map((action, index) => <div className="done" key={`${action}-${index}`}><i/><span><strong>{action}</strong><small>Imported baseline response</small></span></div>)}{incidentDecisionEvents.map((event) => <div className="done" key={event.id}><i/><span><strong>{event.title}</strong><small>{formatTime(event.timestamp)}</small></span></div>)}</div></article><article className="panel" id="text-text-detail-incident-impact"><header className="panel__header"><h2>Impact scope</h2></header><p className="panel-copy">{incident.summary}</p><div className="impact-chips">{incident.impactedTrainIds.map((trainId) => <button type="button" key={trainId} onClick={() => onSelect({ type: "train", id: trainId })}>{trainId}</button>)}{incident.blockedCircuitIds.map((circuitId) => <button type="button" key={circuitId} onClick={() => onSelect({ type: "circuit", id: circuitId })}>{circuitId}</button>)}</div><StatusPill tone={severityTone(incident.severity)}>{incident.location}</StatusPill></article></section>
      </>}

      {power && <>
        <section className="detail-summary" id={`text-text-detail-${type}-summary`}><article><span>Section</span><strong>{power.id}</strong></article><article><span>Voltage</span><strong>{power.voltage} V</strong></article><article><span>Current</span><strong>{power.currentAmps} A</strong></article><article><span>Load</span><strong>{power.status === "isolated" ? "N/A" : `${power.loadPercent} %`}</strong></article><article><span>Status</span><strong>{power.status}</strong></article></section>
        <section className="detail-columns" id="text-text-detail-power-information"><article className="panel" id="text-text-detail-power-measurements"><header className="panel__header"><h2>Current simulated readings</h2></header><dl className="definition-grid"><div><dt>Nominal voltage</dt><dd>{power.nominalVoltage} V</dd></div><div><dt>Simulated voltage</dt><dd>{power.voltage} V</dd></div><div><dt>Simulated current</dt><dd>{power.currentAmps} A</dd></div><div><dt>Estimated load</dt><dd>{power.status === "isolated" ? "Not available while isolated" : `${power.loadPercent}%`}</dd></div><div><dt>Snapshot update</dt><dd>{formatTime(snapshot.timestamp)}</dd></div></dl></article><article className="panel" id="text-text-detail-power-circuits"><header className="panel__header"><h2>Associated track circuits</h2></header><div className="impact-chips">{power.circuitIds.map((circuitId) => <button type="button" key={circuitId} onClick={() => onSelect({ type: "circuit", id: circuitId })}>{circuitId}</button>)}</div></article></section>
      </>}

      {!train && !circuit && !driver && !incident && !power && <div className="empty-state" id="text-text-detail-empty-state"><Icon name="search" size={28}/><h2>Item not found</h2><p>It may no longer be present in the current snapshot.</p></div>}
    </div>
  );
}
