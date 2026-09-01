import { useState } from "react";
import type { EntitySelection, RailSnapshot } from "../rail/domain";
import { nativeIncidentPath, navigate } from "../navigation";
import { NATIVE_LINE_BY_CODE } from "../rail/nativeNetwork";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import { lineDefinition } from "../rail/topology";
import { formatTime, incidentStatusLabel, severityLabel, severityTone } from "../utils";
import { Icon } from "../components/Icon";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { StatusPill } from "../components/StatusPill";

interface IncidentsPageProps {
  snapshot: RailSnapshot;
  nativeSimulation: NativeSimulationSnapshot;
  onSelect: (selection: EntitySelection) => void;
}

type IncidentFilter = "current" | "unacknowledged" | "planned" | "history";

export function filterIncidents(
  incidents: RailSnapshot["incidents"],
  filter: IncidentFilter,
): RailSnapshot["incidents"] {
  if (filter === "unacknowledged") {
    return incidents.filter((incident) => incident.status === "active");
  }
  if (filter === "planned") {
    return incidents.filter((incident) => incident.status === "planned");
  }
  if (filter === "history") {
    return incidents.filter((incident) => incident.status === "resolved");
  }
  return incidents.filter((incident) => incident.status !== "resolved");
}

const INCIDENT_FILTERS: ReadonlyArray<{ id: IncidentFilter; label: string }> = [
  { id: "current", label: "Current" },
  { id: "unacknowledged", label: "Unacknowledged" },
  { id: "planned", label: "Planned" },
  { id: "history", label: "History" },
];

function nativeIncidentIcon(incident: NativeSimulationSnapshot["incidents"][number]): "bolt" | "baggage" | "radio" | "wrench" | "alert" {
  if (incident.type === "power") return "bolt";
  if (incident.effect === "abandoned-baggage") return "baggage";
  if (incident.type === "communications") return "radio";
  if (incident.effect === "tow-train") return "wrench";
  return "alert";
}

function lineTextColor(color: string): string {
  const value = color.replace("#", "");
  if (!/^[a-f\d]{6}$/i.test(value)) return "#ffffff";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 158 ? "#142720" : "#ffffff";
}

export function IncidentsPage({ snapshot, nativeSimulation, onSelect }: IncidentsPageProps) {
  const [filter, setFilter] = useState<IncidentFilter>("current");
  const open = snapshot.incidents.filter((incident) => incident.status === "active" || incident.status === "acknowledged");
  const visibleIncidents = filterIncidents(snapshot.incidents, filter);
  const nativeIncidents = nativeSimulation.incidents.filter((incident) => incident.status === "active");
  const nativeImpactedTrains = new Set(nativeIncidents.flatMap((incident) => incident.impactedTrainIds));
  return (
    <div className="page" id="text-text-incidents-page">
      <PageHeader
        contentId="text-text-incidents-header"
        eyebrow="MULTIMODAL INCIDENT LOG"
        title="Incident management"
        description="One cross-domain queue from the 21-line native map to detailed corridor evidence, with an auditable chain of decisions."
        actions={<button type="button" className="button button--primary" onClick={() => onSelect({ type: "incident", id: "NEW" })}>+ Report an incident</button>}
      />
      <section className="kpi-grid kpi-grid--compact" id="text-text-incidents-summary">
        <KpiCard label="Native map incidents" value={nativeIncidents.length} detail={`${open.length} detailed-corridor events`} icon="alert" tone={nativeIncidents.length ? "danger" : "default"} />
        <KpiCard label="Native restrictions" value={nativeSimulation.metrics.blockedInterstationCount + nativeSimulation.metrics.reducedSpeedInterstationCount} detail={`${nativeSimulation.metrics.blockedInterstationCount} blocked · ${nativeSimulation.metrics.reducedSpeedInterstationCount} reduced-speed`} icon="clock" tone="warning" />
        <KpiCard label="Impacted native trains" value={nativeImpactedTrains.size} detail={`${nativeSimulation.metrics.fleetSize} trains · 21 lines`} icon="train" />
        <KpiCard label="Decision context" value={`rev. ${nativeSimulation.decisionRevision}`} detail={`telemetry rev. ${nativeSimulation.telemetryRevision}`} icon="activity" />
      </section>

      <section className="panel incident-board native-decision-queue" id="text-text-incidents-native-decision-queue" aria-labelledby="native-decision-queue-title">
        <header className="panel__header">
          <div><span className="panel__eyebrow">NATIVE MAP · WEBMCP DECISION QUEUE</span><h2 id="native-decision-queue-title">Network-wide incidents</h2></div>
          <StatusPill tone="purple">exact decision rev. {nativeSimulation.decisionRevision}</StatusPill>
        </header>
        <div className="incident-list">
          {nativeIncidents.map((incident) => {
            const line = NATIVE_LINE_BY_CODE.get(incident.lineCode);
            return (
              <button
                type="button"
                className="incident-row"
                key={incident.id}
                onClick={() => navigate(nativeIncidentPath(incident.id))}
              >
                <span className={`severity-mark severity-mark--${severityTone(incident.severity)}`}><Icon name={nativeIncidentIcon(incident)} size={18}/></span>
                <span className="incident-row__main">
                  <span><strong>{incident.title}</strong><StatusPill tone={severityTone(incident.severity)}>{severityLabel(incident.severity)}</StatusPill></span>
                  <small>{incident.id} · {incident.incidentCode} · {incident.location}</small>
                  <p>{incident.summary}</p>
                  <span className="incident-lines"><i style={{ background: line?.color ?? "#60736d", color: lineTextColor(line?.color ?? "#60736d") }}>{line?.label ?? incident.lineCode}</i></span>
                </span>
                <span className="incident-row__impact"><small>Native impact</small><strong>{incident.impactedTrainIds.length} trains</strong><span>{incident.affectedInterstationIds.length} interstation{incident.affectedInterstationIds.length === 1 ? "" : "s"}</span></span>
                <span className="incident-row__status"><StatusPill tone={incident.restrictionMode === "blocked" ? "danger" : "warning"}>{incident.restrictionMode}</StatusPill><time>{formatTime(incident.startedAt)}</time></span>
                <Icon name="chevron" size={18}/>
              </button>
            );
          })}
        </div>
        <footer className="native-decision-queue__footer" id="text-text-incidents-agent-path">
          <Icon name="radio" size={15}/>
          <span>Agent path: inspect coded incident → search procedures → cite document steps → human approval → verified receipt.</span>
        </footer>
      </section>

      <section className="incidents-layout" id="text-text-incidents-workspace">
        <article className="panel incident-board" id="text-text-incidents-operations-queue">
          <header className="panel__header">
            <div><span className="panel__eyebrow">OPERATIONS QUEUE</span><h2>Ongoing and planned events</h2></div>
            <div className="board-filters" id="text-text-incidents-queue-filters" role="group" aria-label="Filter incident queue">
              {INCIDENT_FILTERS.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className={filter === candidate.id ? "active" : ""}
                  aria-pressed={filter === candidate.id}
                  onClick={() => setFilter(candidate.id)}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
          </header>
          <div className="incident-list">
            {visibleIncidents.map((incident) => (
              <button type="button" className="incident-row" key={incident.id} onClick={() => onSelect({ type: "incident", id: incident.id })}>
                <span className={`severity-mark severity-mark--${severityTone(incident.severity)}`}><Icon name={incident.type === "power" ? "bolt" : "alert"} size={18}/></span>
                <span className="incident-row__main"><span><strong>{incident.title}</strong><StatusPill tone={severityTone(incident.severity)}>{severityLabel(incident.severity)}</StatusPill></span><small>{incident.id} · {incident.incidentCode} · {incident.location}</small><p>{incident.summary}</p><span className="incident-lines">{incident.lineIds.map((lineId) => { const line = lineDefinition(lineId); return <i key={lineId} style={{ background: line.color, color: line.textColor }}>{line.shortName}</i>; })}</span></span>
                <span className="incident-row__impact"><small>Impact</small><strong>{incident.impactedTrainIds.length} trains</strong><span>{incident.blockedCircuitIds.length} blocked track circuit{incident.blockedCircuitIds.length === 1 ? "" : "s"}</span></span>
                <span className="incident-row__status"><StatusPill tone={incident.status === "active" ? "danger" : incident.status === "planned" ? "info" : "warning"}>{incidentStatusLabel(incident.status)}</StatusPill><time>{formatTime(incident.startedAt)}</time></span>
                <Icon name="chevron" size={18}/>
              </button>
            ))}
            {visibleIncidents.length === 0 && (
              <div className="incident-list__empty" role="status">
                <Icon name="shield" size={22} />
                <strong>No incidents in this filter</strong>
                <span>Select another queue filter to continue.</span>
              </div>
            )}
          </div>
        </article>

        <aside className="panel response-panel" id="text-text-incidents-response-standards">
          <header className="panel__header"><div><span className="panel__eyebrow">RESPONSE STANDARDS</span><h2>Configured objectives</h2></div></header>
          <div className="response-metric"><span><strong>Acknowledgement</strong><small>Response target</small></span><b>≤ 3 min</b><div><i style={{ width: "100%" }}/></div></div>
          <div className="response-metric"><span><strong>Diagnosis</strong><small>Response target</small></span><b>≤ 8 min</b><div><i style={{ width: "100%" }}/></div></div>
          <div className="response-metric"><span><strong>Passenger information</strong><small>Response target</small></span><b>≤ 5 min</b><div><i style={{ width: "100%" }}/></div></div>
          <div className="response-panel__footer"><Icon name="shield" size={18}/><span><strong>Active audit trail</strong><small>Each decision is added to the operations log.</small></span></div>
        </aside>
      </section>
    </div>
  );
}
