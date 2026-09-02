import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { EntitySelection, LineId, RailSnapshot } from "../rail/domain";
import type { NativeLineCode } from "../rail/nativeNetwork";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import {
  TRACTION_POWER_LINES,
  buildProjectedTractionPowerLine,
  isDetailedTractionPowerLine,
  lineBadgeTextColor,
  projectedTractionPowerSectionCount,
  tractionPowerShortLabel,
} from "../rail/tractionPowerView";
import { lineDefinition } from "../rail/topology";
import { formatTime } from "../utils";
import { Icon } from "../components/Icon";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { PowerDiagram } from "../components/PowerDiagram";
import { ProjectedPowerDiagram } from "../components/ProjectedPowerDiagram";
import { StatusPill } from "../components/StatusPill";

interface PowerPageProps {
  snapshot: RailSnapshot;
  nativeSimulation?: NativeSimulationSnapshot;
  initialLineCode?: NativeLineCode;
  onSelect: (selection: EntitySelection) => void;
}

export function PowerPage({ snapshot, nativeSimulation, initialLineCode = "RER_A", onSelect }: PowerPageProps) {
  const [showPowerLog, setShowPowerLog] = useState(false);
  const [requestedLineCode, setRequestedLineCode] = useState<NativeLineCode>(initialLineCode);
  const selectedNativeLine = TRACTION_POWER_LINES.find((line) => line.code === requestedLineCode) ?? TRACTION_POWER_LINES[0];
  if (!selectedNativeLine) throw new Error("The traction-power line catalogue is empty.");

  const selectedLineCode = selectedNativeLine.code;
  const detailedLineId: LineId | null = isDetailedTractionPowerLine(selectedLineCode) ? selectedLineCode : null;
  const detailedLine = detailedLineId ? lineDefinition(detailedLineId) : null;
  const projectedLine = useMemo(
    () => buildProjectedTractionPowerLine(selectedLineCode, nativeSimulation),
    [nativeSimulation, selectedLineCode],
  );
  const sections = detailedLineId
    ? snapshot.powerSections.filter((section) => section.lineIds.includes(detailedLineId))
    : [];
  const degraded = sections.filter((section) => section.status !== "energized");
  const isolated = sections.filter((section) => section.status === "isolated");
  const projectedConstraints = projectedLine.sections.filter((section) => section.status !== "energized");
  const globalDegraded = snapshot.powerSections.filter((section) => section.status !== "energized");
  const activeNativePowerIncidents = nativeSimulation?.incidents.filter((incident) =>
    incident.type === "power" && incident.status === "active"
  ) ?? [];
  const globalConstraintCount = globalDegraded.length + activeNativePowerIncidents.filter((incident) =>
    !snapshot.incidents.some((detailedIncident) => detailedIncident.id === incident.id)
  ).length;
  const powerEvents = snapshot.events.filter((event) => event.kind === "power");
  const linePowerIncidents = detailedLineId
    ? snapshot.incidents.filter((incident) => incident.type === "power" && incident.status !== "resolved" && incident.lineIds.includes(detailedLineId))
    : [];
  const consumption = Math.round(sections.reduce((sum, section) => sum + section.currentAmps * section.voltage, 0) / 1_000_000 * 10) / 10;
  const minimumVoltage = sections.length ? Math.min(...sections.map((section) => section.voltage)) : 0;
  const minimumNominalVoltage = sections.length ? Math.min(...sections.map((section) => section.nominalVoltage)) : 0;
  const voltageRatio = minimumNominalVoltage ? Math.round(minimumVoltage / minimumNominalVoltage * 100) : 0;
  const selectedName = detailedLine?.name ?? selectedNativeLine.name;
  const selectedShortName = detailedLine?.shortName ?? tractionPowerShortLabel(selectedLineCode);
  const selectedTextColor = detailedLine?.textColor ?? lineBadgeTextColor(selectedNativeLine.color);
  const selectedScope = detailedLine?.simulatedCorridor ??
    `Principal route envelope · ${projectedLine.routeStationCount} stations · ${projectedLine.routeInterstationCount} interstations`;
  const selectedPowerSupply = detailedLine?.powerSupply ?? (
    selectedNativeLine.mode === "metro"
      ? "750 V DC traction reference · network topology projection"
      : "RER traction-supply envelope · network topology projection"
  );
  const selectedConstraintCount = detailedLineId ? degraded.length : projectedConstraints.length;
  const selectedSectionCount = detailedLineId ? sections.length : projectedLine.sections.length;

  return (
    <div className="page" id="text-text-power-page">
      <PageHeader
        contentId="text-text-power-header"
        eyebrow="TRACTION POWER"
        title="Electrical power supply"
        description="Select any of the 16 Metro or 5 RER lines. Four reference lines expose detailed operational telemetry; every other line exposes a sectioned full-network topology projection."
        actions={<><StatusPill tone="neutral">21 selectable lines</StatusPill><StatusPill tone={globalDegraded.some((section) => section.status === "isolated") ? "danger" : globalConstraintCount ? "warning" : "ok"}>{globalConstraintCount} network constraint{globalConstraintCount === 1 ? "" : "s"}</StatusPill><button type="button" className="button button--secondary" aria-expanded={showPowerLog} aria-controls="text-text-power-operations-log" onClick={() => setShowPowerLog((visible) => !visible)}><Icon name="activity" size={16}/> {showPowerLog ? "Hide power log" : "Power log"}</button></>}
      />
      <div className="notice notice--warning" id="text-text-power-safety-notice"><Icon name="bolt" size={18}/><div><strong>Operator approval required</strong><span>Isolation and re-energization are available only for sections linked to operational telemetry and remain bound to the current decision revision.</span></div></div>
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
        {TRACTION_POWER_LINES.map((line) => {
          const detailedLineCode = isDetailedTractionPowerLine(line.code) ? line.code : null;
          const lineSections = detailedLineCode
            ? snapshot.powerSections.filter((section) => section.lineIds.includes(detailedLineCode))
            : [];
          const sectionCount = detailedLineCode ? lineSections.length : projectedTractionPowerSectionCount(line.code);
          const constrainedCount = detailedLineCode
            ? lineSections.filter((section) => section.status !== "energized").length
            : activeNativePowerIncidents.filter((incident) => incident.lineCode === line.code).length;
          return (
            <button
              id={`power-line-tab-${line.code}`}
              data-line-id={line.code}
              type="button"
              role="tab"
              aria-selected={line.code === selectedLineCode}
              aria-controls="text-text-power-line-panel"
              tabIndex={line.code === selectedLineCode ? 0 : -1}
              key={line.code}
              onClick={() => setRequestedLineCode(line.code)}
              style={{ "--power-line-color": line.color } as CSSProperties}
            >
              <span className="power-line-tabs__badge">{tractionPowerShortLabel(line.code)}</span>
              <span><strong>{line.name}</strong><small>{sectionCount} {detailedLineCode ? "telemetry" : "modelled"} section{sectionCount === 1 ? "" : "s"}</small></span>
              {constrainedCount > 0 && <span className="power-line-tabs__alert" aria-label={`${constrainedCount} constrained section${constrainedCount === 1 ? "" : "s"}`}>{constrainedCount}</span>}
            </button>
          );
        })}
      </nav>

      <section
        id="text-text-power-line-panel"
        className="power-line-context"
        role="tabpanel"
        aria-labelledby={`power-line-tab-${selectedLineCode}`}
      >
        <div>
          <span className="power-line-context__badge" style={{ backgroundColor: selectedNativeLine.color, color: selectedTextColor }}>{selectedShortName}</span>
          <span><strong>{selectedName} traction supply</strong><small>{selectedScope}</small></span>
        </div>
        <p><strong>{selectedPowerSupply}</strong><span>{detailedLineId ? `Decision revision #${snapshot.decisionRevision} · updated ${formatTime(snapshot.timestamp)}` : `${selectedNativeLine.stationCodes.length} network stations · ${selectedNativeLine.interstationIds.length} physical interstations`}</span></p>
      </section>

      {detailedLineId ? (
        <section className="kpi-grid kpi-grid--compact" id="text-text-power-summary">
          <KpiCard label="Energized sections" value={`${sections.length - degraded.length}/${sections.length}`} detail={`${selectedName} selected`} icon="bolt" />
          <KpiCard label="Section power" value={`${consumption} MW`} detail="Voltage × current, section sum" icon="activity" />
          <KpiCard label="Lowest voltage" value={`${minimumVoltage} V`} detail={`${voltageRatio}% of nominal floor`} icon="radio" tone={degraded.length ? "warning" : "default"} />
          <KpiCard label="Supply constraints" value={degraded.length} detail={isolated.length ? `${isolated.length} isolated section${isolated.length === 1 ? "" : "s"}` : linePowerIncidents.length ? `${linePowerIncidents.length} active power incident${linePowerIncidents.length === 1 ? "" : "s"}` : degraded.length ? "Degraded voltage under monitoring" : "All selected-line sections nominal"} icon="alert" tone={isolated.length ? "danger" : degraded.length ? "warning" : "default"} />
        </section>
      ) : (
        <section className="kpi-grid kpi-grid--compact" id="text-text-power-summary">
          <KpiCard label="Modelled sections" value={projectedLine.sections.length} detail="Principal route coverage envelope" icon="bolt" />
          <KpiCard label="Network stations" value={selectedNativeLine.stationCodes.length} detail={`${selectedNativeLine.interstationIds.length} physical interstations`} icon="network" />
          <KpiCard label="Measurement feed" value="Not connected" detail="Topology projection, no fabricated telemetry" icon="radio" tone="warning" />
          <KpiCard label="Supply constraints" value={projectedConstraints.length} detail={projectedLine.activePowerIncidentCount ? `${projectedLine.activePowerIncidentCount} active linked power incident${projectedLine.activePowerIncidentCount === 1 ? "" : "s"}` : "No linked power incident"} icon="alert" tone={projectedConstraints.length ? "warning" : "default"} />
        </section>
      )}

      <section className="power-layout" id="text-text-power-workspace">
        <article className="panel power-board" id="text-text-power-diagram">
          <header className="panel__header"><div><span className="panel__eyebrow">{selectedName.toUpperCase()} · SINGLE-LINE DIAGRAM</span><h2>Electrical sections in route order</h2></div><div className="power-legend">{detailedLineId ? <><span><i className="power-dot power-dot--ok"/>Energized</span><span><i className="power-dot power-dot--warning"/>Degraded</span><span><i className="power-dot power-dot--danger"/>Isolated</span></> : <><span><i className="power-dot power-dot--ok"/>No linked constraint</span><span><i className="power-dot power-dot--warning"/>Active constraint</span></>}</div></header>
          {detailedLineId
            ? <PowerDiagram snapshot={snapshot} lineId={detailedLineId} onSelect={onSelect} />
            : <ProjectedPowerDiagram view={projectedLine} />}
        </article>

        <aside className="panel section-list-panel" id="text-text-power-monitored-sections">
          <header className="panel__header"><div><span className="panel__eyebrow">{selectedName.toUpperCase()} · {detailedLineId ? "MEASUREMENTS" : "COVERAGE MODEL"}</span><h2>{detailedLineId ? "Section telemetry" : "Modelled section boundaries"}</h2></div><StatusPill tone={isolated.length ? "danger" : selectedConstraintCount ? "warning" : "ok"}>{selectedSectionCount} sections</StatusPill></header>
          <div className="power-section-list" aria-label={`${selectedName} electrical sections`}>
            {detailedLineId ? sections.map((section) => (
              <button type="button" key={section.id} data-power-section-id={section.id} onClick={() => onSelect({ type: "power", id: section.id })}>
                <span className={`power-state power-state--${section.status}`}/>
                <span><strong>{section.name}</strong><small>{section.substation} · {section.circuitIds.length} supplied circuits</small></span>
                <span className="power-values"><strong>{section.voltage} V</strong><small>{section.currentAmps} A · {section.status === "isolated" ? "load N/A" : `${section.loadPercent} %`}</small></span>
                <Icon name="chevron" size={16}/>
              </button>
            )) : projectedLine.sections.map((section) => (
              <article key={section.id} data-power-model-section-id={section.id}>
                <span className={`power-state power-state--${section.status}`}/>
                <span><strong>{section.name}</strong><small>{section.rangeLabel}</small></span>
                <span className="power-values"><strong>Topology</strong><small>{section.interstationIds.length} interstations</small></span>
                <span className="power-section-model-badge">MODEL</span>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </div>
  );
}
