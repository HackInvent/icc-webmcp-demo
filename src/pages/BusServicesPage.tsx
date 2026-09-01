import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { NATIVE_LINE_BY_CODE, NATIVE_STATION_BY_CODE, type NativeLineCode } from "../rail/nativeNetwork";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import { RAIL_GRAPH_STATIONS } from "../rail/interdependenceGraph";

interface BusServicesPageProps {
  simulation: NativeSimulationSnapshot;
  operationalResponse?: unknown;
  onIncidentActivate: (incidentId: string) => void;
}

interface BusView {
  id: string;
  incidentId: string;
  lineCode: NativeLineCode;
  fromStationCode: string;
  toStationCode: string;
  status: string;
  fleetSize: number;
  headwaySeconds: number;
  capacityPerHour: number;
  activatedAt: number | null;
  currentLeg: 0 | 1;
  cyclePhase: string;
  nextTransitionAt: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function number(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function stationName(code: string): string { return RAIL_GRAPH_STATIONS.find((station) => station.id === code)?.name ?? NATIVE_STATION_BY_CODE.get(code)?.name ?? code; }

function responseCases(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  return (Array.isArray(root?.incidentCases) ? root.incidentCases : []).map(record).filter(Boolean) as Record<string, unknown>[];
}

function busesFrom(value: unknown): BusView[] {
  const root = record(value);
  const cases = responseCases(value);
  const measures = Array.isArray(root?.continuityMeasures) ? root.continuityMeasures : [];
  const buses: BusView[] = [];
  for (const raw of measures) {
    const measure = record(raw);
    if (!measure || (measure.kind !== "shuttle-bus" && measure.kind !== "bus-bridge")) continue;
    const incidentId = text(measure.incidentId);
    const incidentCase = cases.find((item) => text(item.incidentId) === incidentId);
    const plan = record(measure.plan);
    const cycle = record(plan?.cycle);
    const plannedTermini = Array.isArray(plan?.terminusStationIds) ? plan.terminusStationIds : [];
    const stationIds = (plannedTermini.length >= 2
      ? plannedTermini
      : Array.isArray(measure.stationIds)
        ? measure.stationIds
        : Array.isArray(incidentCase?.terminalStationIds)
          ? incidentCase.terminalStationIds
          : []).filter((entry): entry is string => typeof entry === "string");
    const lineCodes = (Array.isArray(measure.lineCodes) ? measure.lineCodes : Array.isArray(incidentCase?.lineCodes) ? incidentCase.lineCodes : [])
      .filter((entry): entry is string => typeof entry === "string");
    const from = text(measure.fromStationCode, stationIds[0] ?? "");
    const to = text(measure.toStationCode, stationIds[1] ?? stationIds.at(-1) ?? from);
    const approvedAt = typeof measure.approvedAt === "number" ? measure.approvedAt : typeof measure.activatedAt === "number" ? measure.activatedAt : null;
    const headwaySeconds = Math.max(60, number(plan?.headwaySeconds, number(measure.headwaySeconds, 600)));
    const fleetSize = Math.max(1, number(plan?.fleetSize, number(measure.fleetSize, 4)));
    const cycleDirection = text(cycle?.direction);
    const cyclePhase = text(cycle?.phase, approvedAt === null ? "awaiting-approval" : "outbound");
    buses.push({
      id: text(measure.measureId, text(measure.id, `BUS-${incidentId}`)),
      incidentId,
      lineCode: text(measure.lineCode, lineCodes[0] ?? "RER_A") as NativeLineCode,
      fromStationCode: from,
      toStationCode: to,
      status: text(measure.status, "proposed"),
      fleetSize,
      headwaySeconds,
      capacityPerHour: Math.max(0, number(plan?.capacityPerHour, number(measure.capacityPerHour, Math.round(fleetSize * 80 * 3_600 / headwaySeconds)))),
      activatedAt: approvedAt,
      currentLeg: cycleDirection === "inbound" || cyclePhase === "at-destination" ? 1 : 0,
      cyclePhase,
      nextTransitionAt: typeof cycle?.nextTransitionAt === "number" ? cycle.nextTransitionAt : null,
    });
  }
  return buses;
}



function time(value: number | null): string {
  if (value === null) return "Awaiting activation";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

export function BusServicesPage({ simulation, operationalResponse, onIncidentActivate }: BusServicesPageProps) {
  const buses = busesFrom(operationalResponse);
  const cases = responseCases(operationalResponse);
  const eligibleCases = cases.filter((item) => {
    const duration = record(item.predictedDuration);
    const milestones = Array.isArray(item.milestones) ? item.milestones.map(record).filter(Boolean) as Record<string, unknown>[] : [];
    const shuttleMilestone = milestones.find((milestone) => milestone.code === "shuttle-bus");
    const incidentId = text(item.incidentId);
    return (number(duration?.nominalSeconds) > 3_600 || shuttleMilestone?.status === "due") && !buses.some((bus) => bus.incidentId === incidentId);
  });
  const active = buses.filter((bus) => bus.status === "active" || bus.status === "running");
  const totalFleet = active.reduce((sum, bus) => sum + bus.fleetSize, 0);
  const totalCapacity = active.reduce((sum, bus) => sum + bus.capacityPerHour, 0);

  return (
    <div className="page operational-system-page" id="text-text-bus-services-page">
      <PageHeader contentId="text-text-bus-services-header" eyebrow="SERVICE CONTINUITY" title="Bus shuttle operations"
        description="Operator-approved replacement services for incidents whose expected resolution exceeds one hour. Every service remains linked to its incident, procedure and persistent operational receipt."
        actions={<span className="system-status system-status--online">Operational time · {time(simulation.timestamp)}</span>} />
      <section className="system-summary-grid" id="text-text-bus-services-summary">
        <article><small>ACTIVE SERVICES</small><strong>{active.length}</strong><span>{buses.length} planned or recorded services</span></article>
        <article><small>VEHICLES IN SERVICE</small><strong>{totalFleet}</strong><span>Round-trip shuttle fleet</span></article>
        <article><small>PLANNED CAPACITY</small><strong>{totalCapacity.toLocaleString("en-GB")}/h</strong><span>Planning estimate across active routes</span></article>
        <article><small>PROPOSALS DUE</small><strong>{eligibleCases.length}</strong><span>Expected recovery above 60 minutes</span></article>
      </section>

      <section className="bus-service-grid" id="text-text-bus-services-list">
        {buses.map((bus) => {
          const line = NATIVE_LINE_BY_CODE.get(bus.lineCode);
          const outward = bus.currentLeg === 0;
          return <article className="panel bus-service-card" key={bus.id}>
            <header><div><small>{bus.id} · INCIDENT {bus.incidentId}</small><strong>{line?.name ?? bus.lineCode} replacement service</strong></div><span className={`system-status system-status--${bus.status === "active" || bus.status === "running" ? "online" : "recovering"}`}>{bus.status}</span></header>
            <div className="bus-service-route">
              <div><i style={{ background: line?.color }}/><strong>{stationName(bus.fromStationCode)}</strong><small>Temporary terminus A</small></div>
              <div className="bus-service-route__leg"><Icon name="bus" size={25}/><span>{bus.cyclePhase === "awaiting-approval" ? "READY" : outward ? "OUTBOUND" : "RETURN"}</span><b>↔</b><small>{bus.cyclePhase.replaceAll("-", " ")}</small></div>
              <div><i style={{ background: line?.color }}/><strong>{stationName(bus.toStationCode)}</strong><small>Temporary terminus B</small></div>
            </div>
            <dl className="bus-service-facts"><div><dt>Fleet</dt><dd>{bus.fleetSize} buses</dd></div><div><dt>Headway</dt><dd>{Math.round(bus.headwaySeconds / 60)} min</dd></div><div><dt>Capacity</dt><dd>{bus.capacityPerHour || "—"} pax/h</dd></div><div><dt>Activated</dt><dd>{time(bus.activatedAt)}</dd></div><div><dt>Next discrete state</dt><dd>{time(bus.nextTransitionAt)}</dd></div></dl>
            <footer><span><Icon name="shield" size={15}/> Persistent service linked to the incident procedure</span><button type="button" className="button button--secondary" onClick={() => onIncidentActivate(bus.incidentId)}>Open incident</button></footer>
          </article>;
        })}
      </section>

      {buses.length === 0 && <section className="panel operational-empty"><Icon name="bus" size={30}/><strong>No shuttle service is active</strong><span>When an incident exceeds the 60-minute planning threshold, the agent proposes a procedure-bound deployment for operator approval.</span></section>}

      {eligibleCases.length > 0 && <section className="panel operational-alert-panel bus-proposals" id="text-text-bus-service-proposals"><header className="panel__header"><div><span className="panel__eyebrow">AGENT ESCALATION · T+60</span><h2>Bus bridge proposals awaiting operator review</h2></div></header>{eligibleCases.map((item) => { const incidentId=text(item.incidentId); return <div className="operational-alert" key={incidentId}><Icon name="bus" size={25}/><div><strong>{incidentId}</strong><p>The current procedure estimate exceeds one hour. Review route endpoints, fleet and passenger connections before deployment.</p></div><button type="button" className="button button--primary" onClick={() => onIncidentActivate(incidentId)}>Review in incident workflow</button></div>; })}</section>}
      <p className="planning-disclaimer">Vehicle counts and capacity are operational planning estimates for the demo; no road fleet dispatch system is contacted.</p>
    </div>
  );
}
