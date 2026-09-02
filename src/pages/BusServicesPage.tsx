import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import {
  NATIVE_INTERSTATION_BY_ID,
  NATIVE_LINE_BY_CODE,
  NATIVE_LINES,
  NATIVE_STATION_BY_CODE,
  type NativeLineCode,
} from "../rail/nativeNetwork";
import {
  NATIVE_SHUTTLE_CAPACITY_PASSENGERS,
  NATIVE_SHUTTLE_SPEED_KMH,
  nativeShuttleDestinationOptions,
  nativeShuttleStationOptions,
  type NativeShuttleInsertionInput,
  type NativeShuttleInsertionReceipt,
  type NativeShuttleState,
  type NativeSimulationSnapshot,
} from "../rail/nativeSimulation";
import { RAIL_GRAPH_STATIONS } from "../rail/interdependenceGraph";

interface BusServicesPageProps {
  simulation: NativeSimulationSnapshot;
  operationalResponse?: unknown;
  onIncidentActivate: (incidentId: string) => void;
  onInsertShuttle: (input: NativeShuttleInsertionInput) =>
    NativeShuttleInsertionReceipt | Promise<NativeShuttleInsertionReceipt>;
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

const DEFAULT_SHUTTLE_LINE: NativeLineCode = "RER_A";
const DEFAULT_SHUTTLE_DEPARTURE = nativeShuttleStationOptions(DEFAULT_SHUTTLE_LINE)[0]?.stationId ?? "";
const DEFAULT_SHUTTLE_ARRIVAL = nativeShuttleDestinationOptions(
  DEFAULT_SHUTTLE_LINE,
  DEFAULT_SHUTTLE_DEPARTURE,
)[0]?.stationId ?? "";

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

function shuttleLocation(shuttle: NativeShuttleState): { title: string; detail: string } {
  if (shuttle.location.type === "station") {
    return {
      title: stationName(shuttle.location.id),
      detail: `Station dwell · ${shuttle.dwellTicks}s remaining`,
    };
  }
  const interstation = NATIVE_INTERSTATION_BY_ID.get(shuttle.location.id);
  const nextStationIndex = shuttle.stationIndex + shuttle.direction;
  const fromStationId = shuttle.routeStationIds[shuttle.stationIndex];
  const toStationId = shuttle.routeStationIds[nextStationIndex];
  return {
    title: interstation
      ? `${stationName(interstation.fromStationCode)} — ${stationName(interstation.toStationCode)}`
      : `${stationName(fromStationId)} — ${stationName(toStationId)}`,
    detail: `Road leg · ${shuttle.travelTicksRemaining}s remaining`,
  };
}

export function BusServicesPage({
  simulation,
  operationalResponse,
  onIncidentActivate,
  onInsertShuttle,
}: BusServicesPageProps) {
  const [shuttleLine, setShuttleLine] = useState<NativeLineCode>(DEFAULT_SHUTTLE_LINE);
  const [departureStationId, setDepartureStationId] = useState(DEFAULT_SHUTTLE_DEPARTURE);
  const [arrivalStationId, setArrivalStationId] = useState(DEFAULT_SHUTTLE_ARRIVAL);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderStatus, setOrderStatus] = useState<{ tone: "ok" | "danger"; message: string } | null>(null);
  const departureOptions = useMemo(
    () => nativeShuttleStationOptions(shuttleLine),
    [shuttleLine],
  );
  const arrivalOptions = useMemo(
    () => nativeShuttleDestinationOptions(shuttleLine, departureStationId),
    [departureStationId, shuttleLine],
  );
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
  const shuttles = simulation.shuttles;

  const selectLine = (lineCode: NativeLineCode) => {
    const departures = nativeShuttleStationOptions(lineCode);
    const departure = departures[0]?.stationId ?? "";
    const arrival = nativeShuttleDestinationOptions(lineCode, departure)[0]?.stationId ?? "";
    setShuttleLine(lineCode);
    setDepartureStationId(departure);
    setArrivalStationId(arrival);
    setOrderStatus(null);
  };

  const selectDeparture = (stationId: string) => {
    const arrivals = nativeShuttleDestinationOptions(shuttleLine, stationId);
    setDepartureStationId(stationId);
    setArrivalStationId(arrivals[0]?.stationId ?? "");
    setOrderStatus(null);
  };

  const orderShuttle = async () => {
    if (!departureStationId || !arrivalStationId || orderBusy) return;
    setOrderBusy(true);
    setOrderStatus(null);
    try {
      const receipt = await onInsertShuttle({
        lineCode: shuttleLine,
        departureStationId,
        arrivalStationId,
      });
      setOrderStatus({
        tone: "ok",
        message: `${receipt.shuttle.id} ordered from ${stationName(departureStationId)} to ${stationName(arrivalStationId)}. It is now boarding at the departure station.`,
      });
    } catch (error) {
      setOrderStatus({
        tone: "danger",
        message: error instanceof Error ? error.message : "The shuttle order could not be recorded.",
      });
    } finally {
      setOrderBusy(false);
    }
  };

  return (
    <div className="page operational-system-page" id="text-text-bus-services-page">
      <PageHeader contentId="text-text-bus-services-header" eyebrow="SERVICE CONTINUITY" title="Bus shuttle operations"
        description="Order a replacement shuttle directly between two stations on the same line, or monitor procedure-driven services proposed for long incidents. Manual shuttles are persisted and move through the operational model as discrete station/interstation objects."
        actions={<span className="system-status system-status--online">Operational time · {time(simulation.timestamp)}</span>} />
      <section className="system-summary-grid" id="text-text-bus-services-summary">
        <article><small>ACTIVE SERVICES</small><strong>{active.length + shuttles.length}</strong><span>{shuttles.length} manual · {buses.length} procedure-linked</span></article>
        <article><small>VEHICLES IN SERVICE</small><strong>{totalFleet + shuttles.length}</strong><span>Individual and planned fleet</span></article>
        <article><small>PLANNED CAPACITY</small><strong>{totalCapacity.toLocaleString("en-GB")}/h</strong><span>{(shuttles.length * NATIVE_SHUTTLE_CAPACITY_PASSENGERS).toLocaleString("en-GB")} manual seats in circulation</span></article>
        <article><small>PROPOSALS DUE</small><strong>{eligibleCases.length}</strong><span>Expected recovery above 60 minutes</span></article>
      </section>

      <section className="panel bus-order-panel" id="text-text-bus-shuttle-order" aria-labelledby="bus-shuttle-order-title">
        <header>
          <span className="bus-order-panel__icon"><Icon name="bus" size={22}/></span>
          <div>
            <span className="panel__eyebrow">MANUAL SERVICE CONTROL · OPERATOR</span>
            <h2 id="bus-shuttle-order-title">Order a shuttle</h2>
            <p>Select one line and two stations served by that same line. The authoritative simulator starts the vehicle at the departure station immediately after the command is recorded.</p>
          </div>
          <span className="system-status system-status--online">Ready</span>
        </header>
        <div className="bus-order-controls">
          <label>
            <span>Line</span>
            <select value={shuttleLine} onChange={(event) => selectLine(event.target.value as NativeLineCode)} data-testid="bus-shuttle-line">
              {NATIVE_LINES.map((line) => <option key={line.code} value={line.code}>{line.label} · {line.name}</option>)}
            </select>
          </label>
          <label>
            <span>Departure station</span>
            <select value={departureStationId} onChange={(event) => selectDeparture(event.target.value)} data-testid="bus-shuttle-departure">
              {departureOptions.map((station) => <option key={station.stationId} value={station.stationId}>{station.name}</option>)}
            </select>
          </label>
          <label>
            <span>Arrival station</span>
            <select value={arrivalStationId} onChange={(event) => { setArrivalStationId(event.target.value); setOrderStatus(null); }} data-testid="bus-shuttle-arrival">
              {arrivalOptions.map((station) => <option key={station.stationId} value={station.stationId}>{station.name}</option>)}
            </select>
          </label>
          <button type="button" className="button button--primary" onClick={() => void orderShuttle()} disabled={orderBusy || !arrivalStationId} data-testid="bus-shuttle-order-button">
            <Icon name="bus" size={16}/>{orderBusy ? "Recording order…" : "Order shuttle"}
          </button>
        </div>
        <div className="bus-order-parameters" aria-label="Fixed shuttle operating parameters">
          <span><small>Nominal speed</small><strong>{NATIVE_SHUTTLE_SPEED_KMH} km/h</strong></span>
          <span><small>Vehicle capacity</small><strong>{NATIVE_SHUTTLE_CAPACITY_PASSENGERS} passengers</strong></span>
          <span><small>Station dwell</small><strong>20 seconds</strong></span>
          <span><small>Movement model</small><strong>Discrete station / interstation</strong></span>
        </div>
        {orderStatus && <div className={`bus-order-status bus-order-status--${orderStatus.tone}`} role={orderStatus.tone === "danger" ? "alert" : "status"}><Icon name={orderStatus.tone === "danger" ? "alert" : "shield"} size={16}/><span>{orderStatus.message}</span></div>}
      </section>

      <section className="bus-service-grid" id="text-text-bus-services-list">
        {shuttles.map((shuttle) => {
          const line = NATIVE_LINE_BY_CODE.get(shuttle.lineCode);
          const location = shuttleLocation(shuttle);
          const oneWayMinutes = Math.ceil((
            shuttle.routeTravelTicks.reduce((total, ticks) => total + ticks, 0) +
            Math.max(0, shuttle.routeStationIds.length - 2) * 20
          ) / 60);
          return <article className="panel bus-service-card bus-service-card--manual" key={shuttle.id} data-shuttle-id={shuttle.id}>
            <header><div><small>{shuttle.id} · MANUAL OPERATOR ORDER</small><strong>{line?.name ?? shuttle.lineCode} shuttle</strong></div><span className="system-status system-status--online">{shuttle.status}</span></header>
            <div className="bus-service-route">
              <div><i style={{ background: line?.color }}/><strong>{stationName(shuttle.departureStationId)}</strong><small>Departure terminus</small></div>
              <div className="bus-service-route__leg"><Icon name="bus" size={25}/><span>{shuttle.direction === 1 ? "OUTBOUND" : "RETURN"}</span><b>↔</b><small>{location.title}</small></div>
              <div><i style={{ background: line?.color }}/><strong>{stationName(shuttle.arrivalStationId)}</strong><small>Arrival terminus</small></div>
            </div>
            <div className="bus-current-location"><Icon name={shuttle.location.type === "station" ? "pin" : "network"} size={17}/><div><small>CURRENT DISCRETE POSITION</small><strong>{location.title}</strong><span>{location.detail}</span></div></div>
            <dl className="bus-service-facts bus-service-facts--manual"><div><dt>Speed</dt><dd>{shuttle.speedKmh} km/h <small>/ {shuttle.nominalSpeedKmh} nominal</small></dd></div><div><dt>Load</dt><dd>{shuttle.passengers} / {shuttle.capacityPassengers}</dd></div><div><dt>One-way estimate</dt><dd>{oneWayMinutes} min</dd></div><div><dt>Route</dt><dd>{(shuttle.routeDistanceMeters / 1_000).toFixed(1)} km · {shuttle.routeInterstationIds.length} legs</dd></div><div><dt>Ordered</dt><dd>{time(shuttle.startedAt)}</dd></div></dl>
            <footer><span><Icon name="shield" size={15}/> Persisted simulator object · passenger exchange enabled</span><span className="bus-manual-capacity">100 seats</span></footer>
          </article>;
        })}
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

      {buses.length === 0 && shuttles.length === 0 && <section className="panel operational-empty"><Icon name="bus" size={30}/><strong>No shuttle service is active</strong><span>Order one above, or review an agent proposal when an incident exceeds the 60-minute planning threshold.</span></section>}

      {eligibleCases.length > 0 && <section className="panel operational-alert-panel bus-proposals" id="text-text-bus-service-proposals"><header className="panel__header"><div><span className="panel__eyebrow">AGENT ESCALATION · T+60</span><h2>Bus bridge proposals awaiting operator review</h2></div></header>{eligibleCases.map((item) => { const incidentId=text(item.incidentId); return <div className="operational-alert" key={incidentId}><Icon name="bus" size={25}/><div><strong>{incidentId}</strong><p>The current procedure estimate exceeds one hour. Review route endpoints, fleet and passenger connections before deployment.</p></div><button type="button" className="button button--primary" onClick={() => onIncidentActivate(incidentId)}>Review in incident workflow</button></div>; })}</section>}
      <p className="planning-disclaimer">Manual shuttle movement and passenger exchange are generated by the local operational simulator. No external road fleet dispatch system is contacted.</p>
    </div>
  );
}
