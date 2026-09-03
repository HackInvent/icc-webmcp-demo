import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { StatusPill } from "../components/StatusPill";
import { SimulatorIncidentModal } from "../components/SimulatorIncidentModal";
import { nativeIncidentPath, navigate } from "../navigation";
import { buildPassengerFlowView } from "../passenger/passengerFlowModel";
import type { EntitySelection, Incident, RailSnapshot } from "../rail/domain";
import {
  NATIVE_INTERSTATIONS,
  NATIVE_INTERSTATION_BY_ID,
  NATIVE_LINES,
  NATIVE_LINE_BY_CODE,
  NATIVE_STATIONS,
  NATIVE_STATION_BY_CODE,
  type NativeLineCode,
} from "../rail/nativeNetwork";
import {
  NATIVE_SIMULATION_STEP_MS,
  nativeAvailableOperatorTrainInsertionOptions,
  nativeOperatorTrainInsertionOptions,
  type NativeIncident,
  type NativeShuttleState,
  type NativeSimulationSnapshot,
  type NativeTrainInsertionInput,
  type NativeTrainInsertionReceipt,
  type NativeTrainState,
} from "../rail/nativeSimulation";
import type { SimulatorIncidentCreationResult, SimulatorIncidentDraft } from "../rail/simulatorIncident";
import { getReferenceCapacity } from "../rail/rollingStock";
import {
  effectivePassengerArrivalRate,
  formatParisOperationalTime,
  isPassengerDemandActive,
  PASSENGER_DEMAND_PAUSE_LABEL,
} from "../rail/operationalTime";
import { formatDelay } from "../utils";

interface SimulatorPageProps {
  snapshot: RailSnapshot;
  nativeSimulation: NativeSimulationSnapshot;
  onSelect: (selection: EntitySelection) => void;
  onCreateIncident: (draft: SimulatorIncidentDraft) =>
    SimulatorIncidentCreationResult | Promise<SimulatorIncidentCreationResult>;
  onInsertTrain: (input: NativeTrainInsertionInput) =>
    NativeTrainInsertionReceipt | Promise<NativeTrainInsertionReceipt>;
}

type SimulatorTab =
  | "trains"
  | "shuttles"
  | "incidents"
  | "stations"
  | "interstations"
  | "power"
  | "circuits"
  | "drivers"
  | "events";

type SimulatorIncidentRow =
  | { source: "Native network"; incident: NativeIncident }
  | { source: "Detailed corridor"; incident: Incident };

const PAGE_SIZE = 50;
const DEFAULT_INSERTION_LINE: NativeLineCode = "RER_A";

const TABS: ReadonlyArray<{
  id: SimulatorTab;
  label: string;
  icon: "train" | "bus" | "alert" | "pin" | "network" | "bolt" | "panel" | "users" | "activity";
}> = [
  { id: "trains", label: "Trains", icon: "train" },
  { id: "shuttles", label: "Shuttles", icon: "bus" },
  { id: "incidents", label: "Incidents", icon: "alert" },
  { id: "stations", label: "Stations", icon: "pin" },
  { id: "interstations", label: "Interstations", icon: "network" },
  { id: "power", label: "Power", icon: "bolt" },
  { id: "circuits", label: "Track circuits", icon: "panel" },
  { id: "drivers", label: "Drivers", icon: "users" },
  { id: "events", label: "Events", icon: "activity" },
];

function formatSimulationTime(timestamp: number): string {
  return formatParisOperationalTime(timestamp, true);
}

function lineTextColor(color: string): string {
  const value = color.replace("#", "");
  if (!/^[a-f\d]{6}$/i.test(value)) return "#ffffff";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 158 ? "#17302a" : "#ffffff";
}

function Lines({ codes }: { codes: readonly string[] }) {
  return (
    <span className="simulator-line-badges">
      {codes.map((code) => {
        const line = NATIVE_LINE_BY_CODE.get(code as NativeLineCode);
        const color = line?.color ?? "#60736d";
        return (
          <span key={code} style={{ background: color, color: lineTextColor(color) }}>
            {line?.label ?? code}
          </span>
        );
      })}
    </span>
  );
}

function stationName(code: string): string {
  return NATIVE_STATION_BY_CODE.get(code)?.name ?? code;
}

function trainLocation(train: NativeTrainState): { title: string; detail: string } {
  if (train.location.type === "station") {
    return {
      title: stationName(train.location.id),
      detail: "Station · " + train.location.id,
    };
  }
  const interstation = NATIVE_INTERSTATION_BY_ID.get(train.location.id);
  if (!interstation) {
    return { title: train.location.id, detail: "Interstation" };
  }
  return {
    title:
      stationName(interstation.fromStationCode) +
      " → " +
      stationName(interstation.toStationCode),
    detail: "Interstation · " + interstation.id,
  };
}

function shuttleLocation(shuttle: NativeShuttleState): { title: string; detail: string } {
  if (shuttle.location.type === "station") {
    return {
      title: stationName(shuttle.location.id),
      detail: `Station · ${shuttle.location.id}`,
    };
  }
  const interstation = NATIVE_INTERSTATION_BY_ID.get(shuttle.location.id);
  if (!interstation) {
    const nextStationIndex = shuttle.stationIndex + shuttle.direction;
    return {
      title: `${stationName(shuttle.routeStationIds[shuttle.stationIndex])} → ${stationName(shuttle.routeStationIds[nextStationIndex])}`,
      detail: `Contracted road leg · ${shuttle.location.id}`,
    };
  }
  return {
    title: `${stationName(interstation.fromStationCode)} → ${stationName(interstation.toStationCode)}`,
    detail: `Interstation · ${interstation.id}`,
  };
}

function matchesSearch(query: string, values: readonly unknown[]): boolean {
  if (!query) return true;
  return values
    .map((value) => Array.isArray(value) ? value.join(" ") : String(value ?? ""))
    .join(" ")
    .toLocaleLowerCase("en")
    .includes(query);
}

function trainTone(status: NativeTrainState["status"]): "ok" | "info" | "warning" | "danger" {
  if (status === "dwelling") return "ok";
  if (status === "held") return "warning";
  if (status === "stopped") return "danger";
  return "info";
}

function severityTone(severity: string): "ok" | "warning" | "danger" {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warning";
  return "ok";
}

function circuitTone(state: RailSnapshot["circuits"][number]["state"]): "ok" | "info" | "warning" | "danger" {
  if (state === "blocked") return "danger";
  if (state === "occupied") return "warning";
  if (state === "reserved") return "info";
  return "ok";
}

function EmptyRows() {
  return (
    <div className="simulator-empty">
      <Icon name="search" size={22} />
      <strong>No simulated object matches these filters</strong>
      <span>Clear the search or select another line.</span>
    </div>
  );
}

export function SimulatorPage({
  snapshot,
  nativeSimulation,
  onSelect,
  onCreateIncident,
  onInsertTrain,
}: SimulatorPageProps) {
  const [activeTab, setActiveTab] = useState<SimulatorTab>("trains");
  const [search, setSearch] = useState("");
  const [line, setLine] = useState<NativeLineCode | "ALL">("ALL");
  const [pageIndex, setPageIndex] = useState(0);
  const [incidentModalOpen, setIncidentModalOpen] = useState(false);
  const defaultInsertion = nativeOperatorTrainInsertionOptions(DEFAULT_INSERTION_LINE)[0];
  const [insertionLine, setInsertionLine] = useState<NativeLineCode>(DEFAULT_INSERTION_LINE);
  const [insertionStationId, setInsertionStationId] = useState(defaultInsertion?.stationId ?? "");
  const [insertionDirection, setInsertionDirection] = useState<1 | -1>(defaultInsertion?.direction ?? 1);
  const [insertionBusy, setInsertionBusy] = useState(false);
  const [insertionStatus, setInsertionStatus] = useState<{
    tone: "ok" | "danger";
    message: string;
  } | null>(null);
  const [operationStatus, setOperationStatus] = useState<{
    tone: "ok" | "danger";
    message: string;
  } | null>(null);
  const normalizedSearch = search.trim().toLocaleLowerCase("en");
  const insertionOptions = useMemo(
    () => nativeAvailableOperatorTrainInsertionOptions(insertionLine, nativeSimulation.trains),
    [insertionLine, nativeSimulation.trains],
  );
  const insertionStations = useMemo(() => [...new Map(insertionOptions.map((option) => [
    option.stationId,
    { id: option.stationId, name: stationName(option.stationId) },
  ])).values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
  [insertionOptions]);
  const insertionDirections = insertionOptions.filter((option) => option.stationId === insertionStationId);
  const selectedInsertion = insertionDirections.find((option) => option.direction === insertionDirection) ?? null;
  const passengerFlowSummary = useMemo(
    () => buildPassengerFlowView(nativeSimulation, snapshot),
    [nativeSimulation, snapshot],
  );

  const indexes = useMemo(() => {
    const trainsByLocation = new Map<string, string[]>();
    const incidentsByStation = new Map<string, string[]>();
    const incidentsByInterstation = new Map<string, string[]>();
    const restrictionsByInterstation = new Map(
      nativeSimulation.restrictions.map((restriction) => [restriction.interstationId, restriction]),
    );
    const append = (map: Map<string, string[]>, key: string, value: string) => {
      map.set(key, [...(map.get(key) ?? []), value]);
    };
    nativeSimulation.trains.forEach((train) => {
      append(trainsByLocation, train.location.type + ":" + train.location.id, train.id);
    });
    nativeSimulation.incidents
      .filter((incident) => incident.status === "active")
      .forEach((incident) => {
        incident.affectedStationCodes.forEach((code) => append(incidentsByStation, code, incident.id));
        incident.affectedInterstationIds.forEach((id) => append(incidentsByInterstation, id, incident.id));
      });
    return {
      trainsByLocation,
      incidentsByStation,
      incidentsByInterstation,
      restrictionsByInterstation,
    };
  }, [nativeSimulation.incidents, nativeSimulation.restrictions, nativeSimulation.trains]);

  const filtered = useMemo(() => {
    const lineMatches = (codes: readonly string[]) => line === "ALL" || codes.includes(line);
    const incidentRows: SimulatorIncidentRow[] = [
      ...nativeSimulation.incidents.map((incident) => ({
        source: "Native network" as const,
        incident,
      })),
      ...snapshot.incidents.map((incident) => ({
        source: "Detailed corridor" as const,
        incident,
      })),
    ];

    return {
      trains: [...nativeSimulation.trains]
        .filter((train) => lineMatches([train.lineCode]))
        .filter((train) => {
          const location = trainLocation(train);
          return matchesSearch(normalizedSearch, [
            train.id,
            train.circulationId,
            train.mission,
            train.driverId,
            train.lineCode,
            train.status,
            location.title,
            location.detail,
            train.originStationCode,
            train.destinationStationCode,
          ]);
        })
        .sort((left, right) => left.lineCode.localeCompare(right.lineCode) || left.id.localeCompare(right.id)),
      shuttles: [...nativeSimulation.shuttles]
        .filter((shuttle) => lineMatches([shuttle.lineCode]))
        .filter((shuttle) => {
          const location = shuttleLocation(shuttle);
          return matchesSearch(normalizedSearch, [
            shuttle.id,
            shuttle.lineCode,
            shuttle.status,
            shuttle.departureStationId,
            shuttle.arrivalStationId,
            location.title,
            location.detail,
          ]);
        })
        .sort((left, right) => left.lineCode.localeCompare(right.lineCode) || left.id.localeCompare(right.id)),
      incidents: incidentRows
        .filter((row) => lineMatches(
          row.source === "Native network" ? [row.incident.lineCode] : row.incident.lineIds,
        ))
        .filter((row) => matchesSearch(normalizedSearch, [
          row.source,
          row.incident.id,
          row.incident.incidentCode,
          row.incident.title,
          row.incident.type,
          row.incident.severity,
          row.incident.status,
          row.incident.location,
          row.incident.owner,
          row.incident.summary,
        ]))
        .sort((left, right) => {
          const leftActive = left.incident.status === "active" ? 0 : 1;
          const rightActive = right.incident.status === "active" ? 0 : 1;
          return leftActive - rightActive || left.incident.id.localeCompare(right.incident.id);
        }),
      stations: [...NATIVE_STATIONS]
        .filter((station) => lineMatches(station.lines))
        .filter((station) => matchesSearch(normalizedSearch, [
          station.code,
          station.id,
          station.svgId,
          station.name,
          station.lines,
          indexes.trainsByLocation.get("station:" + station.code),
          indexes.incidentsByStation.get(station.code),
        ]))
        .sort((left, right) => left.name.localeCompare(right.name)),
      interstations: [...NATIVE_INTERSTATIONS]
        .filter((interstation) => lineMatches([interstation.lineCode]))
        .filter((interstation) => matchesSearch(normalizedSearch, [
          interstation.id,
          interstation.svgId,
          interstation.lineCode,
          stationName(interstation.fromStationCode),
          stationName(interstation.toStationCode),
          indexes.trainsByLocation.get("interstation:" + interstation.id),
          indexes.incidentsByInterstation.get(interstation.id),
          indexes.restrictionsByInterstation.get(interstation.id)?.mode,
        ]))
        .sort((left, right) => left.lineCode.localeCompare(right.lineCode) || left.id.localeCompare(right.id)),
      power: [...snapshot.powerSections]
        .filter((section) => lineMatches(section.lineIds))
        .filter((section) => matchesSearch(normalizedSearch, [
          section.id,
          section.name,
          section.lineIds,
          section.status,
          section.substation,
          section.circuitIds,
        ]))
        .sort((left, right) => left.id.localeCompare(right.id)),
      circuits: [...snapshot.circuits]
        .filter((circuit) => lineMatches([circuit.lineId]))
        .filter((circuit) => matchesSearch(normalizedSearch, [
          circuit.id,
          circuit.label,
          circuit.lineId,
          circuit.fromStation,
          circuit.toStation,
          circuit.state,
          circuit.occupiedBy,
          circuit.reservedBy,
          circuit.electricalSectionId,
          circuit.closure?.reason,
        ]))
        .sort((left, right) => left.lineId.localeCompare(right.lineId) || left.segmentIndex - right.segmentIndex),
      drivers: [...nativeSimulation.trains]
        .filter((train) => train.driverId !== null)
        .filter((train) => lineMatches([train.lineCode]))
        .filter((train) => matchesSearch(normalizedSearch, [
          train.driverId,
          train.id,
          train.circulationId,
          train.mission,
          train.lineCode,
          train.status,
        ]))
        .sort((left, right) => left.lineCode.localeCompare(right.lineCode) || left.id.localeCompare(right.id)),
      events: [...snapshot.events]
        .filter((event) => matchesSearch(normalizedSearch, [
          event.id,
          event.kind,
          event.title,
          event.detail,
          event.severity,
        ]))
        .sort((left, right) => right.timestamp - left.timestamp),
    };
  }, [
    indexes,
    line,
    nativeSimulation.incidents,
    nativeSimulation.shuttles,
    nativeSimulation.trains,
    normalizedSearch,
    snapshot.circuits,
    snapshot.events,
    snapshot.incidents,
    snapshot.powerSections,
  ]);

  const selectInsertionLine = (nextLine: NativeLineCode) => {
    const first = nativeAvailableOperatorTrainInsertionOptions(nextLine, nativeSimulation.trains)[0];
    setInsertionLine(nextLine);
    setInsertionStationId(first?.stationId ?? "");
    setInsertionDirection(first?.direction ?? 1);
    setInsertionStatus(null);
  };

  const selectInsertionStation = (stationId: string) => {
    const directions = insertionOptions.filter((option) => option.stationId === stationId);
    const retained = directions.find((option) => option.direction === insertionDirection);
    setInsertionStationId(stationId);
    setInsertionDirection(retained?.direction ?? directions[0]?.direction ?? 1);
    setInsertionStatus(null);
  };

  const insertTrain = async () => {
    if (!selectedInsertion || insertionBusy) return;
    setInsertionBusy(true);
    setInsertionStatus(null);
    try {
      const receipt = await onInsertTrain({
        lineCode: insertionLine,
        stationId: selectedInsertion.stationId,
        direction: selectedInsertion.direction,
      });
      setInsertionStatus({
        tone: "ok",
        message: `${receipt.train.id} inserted at ${stationName(receipt.stationId)}, ${receipt.direction === 1 ? "outbound" : "inbound"}; +${receipt.capacityDeltaPassengers.toLocaleString("en-GB")} reference places.`,
      });
      setActiveTab("trains");
      setLine(insertionLine);
      setPageIndex(0);
    } catch (error) {
      setInsertionStatus({
        tone: "danger",
        message: error instanceof Error ? error.message : "The reinforcement train could not be inserted.",
      });
    } finally {
      setInsertionBusy(false);
    }
  };

  const counts: Record<SimulatorTab, number> = {
    trains: nativeSimulation.trains.length,
    shuttles: nativeSimulation.shuttles.length,
    incidents: nativeSimulation.incidents.length + snapshot.incidents.length,
    stations: NATIVE_STATIONS.length,
    interstations: NATIVE_INTERSTATIONS.length,
    power: snapshot.powerSections.length,
    circuits: snapshot.circuits.length,
    drivers: nativeSimulation.trains.filter((train) => train.driverId !== null).length,
    events: snapshot.events.length,
  };
  const filteredCount = filtered[activeTab].length;
  const pageCount = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));
  const pageStart = pageIndex * PAGE_SIZE;
  const pageEnd = Math.min(filteredCount, pageStart + PAGE_SIZE);
  const sliceRows = <T,>(rows: readonly T[]): readonly T[] => rows.slice(pageStart, pageEnd);

  useEffect(() => {
    setPageIndex(0);
  }, [activeTab, line, normalizedSearch]);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    if (selectedInsertion || insertionOptions.length === 0) return;
    const first = insertionOptions[0];
    setInsertionStationId(first.stationId);
    setInsertionDirection(first.direction);
    setInsertionStatus({
      tone: "danger",
      message: "The previously selected station is occupied. Select an unoccupied insertion station.",
    });
  }, [insertionOptions, selectedInsertion]);

  const createIncident = async (
    draft: SimulatorIncidentDraft,
  ): Promise<SimulatorIncidentCreationResult> => {
    const result = await onCreateIncident(draft);
    if (result.ok) {
      setActiveTab("incidents");
      setLine(draft.lineCode as NativeLineCode);
      setSearch(result.incidentId ?? "");
      setPageIndex(0);
      setOperationStatus({ tone: "ok", message: result.message });
    }
    return result;
  };
  let table: ReactNode;

  if (activeTab === "trains") {
    table = (
      <table className="data-table simulator-table simulator-table--trains">
        <caption className="sr-only">Complete native-network simulated train state</caption>
        <thead><tr>
          <th>Train</th><th>Line</th><th>Operational location</th><th>Next movement</th>
          <th>Driver</th><th>Status</th><th>Speed</th><th>Delay</th><th>Dwell remaining</th><th>Passengers</th><th>Quality</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.trains).map((train) => {
          const location = trainLocation(train);
          return (
            <tr key={train.id}>
              <td><strong>{train.id}</strong><small className="cell-sub">{train.circulationId} · {train.mission}</small></td>
              <td><Lines codes={[train.lineCode]} /></td>
              <td><strong>{location.title}</strong><small className="cell-sub" title={location.detail}>{location.detail}</small></td>
              <td><strong>{stationName(train.nextStationCode)}</strong><small className="cell-sub">Direction {train.direction === 1 ? "outbound" : "inbound"}</small></td>
              <td>
                <strong>{train.driverId ?? "Automatic"}</strong>
                <small className="cell-sub">{train.driverId ? "One driver assigned" : "Driverless operation"}</small>
              </td>
              <td><StatusPill tone={trainTone(train.status)}>{train.status}</StatusPill></td>
              <td><strong>{Math.round(train.speedKmh)} km/h</strong></td>
              <td><strong>{formatDelay(train.delaySeconds)}</strong></td>
              <td><strong>{train.location.type === "station" ? train.dwellTicks * NATIVE_SIMULATION_STEP_MS / 1_000 + " s" : "—"}</strong></td>
              <td>
                <strong>{train.passengers.toLocaleString("en-GB")} / {getReferenceCapacity(train.lineCode).toLocaleString("en-GB")}</strong>
                <small className="cell-sub">{Math.round(train.passengers / getReferenceCapacity(train.lineCode) * 100)}% reference load</small>
              </td>
              <td><StatusPill tone="neutral">{train.quality}</StatusPill></td>
            </tr>
          );
        })}</tbody>
      </table>
    );
  } else if (activeTab === "shuttles") {
    table = (
      <table className="data-table simulator-table simulator-table--shuttles">
        <caption className="sr-only">All manually ordered shuttle simulator objects</caption>
        <thead><tr>
          <th>Shuttle</th><th>Line</th><th>Ordered route</th><th>Operational location</th>
          <th>Direction</th><th>Status</th><th>Speed</th><th>Next transition</th><th>Passengers</th><th>Distance</th><th>Quality</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.shuttles).map((shuttle) => {
          const location = shuttleLocation(shuttle);
          const transitionSeconds = shuttle.location.type === "station"
            ? shuttle.dwellTicks
            : shuttle.travelTicksRemaining;
          return (
            <tr key={shuttle.id}>
              <td><strong>{shuttle.id}</strong><small className="cell-sub">Ordered {formatSimulationTime(shuttle.startedAt)}</small></td>
              <td><Lines codes={[shuttle.lineCode]} /></td>
              <td><strong>{stationName(shuttle.departureStationId)} → {stationName(shuttle.arrivalStationId)}</strong><small className="cell-sub">{shuttle.routeInterstationIds.length} road legs</small></td>
              <td><strong>{location.title}</strong><small className="cell-sub" title={location.detail}>{location.detail}</small></td>
              <td><strong>{shuttle.direction === 1 ? "Outbound" : "Return"}</strong></td>
              <td><StatusPill tone={shuttle.status === "running" ? "info" : "ok"}>{shuttle.status}</StatusPill></td>
              <td><strong>{shuttle.speedKmh} km/h</strong><small className="cell-sub">{shuttle.nominalSpeedKmh} km/h nominal</small></td>
              <td><strong>{transitionSeconds} s</strong><small className="cell-sub">{shuttle.location.type === "station" ? "to departure" : "to next station"}</small></td>
              <td><strong>{shuttle.passengers} / {shuttle.capacityPassengers}</strong><small className="cell-sub">{Math.round(shuttle.passengers / shuttle.capacityPassengers * 100)}% load</small></td>
              <td><strong>{(shuttle.routeDistanceMeters / 1_000).toFixed(1)} km</strong><small className="cell-sub">one way</small></td>
              <td><StatusPill tone="neutral">{shuttle.quality}</StatusPill></td>
            </tr>
          );
        })}</tbody>
      </table>
    );
  } else if (activeTab === "incidents") {
    table = (
      <table className="data-table simulator-table simulator-table--incidents">
        <caption className="sr-only">All simulated incidents from both operational models</caption>
        <thead><tr>
          <th>Incident</th><th>Code</th><th>Model</th><th>Line</th><th>Location</th><th>Type</th>
          <th>Severity</th><th>Status</th><th>Restriction / impact</th><th>Owner</th><th>Occurrence time</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.incidents).map((row) => {
          const incident = row.incident;
          const isNative = row.source === "Native network";
          const codes = "lineCode" in incident ? [incident.lineCode] : incident.lineIds;
          const impact = "restrictionMode" in incident
            ? incident.effect + " · " + incident.impactedTrainIds.length + " trains"
            : (incident.effect ?? incident.blockedCircuitIds.length + " CDV blocked") + " · " + incident.impactedTrainIds.length + " trains";
          const target = incident.target;
          return (
            <tr key={row.source + ":" + incident.id}>
              <td>
                <button
                  type="button"
                  className="inline-link simulator-object-link"
                  onClick={() => isNative
                    ? navigate(nativeIncidentPath(incident.id))
                    : onSelect({ type: "incident", id: incident.id })}
                >
                  {incident.id}
                </button>
                <small className="cell-sub">{incident.title}</small>
              </td>
              <td><code>{incident.incidentCode}</code></td>
              <td><StatusPill tone={isNative ? "purple" : "neutral"}>{row.source}</StatusPill></td>
              <td><Lines codes={codes} /></td>
              <td><strong>{incident.location}</strong>{target && <small className="cell-sub">{target.type} · {target.id}</small>}</td>
              <td><strong>{incident.type}</strong></td>
              <td><StatusPill tone={severityTone(incident.severity)}>{incident.severity}</StatusPill></td>
              <td><StatusPill tone={incident.status === "active" ? "danger" : incident.status === "resolved" ? "ok" : "warning"}>{incident.status}</StatusPill></td>
              <td><strong>{impact}</strong></td>
              <td><strong>{incident.owner}</strong></td>
              <td><strong title={new Date(incident.startedAt).toISOString()}>{formatSimulationTime(incident.startedAt)}</strong><small className="cell-sub">{new Date(incident.startedAt).toISOString()}</small></td>
            </tr>
          );
        })}</tbody>
      </table>
    );
  } else if (activeTab === "stations") {
    table = (
      <table className="data-table simulator-table">
        <caption className="sr-only">All native network station objects</caption>
        <thead><tr>
          <th>Station</th><th>Code</th><th>Lines</th><th>Train occupation</th>
          <th>Waiting passengers</th><th>Arrival rate</th><th>Boarded / alighted</th><th>Last exchange</th>
          <th>Active incidents</th><th>State</th><th>Coordinates</th><th>SVG object</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.stations).map((station) => {
          const trains = indexes.trainsByLocation.get("station:" + station.code) ?? [];
          const incidents = indexes.incidentsByStation.get(station.code) ?? [];
          const passengerStates = nativeSimulation.stationPassengers.filter((state) =>
            state.stationId === station.code && (line === "ALL" || state.lineCode === line)
          );
          const waitingPassengers = passengerStates.reduce((total, state) => total + state.waitingPassengers, 0);
          const arrivalsPerSecond = passengerStates.reduce(
            (total, state) => total + effectivePassengerArrivalRate(
              state.arrivalsPerSecond,
              nativeSimulation.timestamp,
            ),
            0,
          );
          const totalBoarded = passengerStates.reduce((total, state) => total + state.totalBoardedPassengers, 0);
          const totalAlighted = passengerStates.reduce((total, state) => total + state.totalAlightedPassengers, 0);
          const lastExchangeAt = Math.max(0, ...passengerStates.map((state) => state.lastExchangeAt ?? 0));
          return (
            <tr key={station.code}>
              <td><strong>{station.name}</strong><small className="cell-sub">{station.id}</small></td>
              <td><code>{station.code}</code></td>
              <td><Lines codes={station.lines} /></td>
              <td><strong>{trains.length ? trains.join(", ") : "Free"}</strong></td>
              <td><strong>{waitingPassengers.toLocaleString("en-GB")}</strong><small className="cell-sub">{passengerStates.length} line queue{passengerStates.length === 1 ? "" : "s"}</small></td>
              <td><strong>{arrivalsPerSecond.toFixed(4)} pax/s</strong><small className="cell-sub">{isPassengerDemandActive(nativeSimulation.timestamp) ? "active service rate" : `paused · ${PASSENGER_DEMAND_PAUSE_LABEL}`}</small></td>
              <td><strong>{totalBoarded.toLocaleString("en-GB")} / {totalAlighted.toLocaleString("en-GB")}</strong><small className="cell-sub">recorded station exchanges</small></td>
              <td><strong>{lastExchangeAt ? formatSimulationTime(lastExchangeAt) : "—"}</strong></td>
              <td><strong>{incidents.length ? incidents.join(", ") : "None"}</strong></td>
              <td><StatusPill tone={incidents.length ? "danger" : trains.length ? "info" : "ok"}>{incidents.length ? "incident" : trains.length ? "occupied" : "clear"}</StatusPill></td>
              <td><strong>{station.latitude.toFixed(4)}, {station.longitude.toFixed(4)}</strong></td>
              <td><code title={station.svgId}>{station.svgId}</code></td>
            </tr>
          );
        })}</tbody>
      </table>
    );
  } else if (activeTab === "interstations") {
    table = (
      <table className="data-table simulator-table">
        <caption className="sr-only">All native network interstation objects</caption>
        <thead><tr>
          <th>Interstation</th><th>Line</th><th>Train occupation</th><th>Restriction</th>
          <th>Active incidents</th><th>Native length</th><th>Topology</th><th>Object ID</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.interstations).map((interstation) => {
          const trains = indexes.trainsByLocation.get("interstation:" + interstation.id) ?? [];
          const incidents = indexes.incidentsByInterstation.get(interstation.id) ?? [];
          const restriction = indexes.restrictionsByInterstation.get(interstation.id);
          return (
            <tr key={interstation.id}>
              <td><strong>{stationName(interstation.fromStationCode)} → {stationName(interstation.toStationCode)}</strong><small className="cell-sub">{interstation.fromStationCode} → {interstation.toStationCode}</small></td>
              <td><Lines codes={[interstation.lineCode]} /></td>
              <td><strong>{trains.length ? trains.join(", ") : "Free"}</strong></td>
              <td><StatusPill tone={restriction?.mode === "blocked" ? "danger" : restriction ? "warning" : "ok"}>{restriction ? restriction.mode + (restriction.speedLimitKmh ? " · " + restriction.speedLimitKmh + " km/h" : "") : "none"}</StatusPill></td>
              <td><strong>{incidents.length ? incidents.join(", ") : "None"}</strong></td>
              <td><strong>{Math.round(interstation.nativeLength)} units</strong></td>
              <td><strong>{interstation.pathIds.length} path{interstation.pathIds.length === 1 ? "" : "s"}</strong><small className="cell-sub">{interstation.collapsedStopCount} collapsed stops</small></td>
              <td><code title={interstation.id}>{interstation.id}</code></td>
            </tr>
          );
        })}</tbody>
      </table>
    );
  } else if (activeTab === "power") {
    table = (
      <table className="data-table simulator-table">
        <caption className="sr-only">All simulated electrical power sections</caption>
        <thead><tr>
          <th>Power section</th><th>Lines</th><th>Substation</th><th>Status</th>
          <th>Voltage</th><th>Current</th><th>Load</th><th>Supplied circuits</th><th>Updated</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.power).map((section) => (
          <tr key={section.id}>
            <td><button type="button" className="inline-link simulator-object-link" onClick={() => onSelect({ type: "power", id: section.id })}>{section.id}</button><small className="cell-sub">{section.name}</small></td>
            <td><Lines codes={section.lineIds} /></td>
            <td><strong>{section.substation}</strong></td>
            <td><StatusPill tone={section.status === "energized" ? "ok" : section.status === "degraded" ? "warning" : "danger"}>{section.status}</StatusPill></td>
            <td><strong>{section.voltage} V</strong><small className="cell-sub">Nominal {section.nominalVoltage} V</small></td>
            <td><strong>{section.currentAmps} A</strong></td>
            <td><strong>{section.status === "isolated" ? "N/A" : section.loadPercent + " %"}</strong></td>
            <td><strong>{section.circuitIds.length}</strong><small className="cell-sub" title={section.circuitIds.join(", ")}>{section.circuitIds.join(", ")}</small></td>
            <td><strong>{formatSimulationTime(section.updatedAt)}</strong></td>
          </tr>
        ))}</tbody>
      </table>
    );
  } else if (activeTab === "circuits") {
    table = (
      <table className="data-table simulator-table">
        <caption className="sr-only">All detailed simulated track circuits</caption>
        <thead><tr>
          <th>Track circuit</th><th>Line</th><th>Segment</th><th>Direction</th><th>State</th>
          <th>Occupation</th><th>Reservation</th><th>Length / limit</th><th>Power section</th><th>Closure</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.circuits).map((circuit) => (
          <tr key={circuit.id}>
            <td><button type="button" className="inline-link simulator-object-link" onClick={() => onSelect({ type: "circuit", id: circuit.id })}>{circuit.id}</button><small className="cell-sub">{circuit.label}</small></td>
            <td><Lines codes={[circuit.lineId]} /></td>
            <td><strong>{circuit.fromStation} → {circuit.toStation}</strong></td>
            <td><strong>{circuit.direction === 1 ? "Outbound" : "Inbound"}</strong></td>
            <td><StatusPill tone={circuitTone(circuit.state)}>{circuit.state}</StatusPill></td>
            <td><strong>{circuit.occupiedBy ?? "—"}</strong><small className="cell-sub">{circuit.circulationId ?? ""}</small></td>
            <td><strong>{circuit.reservedBy ?? "—"}</strong></td>
            <td><strong>{circuit.lengthMeters} m</strong><small className="cell-sub">{circuit.speedLimitKmh} km/h</small></td>
            <td><strong>{circuit.electricalSectionId}</strong></td>
            <td><strong>{circuit.closure ? circuit.closure.reason : "Open"}</strong><small className="cell-sub">{circuit.closure?.note ?? ""}</small></td>
          </tr>
        ))}</tbody>
      </table>
    );
  } else if (activeTab === "drivers") {
    table = (
      <table className="data-table simulator-table">
        <caption className="sr-only">One unique driver assignment for every non-automatic native-network train</caption>
        <thead><tr>
          <th>Driver token</th><th>Line</th><th>Assigned train</th><th>Circulation</th>
          <th>Mission</th><th>Train status</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.drivers).map((train) => (
          <tr key={train.driverId}>
            <td><strong>{train.driverId}</strong><small className="cell-sub">Pseudonymous resource</small></td>
            <td><Lines codes={[train.lineCode]} /></td>
            <td><strong>{train.id}</strong></td>
            <td><strong>{train.circulationId}</strong></td>
            <td><strong>{train.mission}</strong></td>
            <td><StatusPill tone={trainTone(train.status)}>{train.status}</StatusPill></td>
          </tr>
        ))}</tbody>
      </table>
    );
  } else {
    table = (
      <table className="data-table simulator-table">
        <caption className="sr-only">Complete simulated event stream</caption>
        <thead><tr>
          <th>Time</th><th>Event</th><th>Kind</th><th>Severity</th><th>Details</th><th>Event ID</th>
        </tr></thead>
        <tbody>{sliceRows(filtered.events).map((event) => (
          <tr key={event.id}>
            <td><strong>{formatSimulationTime(event.timestamp)}</strong></td>
            <td><strong>{event.title}</strong></td>
            <td><StatusPill tone="neutral">{event.kind}</StatusPill></td>
            <td><StatusPill tone={severityTone(event.severity)}>{event.severity}</StatusPill></td>
            <td><strong>{event.detail}</strong></td>
            <td><code>{event.id}</code></td>
          </tr>
        ))}</tbody>
      </table>
    );
  }

  return (
    <div className="page simulator-page" id="text-text-simulator-page">
      <PageHeader
        contentId="text-text-simulator-header"
        eyebrow="OPERATIONAL SIMULATION · CURRENT STATE"
        title="SimView"
        description="Inspect every object currently held by the Paris ICC operational simulation, with discrete train occupation and traceable model revisions."
        actions={
          <>
            <StatusPill tone={nativeSimulation.speed === 0 ? "warning" : "ok"} pulse={nativeSimulation.speed !== 0}>
              {nativeSimulation.speed === 0 ? "Paused" : "Running · ×" + nativeSimulation.speed}
            </StatusPill>
            <StatusPill tone="purple">Operational simulation</StatusPill>
          </>
        }
      />

      {operationStatus && (
        <div
          id="text-text-simulator-operation-status"
          className={"simulator-config-status simulator-config-status--" + operationStatus.tone}
          role={operationStatus.tone === "danger" ? "alert" : "status"}
        >
          <Icon name={operationStatus.tone === "danger" ? "alert" : "shield"} size={16} />
          <span>{operationStatus.message}</span>
        </div>
      )}

      <section className="kpi-grid kpi-grid--compact simulator-summary" id="text-text-simulator-summary" aria-label="Simulation state summary">
        <KpiCard label="Simulation clock" value={formatSimulationTime(nativeSimulation.timestamp)} detail={nativeSimulation.scenarioName} icon="clock" />
        <KpiCard label="Native fleet" value={nativeSimulation.trains.length + nativeSimulation.shuttles.length} detail={nativeSimulation.trains.length + " trains · " + nativeSimulation.shuttles.length + " shuttles"} icon="train" tone={nativeSimulation.metrics.heldTrainCount ? "warning" : "default"} />
        <KpiCard
          label="Train crews"
          value={nativeSimulation.trains.filter((train) => train.driverId !== null).length}
          detail={nativeSimulation.trains.filter((train) => train.driverId === null).length + " automatic trains · lines 1, 4 and 14"}
          icon="users"
        />
        <KpiCard label="Operational objects" value={NATIVE_STATIONS.length + NATIVE_INTERSTATIONS.length} detail={NATIVE_STATIONS.length + " stations · " + NATIVE_INTERSTATIONS.length + " interstations"} icon="network" />
        <KpiCard label="Model revisions" value={"T" + nativeSimulation.telemetryRevision + " / D" + nativeSimulation.decisionRevision} detail={"Detailed corridor rev. " + snapshot.revision} icon="radio" />
        <KpiCard
          label="Passenger queues"
          value={nativeSimulation.stationPassengers.reduce((total, state) => total + state.waitingPassengers, 0).toLocaleString("en-GB")}
          detail={passengerFlowSummary.totalBoardedPassengers.toLocaleString("en-GB") + " cumulative boardings today"}
          icon="users"
        />
      </section>

      <section
        className="panel simulator-train-insertion"
        id="text-text-simulator-train-insertion"
        aria-labelledby="simulator-train-insertion-title"
        data-control-owner="operator"
      >
        <header>
          <span className="simulator-train-insertion__icon"><Icon name="train" size={21} /></span>
          <div>
            <span className="panel__eyebrow">MANUAL CAPACITY CONTROL · OPERATOR</span>
            <h2 id="simulator-train-insertion-title">Insert a reinforcement train</h2>
            <p>This direct operator control is separate from incident-driven agent recommendations. It writes a traceable command to the authoritative model.</p>
          </div>
          <StatusPill tone="neutral">Operator command</StatusPill>
        </header>
        <div className="simulator-train-insertion__controls">
          <label>
            <span>Line</span>
            <select
              data-testid="sim-train-insertion-line"
              value={insertionLine}
              onChange={(event) => selectInsertionLine(event.target.value as NativeLineCode)}
            >
              {NATIVE_LINES.map((definition) => (
                <option value={definition.code} key={definition.code}>{definition.label} · {definition.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Insertion station</span>
            <select
              data-testid="sim-train-insertion-station"
              value={insertionStationId}
              onChange={(event) => selectInsertionStation(event.target.value)}
            >
              {insertionStations.length === 0 && (
                <option value="">No unoccupied station available</option>
              )}
              {insertionStations.map((station) => (
                <option value={station.id} key={station.id}>{station.name} · {station.id}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Direction</span>
            <select
              data-testid="sim-train-insertion-direction"
              value={insertionDirection}
              onChange={(event) => {
                setInsertionDirection(Number(event.target.value) as 1 | -1);
                setInsertionStatus(null);
              }}
            >
              {insertionDirections.map((option) => (
                <option value={option.direction} key={`${option.stationId}:${option.direction}`}>
                  {option.direction === 1 ? "Outbound" : "Inbound"} · toward {stationName(option.destinationStationId)}
                </option>
              ))}
            </select>
          </label>
          <aside aria-live="polite">
            <small>PLANNED INSERTION</small>
            <strong>{selectedInsertion
              ? `${stationName(selectedInsertion.stationId)} → ${stationName(selectedInsertion.destinationStationId)}`
              : "No eligible route"}</strong>
            <span>{selectedInsertion
              ? `Discrete station occupation · +${selectedInsertion.capacityDeltaPassengers.toLocaleString("en-GB")} reference places`
              : "All eligible stations are currently occupied; wait for one to clear or choose another line."}</span>
          </aside>
          <button
            type="button"
            className="button button--primary"
            data-testid="sim-train-insertion-submit"
            disabled={!selectedInsertion || insertionBusy}
            onClick={() => void insertTrain()}
          >
            <Icon name="train" size={15} /> {insertionBusy ? "Inserting…" : "Insert train"}
          </button>
        </div>
        {insertionStatus && (
          <div className={`simulator-train-insertion__status simulator-train-insertion__status--${insertionStatus.tone}`} role={insertionStatus.tone === "danger" ? "alert" : "status"}>
            <Icon name={insertionStatus.tone === "danger" ? "alert" : "shield"} size={15} />
            <span>{insertionStatus.message}</span>
          </div>
        )}
      </section>

      <section className="panel simulator-panel" id="text-text-simulator-object-registry" aria-labelledby="simulator-objects-title">
        <header className="simulator-panel__header">
          <div>
            <span className="panel__eyebrow">SIMULATED OBJECT REGISTRY</span>
            <h2 id="simulator-objects-title">Current model state</h2>
          </div>
          <div className="simulator-toolbar" id="text-text-simulator-filters">
            <label className="simulator-search">
              <Icon name="search" size={15} />
              <span className="sr-only">Search simulated objects</span>
              <input
                type="search"
                value={search}
                placeholder="Search ID, station, status…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {activeTab !== "events" && (
              <label className="simulator-line-filter">
                <span>Line</span>
                <select
                  aria-label="Filter simulated objects by line"
                  value={line}
                  onChange={(event) => setLine(event.target.value as NativeLineCode | "ALL")}
                >
                  <option value="ALL">All 21 lines</option>
                  {NATIVE_LINES.map((definition) => (
                    <option value={definition.code} key={definition.code}>{definition.label} · {definition.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </header>

        <div className="simulator-tabs" id="text-text-simulator-object-tabs" role="tablist" aria-label="Simulated object types">
          {TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              id={"simulator-tab-" + tab.id}
              aria-selected={activeTab === tab.id}
              aria-controls="text-text-simulator-object-tabpanel"
              className={activeTab === tab.id ? "active" : ""}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon name={tab.icon} size={15} />
              <span>{tab.label}</span>
              <b>{counts[tab.id]}</b>
            </button>
          ))}
        </div>

        <div
          className="simulator-tabpanel"
          id="text-text-simulator-object-tabpanel"
          role="tabpanel"
          aria-labelledby={"simulator-tab-" + activeTab}
          tabIndex={0}
        >
          <div className="simulator-result-bar" id="text-text-simulator-result-summary">
            <span><strong>{filteredCount}</strong> matching object{filteredCount === 1 ? "" : "s"}</span>
            <span>Snapshot {formatSimulationTime(nativeSimulation.timestamp)} · state revision {nativeSimulation.telemetryRevision}</span>
            {activeTab === "incidents" && (
              <button
                type="button"
                className="button button--danger simulator-add-incident"
                data-testid="sim-incident-open"
                onClick={() => setIncidentModalOpen(true)}
              >
                <Icon name="alert" size={14} /> Add incident
              </button>
            )}
          </div>
          {filteredCount ? <div className="table-wrap simulator-table-wrap" id="text-text-simulator-object-table">{table}</div> : <EmptyRows />}
          {filteredCount > 0 && (
            <footer className="simulator-pagination" id="text-text-simulator-pagination">
              <span>Showing {pageStart + 1}–{pageEnd} of {filteredCount}</span>
              <div>
                <button type="button" disabled={pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))}>Previous</button>
                <span>Page {pageIndex + 1} / {pageCount}</span>
                <button type="button" disabled={pageIndex >= pageCount - 1} onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}>Next</button>
              </div>
            </footer>
          )}
        </div>
      </section>

      {incidentModalOpen && (
        <SimulatorIncidentModal
          snapshot={snapshot}
          nativeSimulation={nativeSimulation}
          initialLine={line}
          onClose={() => setIncidentModalOpen(false)}
          onSubmit={createIncident}
        />
      )}
    </div>
  );
}
