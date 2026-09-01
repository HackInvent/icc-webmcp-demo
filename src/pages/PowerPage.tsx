import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { EntitySelection, LineId, RailSnapshot } from "../rail/domain";
import { LINES, lineDefinition } from "../rail/topology";
import { formatTime } from "../utils";
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
  const availableLineIds = useMemo(
    () => LINES.map((line) => line.id).filter((lineId) => snapshot.powerSections.some((section) => section.lineIds.includes(lineId))),
    [snapshot.powerSections],
  );
  const [requestedLineId, setRequestedLineId] = useState<LineId>(availableLineIds[0] ?? "RER_A");
  const selectedLineId = availableLineIds.includes(requestedLineId) ? requestedLineId : availableLineIds[0] ?? "RER_A";
  const selectedLine = lineDefinition(selectedLineId);
  const sections = snapshot.powerSections.filter((section) => section.lineIds.includes(selectedLineId));
  const degraded = sections.filter((section) => section.status !== "energized");
  const isolated = sections.filter((section) => section.status === "isolated");
  const globalDegraded = snapshot.powerSections.filter((section) => section.status !== "energized");
  const powerEvents = snapshot.events.filter((event) => event.kind === "power");
  const linePowerIncidents = snapshot.incidents.filter((incident) => incident.type === "power" && incident.status !== "resolved" && incident.lineIds.includes(selectedLineId));
  const consumption = Math.round(sections.reduce((sum, section) => sum + section.currentAmps * section.voltage, 0) / 1_000_000 * 10) / 10;
  const minimumVoltage = sections.length ? Math.min(...sections.map((section) => section.voltage)) : 0;
  const minimumNominalVoltage = sections.length ? Math.min(...sections.map((section) => section.nominalVoltage)) : 0;
  const voltageRatio = minimumNominalVoltage ? Math.round(minimumVoltage / minimumNominalVoltage * 100) : 0;
  return (
    <div className="page" id="text-text-power-page">
      <PageHeader
        contentId="text-text-power-header"
        eyebrow="TRACTION POWER"
        title="Electrical power supply"
        description="Select one line to inspect its traction sections, substations, measurements and active supply constraints."
        actions={<><StatusPill tone={globalDegraded.some((section) => section.status === "isolated") ? "danger" : globalDegraded.length ? "warning" : "ok"}>{globalDegraded.length} network constraint{globalDegraded.length === 1 ? "" : "s"}</StatusPill><button type="button" className="button button--secondary" aria-expanded={showPowerLog} aria-controls="text-text-power-operations-log" onClick={() => setShowPowerLog((visible) => !visible)}><Icon name="activity" size={16}/> {showPowerLog ? "Hide power log" : "Power log"}</button></>}
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

      <nav className="power-line-tabs" role="tablist" aria-label="Traction power line">
        {availableLineIds.map((lineId) => {
          const line = lineDefinition(lineId);
          const lineSections = snapshot.powerSections.filter((section) => section.lineIds.includes(lineId));
          const constrainedCount = lineSections.filter((section) => section.status !== "energized").length;
          return (
            <button
              id={`power-line-tab-${lineId}`}
              type="button"
              role="tab"
              aria-selected={lineId === selectedLineId}
              aria-controls="text-text-power-line-panel"
              tabIndex={lineId === selectedLineId ? 0 : -1}
              key={lineId}
              onClick={() => setRequestedLineId(lineId)}
              style={{ "--power-line-color": line.color } as CSSProperties}
            >
              <span className="power-line-tabs__badge">{line.shortName}</span>
              <span><strong>{line.name}</strong><small>{lineSections.length} electrical sections</small></span>
              {constrainedCount > 0 && <span className="power-line-tabs__alert" aria-label={`${constrainedCount} constrained section${constrainedCount === 1 ? "" : "s"}`}>{constrainedCount}</span>}
            </button>
          );
        })}
      </nav>

      <section
        id="text-text-power-line-panel"
        className="power-line-context"
        role="tabpanel"
        aria-labelledby={`power-line-tab-${selectedLineId}`}
      >
        <div>
          <span className="power-line-context__badge" style={{ backgroundColor: selectedLine.color, color: selectedLine.textColor }}>{selectedLine.shortName}</span>
          <span><strong>{selectedLine.name} traction supply</strong><small>{selectedLine.simulatedCorridor}</small></span>
        </div>
        <p><strong>{selectedLine.powerSupply}</strong><span>Revision #{snapshot.revision} · updated {formatTime(snapshot.timestamp)}</span></p>
      </section>

      <section className="kpi-grid kpi-grid--compact" id="text-text-power-summary">
        <KpiCard label="Energized sections" value={`${sections.length - degraded.length}/${sections.length}`} detail={`${selectedLine.name} selected`} icon="bolt" />
        <KpiCard label="Section power" value={`${consumption} MW`} detail="Voltage × current, section sum" icon="activity" />
        <KpiCard label="Lowest voltage" value={`${minimumVoltage} V`} detail={`${voltageRatio}% of nominal floor`} icon="radio" tone={degraded.length ? "warning" : "default"} />
        <KpiCard label="Supply constraints" value={degraded.length} detail={isolated.length ? `${isolated.length} isolated section${isolated.length === 1 ? "" : "s"}` : linePowerIncidents.length ? `${linePowerIncidents.length} active power incident${linePowerIncidents.length === 1 ? "" : "s"}` : degraded.length ? "Degraded voltage under monitoring" : "All selected-line sections nominal"} icon="alert" tone={isolated.length ? "danger" : degraded.length ? "warning" : "default"} />
      </section>

      <section className="power-layout" id="text-text-power-workspace">
        <article className="panel power-board" id="text-text-power-diagram">
          <header className="panel__header"><div><span className="panel__eyebrow">{selectedLine.name.toUpperCase()} · SINGLE-LINE DIAGRAM</span><h2>Electrical sections in route order</h2></div><div className="power-legend"><span><i className="power-dot power-dot--ok"/>Energized</span><span><i className="power-dot power-dot--warning"/>Degraded</span><span><i className="power-dot power-dot--danger"/>Isolated</span></div></header>
          <PowerDiagram snapshot={snapshot} lineId={selectedLineId} onSelect={onSelect} />
        </article>

        <aside className="panel section-list-panel" id="text-text-power-monitored-sections">
          <header className="panel__header"><div><span className="panel__eyebrow">{selectedLine.name.toUpperCase()} · MEASUREMENTS</span><h2>Section telemetry</h2></div><StatusPill tone={isolated.length ? "danger" : degraded.length ? "warning" : "ok"}>{sections.length} sections</StatusPill></header>
          <div className="power-section-list" aria-label={`${selectedLine.name} electrical sections`}>{sections.map((section) => (
            <button type="button" key={section.id} data-power-section-id={section.id} onClick={() => onSelect({ type: "power", id: section.id })}>
              <span className={`power-state power-state--${section.status}`}/>
              <span><strong>{section.name}</strong><small>{section.substation} · {section.circuitIds.length} supplied circuits</small></span>
              <span className="power-values"><strong>{section.voltage} V</strong><small>{section.currentAmps} A · {section.status === "isolated" ? "load N/A" : `${section.loadPercent} %`}</small></span>
              <Icon name="chevron" size={16}/>
            </button>
          ))}{sections.length === 0 && <p className="power-section-list__empty">No electrical section is configured for this line.</p>}</div>
        </aside>
      </section>
    </div>
  );
}
