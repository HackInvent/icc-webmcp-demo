import { useState } from "react";
import type { EntitySelection, RailSnapshot } from "../rail/domain";
import { formatTime, lineLabel } from "../utils";
import { Icon } from "../components/Icon";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { PowerDiagram } from "../components/PowerDiagram";
import { StatusPill } from "../components/StatusPill";

interface PowerPageProps {
  snapshot: RailSnapshot;
  onSelect: (selection: EntitySelection) => void;
}

export function PowerPage({ snapshot, onSelect }: PowerPageProps) {
  const [showPowerLog, setShowPowerLog] = useState(false);
  const degraded = snapshot.powerSections.filter((section) => section.status !== "energized");
  const isolated = snapshot.powerSections.filter((section) => section.status === "isolated");
  const powerEvents = snapshot.events.filter((event) => event.kind === "power");
  const consumption = Math.round(snapshot.powerSections.reduce((sum, section) => sum + section.currentAmps * section.voltage, 0) / 1_000_000 * 10) / 10;
  return (
    <div className="page" id="text-text-power-page">
      <PageHeader
        contentId="text-text-power-header"
        eyebrow="TRACTION POWER"
        title="Electrical power supply"
        description="Monitor substations, voltage levels, and supplied areas without exposing field controls."
        actions={<><StatusPill tone={isolated.length ? "danger" : degraded.length ? "warning" : "ok"}>{degraded.length} constrained sector{degraded.length === 1 ? "" : "s"}</StatusPill><button type="button" className="button button--secondary" aria-expanded={showPowerLog} aria-controls="text-text-power-operations-log" onClick={() => setShowPowerLog((visible) => !visible)}><Icon name="activity" size={16}/> {showPowerLog ? "Hide power log" : "Power log"}</button></>}
      />
      <div className="notice notice--warning" id="text-text-power-safety-notice"><Icon name="bolt" size={18}/><div><strong>Operator approval required</strong><span>Isolation and re-energization actions are bound to the current decision revision.</span></div></div>
      {showPowerLog && (
        <article className="panel power-log" id="text-text-power-operations-log" aria-labelledby="power-log-title">
          <header className="panel__header"><div><span className="panel__eyebrow">AUDIT TRAIL</span><h2 id="power-log-title">Power operations log</h2></div><StatusPill tone="neutral">{powerEvents.length} event{powerEvents.length === 1 ? "" : "s"}</StatusPill></header>
          <div className="detail-events">
            {powerEvents.map((event) => <div key={event.id}><time>{formatTime(event.timestamp)}</time><i/><span><strong>{event.title}</strong><small>{event.detail}</small></span></div>)}
            {powerEvents.length === 0 && <div><span><strong>No power event recorded</strong><small>The current operational state contains no power-state change.</small></span></div>}
          </div>
        </article>
      )}
      <section className="kpi-grid kpi-grid--compact" id="text-text-power-summary">
        <KpiCard label="Nominal sections" value={`${snapshot.powerSections.length - degraded.length}/${snapshot.powerSections.length}`} detail="Metro + RER scope" icon="bolt" />
        <KpiCard label="Consolidated load" value={`${consumption} MW`} detail="Current consolidated estimate" icon="activity" />
        <KpiCard label="Active anomalies" value={degraded.length} detail={isolated.length ? `${isolated.length} traction power outage${isolated.length === 1 ? "" : "s"}` : degraded.length ? "Degraded voltage · no traction outage" : "All sections nominal"} icon="alert" tone={isolated.length ? "danger" : degraded.length ? "warning" : "default"} />
        <KpiCard label="Snapshot revision" value={`#${snapshot.revision}`} detail={`Operational time ${formatTime(snapshot.timestamp)}`} icon="radio" />
      </section>

      <section className="power-layout" id="text-text-power-workspace">
        <article className="panel power-board" id="text-text-power-diagram">
          <header className="panel__header"><div><span className="panel__eyebrow">SINGLE-LINE DIAGRAM</span><h2>Sections & rectifier substations</h2></div><div className="power-legend"><span><i className="power-dot power-dot--ok"/>Energized</span><span><i className="power-dot power-dot--warning"/>Degraded</span><span><i className="power-dot power-dot--danger"/>Isolated</span></div></header>
          <PowerDiagram snapshot={snapshot} onSelect={onSelect} />
        </article>

        <aside className="panel section-list-panel" id="text-text-power-monitored-sections">
          <header className="panel__header"><div><span className="panel__eyebrow">MEASUREMENTS</span><h2>Monitored sections</h2></div></header>
          <div className="power-section-list">{snapshot.powerSections.map((section) => (
            <button type="button" key={section.id} onClick={() => onSelect({ type: "power", id: section.id })}>
              <span className={`power-state power-state--${section.status}`}/>
              <span><strong>{section.name}</strong><small>{lineLabel(section.lineIds[0])} · {section.substation}</small></span>
              <span className="power-values"><strong>{section.voltage} V</strong><small>{section.currentAmps} A · {section.status === "isolated" ? "load N/A" : `${section.loadPercent} %`}</small></span>
              <Icon name="chevron" size={16}/>
            </button>
          ))}</div>
        </aside>
      </section>
    </div>
  );
}
