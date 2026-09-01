import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { NATIVE_LINES, type NativeLineCode } from "../rail/nativeNetwork";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";

interface ScadaPageProps {
  simulation: NativeSimulationSnapshot;
  operationalResponse?: unknown;
  onIncidentActivate: (incidentId: string) => void;
}

type SystemStatus = "online" | "degraded" | "offline" | "recovering";

interface ScadaLineEvidence {
  status: SystemStatus;
  lastHeartbeatAt: number;
  communicationIncidentId: string | null;
}

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function lineEvidence(response: unknown, lineCode: NativeLineCode, timestamp: number): ScadaLineEvidence {
  const root = responseRecord(response);
  const states = Array.isArray(root?.lineScada) ? root.lineScada : [];
  const item = states.map(responseRecord).find((candidate) => candidate?.lineCode === lineCode);
  const status = item?.status;
  return {
    status: status === "unavailable" || status === "offline" ? "offline" : status === "degraded" || status === "recovering" ? status : "online",
    lastHeartbeatAt: typeof item?.lastHeartbeatAt === "number" ? item.lastHeartbeatAt : timestamp,
    communicationIncidentId: typeof item?.communicationIncidentId === "string" ? item.communicationIncidentId : null,
  };
}

function clock(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(timestamp);
}

export function ScadaPage({ simulation, operationalResponse, onIncidentActivate }: ScadaPageProps) {
  const [lineCode, setLineCode] = useState<NativeLineCode>("M14");
  const line = NATIVE_LINES.find((candidate) => candidate.code === lineCode) ?? NATIVE_LINES[0]!;
  const evidence = lineEvidence(operationalResponse, line.code, simulation.timestamp);
  const telemetryAvailable = (["M1", "M4", "M14", "RER_A"] as readonly NativeLineCode[]).includes(line.code);
  const communicationsIncidents = useMemo(() => simulation.incidents.filter((incident) =>
    incident.lineCode === line.code && incident.status === "active" &&
    (String(incident.type).includes("communication") || String(incident.effect).includes("communication"))),
  [line.code, simulation.incidents]);
  const activeIncidentId = evidence.communicationIncidentId ?? communicationsIncidents[0]?.id ?? null;
  const activeIncident = communicationsIncidents.find((incident) => incident.id === activeIncidentId) ?? communicationsIncidents[0] ?? null;
  const nodeStatus = activeIncidentId ? (evidence.status === "online" ? "degraded" : evidence.status) : evidence.status;
  const totalLoss = activeIncident?.effect === "communication-loss" || nodeStatus === "offline";
  const fieldStatus: SystemStatus = activeIncident ? "online" : nodeStatus;
  const fieldLinkStatus: SystemStatus = totalLoss ? "offline" : activeIncident ? "degraded" : nodeStatus;
  const atsStatus: SystemStatus = totalLoss ? "offline" : activeIncident ? "degraded" : nodeStatus;
  const passengerLinkStatus: SystemStatus = activeIncident ? (totalLoss ? "offline" : "degraded") : nodeStatus;
  const passengerStatus: SystemStatus = totalLoss ? "degraded" : activeIncident ? "degraded" : nodeStatus;
  const responseRoot = responseRecord(operationalResponse);
  const maintenance = (Array.isArray(responseRoot?.dispatches) ? responseRoot.dispatches : [])
    .map(responseRecord)
    .find((dispatch) => dispatch?.incidentId === activeIncidentId);

  const nodes = [
    { id: "signalling", eyebrow: "FIELD", title: "Signalling posts", detail: "Detection, route and interlocking status", icon: "network" as const, status: fieldStatus },
    { id: "traction", eyebrow: "FIELD", title: "Traction posts", detail: "Substations, breakers and section state", icon: "bolt" as const, status: fieldStatus },
    ...(telemetryAvailable ? [{ id: "trains", eyebrow: "ON-BOARD", title: "Train telemetry", detail: "Mission, discrete occupation and equipment state", icon: "train" as const, status: fieldStatus }] : []),
  ];

  return (
    <div className="page operational-system-page" id="text-text-scada-page">
      <PageHeader
        contentId="text-text-scada-header"
        eyebrow="SYSTEMS SUPERVISION"
        title="SCADA & information architecture"
        description="Line-by-line view of the field, supervision and passenger-information chain. Communication failures are qualified as operational incidents and handled through cited procedures."
      />

      <nav className="line-tab-strip" id="text-text-scada-line-tabs" aria-label="SCADA line selection">
        {NATIVE_LINES.map((candidate) => (
          <button key={candidate.code} type="button" className={candidate.code === line.code ? "active" : ""}
            style={{ borderColor: candidate.code === line.code ? candidate.color : undefined }}
            onClick={() => setLineCode(candidate.code)}>
            <span style={{ color: candidate.color }}>{candidate.label}</span>{candidate.name}
          </button>
        ))}
      </nav>

      <section className="system-summary-grid" id="text-text-scada-summary">
        <article><small>LINE</small><strong>{line.name}</strong><span>{line.stationCodes.length} stations · {line.interstationIds.length} interstations</span></article>
        <article><small>CHAIN STATUS</small><strong className={`tone-${nodeStatus}`}>{nodeStatus}</strong><span>Last heartbeat {clock(evidence.lastHeartbeatAt)}</span></article>
        <article><small>ACTIVE COMMS INCIDENT</small><strong>{activeIncidentId ?? "None"}</strong><span>{activeIncidentId ? "Procedure and maintenance decision required" : "All supervised links responding"}</span></article>
        <article><small>TRAIN TELEMETRY</small><strong>{telemetryAvailable ? "Integrated" : "ATS aggregate"}</strong><span>{telemetryAvailable ? "L1 / L4 / L14 / RER A detailed feed" : "Line-level supervision evidence"}</span></article>
      </section>

      <section className="panel scada-workspace" id="text-text-scada-architecture">
        <header className="panel__header"><div><span className="panel__eyebrow">MACRO ARCHITECTURE · {line.label}</span><h2>Operational information chain</h2></div><span className={`system-status system-status--${nodeStatus}`}>{nodeStatus}</span></header>
        <div className="scada-chain">
          <div className="scada-chain__sources">
            {nodes.filter((node) => ["signalling", "traction", "trains"].includes(node.id)).map((node) => (
              <article className={`system-node system-node--${node.status}`} key={node.id}>
                <Icon name={node.icon} size={24}/><small>{node.eyebrow}</small><strong>{node.title}</strong><p>{node.detail}</p><span>{node.status}</span>
              </article>
            ))}
          </div>
          <div className={`system-link system-link--${fieldLinkStatus}`} data-system-link="field-to-ats"><span>secured operational feeds · {fieldLinkStatus}</span><Icon name="arrow" size={23}/></div>
          <article className={`system-node system-node--primary system-node--${atsStatus}`}>
            <Icon name="activity" size={28}/><small>SUPERVISION</small><strong>ATS / line supervision</strong><p>Consolidated movement authority, traffic state, alarms and regulation context.</p><span>{atsStatus}</span>
          </article>
          <div className={`system-link system-link--${passengerLinkStatus}`} data-system-link="ats-to-passenger-information"><span>service state & disruption messages · {passengerLinkStatus}</span><Icon name="arrow" size={23}/></div>
          <article className={`system-node system-node--${passengerStatus}`}>
            <Icon name="radio" size={24}/><small>DOWNSTREAM</small><strong>Passenger information</strong><p>Station displays, public address and connected information channels.</p><span>{passengerStatus}</span>
          </article>
        </div>
      </section>

      <section className="panel operational-alert-panel" id="text-text-scada-incidents">
        <header className="panel__header"><div><span className="panel__eyebrow">COMMUNICATION INCIDENTS</span><h2>Procedure-bound response</h2></div></header>
        {activeIncidentId ? (
          <div className="operational-alert">
            <Icon name="alert" size={26}/><div><strong>{totalLoss ? "Supervision link unavailable" : "Supervision link degraded"} on {line.name}</strong><p>{totalLoss ? "Field → ATS communication is unavailable" : "ATS → passenger-information exchange is degraded"}. Protect the operating scope, preserve the last trusted evidence and restore the end-to-end chain before closure.</p><code>{activeIncidentId} · maintenance {typeof maintenance?.status === "string" ? maintenance.status : "proposal pending"}</code></div>
            <button className="button button--primary" type="button" onClick={() => onIncidentActivate(activeIncidentId)}>Open incident procedure</button>
          </div>
        ) : <div className="operational-empty"><Icon name="shield" size={25}/><strong>No active communication incident on this line</strong><span>The end-to-end supervision chain is currently available.</span></div>}
      </section>
    </div>
  );
}
