import { useEffect, useMemo, useState } from "react";
import nativeMapUrl from "../../artifacts/ratp-network-native.svg?url";
import { Icon } from "../components/Icon";
import {
  buildPassengerFlowView,
  type PassengerFlowLevel,
} from "../passenger/passengerFlowModel";
import type { RailSnapshot } from "../rail/domain";
import {
  NATIVE_LINES,
  NATIVE_LINE_BY_CODE,
  NATIVE_NETWORK_BOUNDS,
  type NativeLineCode,
} from "../rail/nativeNetwork";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import { getOfficialLineRidership } from "../rail/lineRidership";
import { getReferenceCapacity } from "../rail/rollingStock";

interface PassengerFlowPageProps {
  simulation: NativeSimulationSnapshot;
  detailedSnapshot: RailSnapshot;
}

const LEVEL_LABELS: ReadonlyArray<{ level: PassengerFlowLevel; label: string }> = [
  { level: "quiet", label: "Quiet <35%" },
  { level: "moderate", label: "Moderate 35–64%" },
  { level: "busy", label: "Busy 65–89%" },
  { level: "high", label: "High 90–109%" },
  { level: "critical", label: "Critical ≥110%" },
];

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function lineLabel(code: NativeLineCode): string {
  return NATIVE_LINES.find((line) => line.code === code)?.label ?? code;
}

function demandAudit(code: NativeLineCode) {
  const record = getOfficialLineRidership(code);
  const line = NATIVE_LINE_BY_CODE.get(code);
  if (!record || !line) return null;
  const daily = record.dailyPassengerJourneys;
  const volume = daily ?? record.annualPassengerJourneys;
  const period = daily === null ? "year" : "day";
  const periodSeconds = daily === null ? 365 * 24 * 60 * 60 : 24 * 60 * 60;
  const stationCount = line.stationCodes.length;
  return {
    volume,
    period,
    year: record.referenceYear,
    publisher: record.source.publisher,
    title: record.source.title,
    url: record.source.url,
    stationCount,
    periodSeconds,
    arrivalsPerSecond: volume / stationCount / periodSeconds,
    qualifier: record.qualifier,
  };
}

export function PassengerFlowPage({ simulation, detailedSnapshot }: PassengerFlowPageProps) {
  const [lineCode, setLineCode] = useState<NativeLineCode | "ALL">("ALL");
  const [selectedStationCode, setSelectedStationCode] = useState<string | null>(null);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const view = useMemo(
    () => buildPassengerFlowView(simulation, detailedSnapshot, lineCode === "ALL" ? null : lineCode),
    [detailedSnapshot, lineCode, simulation],
  );
  const selectedStation = view.stations.find((item) => item.station.code === selectedStationCode)
    ?? view.busiestStation
    ?? view.stations[0]
    ?? null;
  const audit = lineCode === "ALL" ? null : demandAudit(lineCode);
  const selectedTrain = selectedStation?.contributions.find((item) => item.train.id === selectedTrainId)?.train ?? null;

  useEffect(() => {
    if (selectedStationCode && view.stations.some((item) => item.station.code === selectedStationCode)) return;
    setSelectedStationCode(view.busiestStation?.station.code ?? view.stations[0]?.station.code ?? null);
    setSelectedTrainId(null);
  }, [lineCode, selectedStationCode, view.busiestStation, view.stations]);

  const chooseStation = (stationCode: string) => {
    setSelectedStationCode(stationCode);
    setSelectedTrainId(null);
  };

  return (
    <div className="page passenger-flow-page" id="text-text-passenger-flow-page">
      <header className="passenger-flow-header" id="text-text-passenger-flow-header">
        <div>
          <span className="panel__eyebrow">PASSENGER PRESSURE · DISCRETE OPERATIONAL STATE</span>
          <h1>Passenger flow</h1>
          <p>Station-level pressure derived from modelled queues, trains physically dwelling at platforms and passenger-feed observations.</p>
        </div>
        <div className="passenger-flow-header__time" id="text-text-passenger-flow-time">
          <Icon name="clock" size={16} />
          <span><small>Operational snapshot</small><strong>{formatTime(simulation.timestamp)}</strong></span>
        </div>
      </header>

      <section className="passenger-flow-kpis" id="text-text-passenger-flow-kpis" aria-label="Passenger flow summary">
        <article><span>Onboard passengers</span><strong>{view.totalOnboardPassengers.toLocaleString("en-GB")}</strong><small>{lineCode === "ALL" ? "All simulated lines" : `Line ${lineLabel(lineCode)}`}</small></article>
        <article><span>Waiting queue</span><strong>{view.totalQueuePassengers.toLocaleString("en-GB")}</strong><small>{view.activeStationCount} active station estimates</small></article>
        <article className={view.highPressureStationCount ? "is-alert" : ""}><span>High-pressure stations</span><strong>{view.highPressureStationCount}</strong><small>At or above 90% reference load</small></article>
        <article><span>Mean active load</span><strong>{view.averageLoadPercent}%</strong><small>Train-based reference capacity</small></article>
        <article><span>Busiest station</span><strong>{view.busiestStation?.station.name ?? "No active flow"}</strong><small>{view.busiestStation ? `${view.busiestStation.passengerPressure.toLocaleString("en-GB")} passenger pressure` : view.feedStatus}</small></article>
      </section>

      <section className="passenger-flow-method" id="text-text-passenger-flow-demand-method">
        <div><Icon name="shield" size={17} /><span><strong>Auditable demand formula</strong>Current queues are calculated operational state; the arrival rate is derived from a cited volume, divided by rendered stations and period seconds.</span></div>
        {audit ? (
          <>
            <dl>
              <div><dt>Reference volume</dt><dd>{audit.volume.toLocaleString("en-GB")}</dd><small>{audit.qualifier} · {audit.period} · {audit.year}</small></div>
              <div><dt>Station divisor</dt><dd>{audit.stationCount}</dd><small>Rendered stations on {lineLabel(lineCode as NativeLineCode)}</small></div>
              <div><dt>Period divisor</dt><dd>{audit.periodSeconds.toLocaleString("en-GB")} s</dd><small>{audit.period === "year" ? "365 × 24 × 3,600" : "24 × 3,600"}</small></div>
              <div><dt>Per-station rate</dt><dd>{audit.arrivalsPerSecond.toFixed(6)}/s</dd><small>volume ÷ stations ÷ seconds</small></div>
            </dl>
            <a href={audit.url} target="_blank" rel="noreferrer"><Icon name="external" size={13} /> {audit.publisher} · {audit.title}</a>
          </>
        ) : <p>Select one line to expose its exact volume, period, station divisor, computed rate and source URL.</p>}
      </section>

      <section className="passenger-flow-workspace" id="text-text-passenger-flow-workspace">
        <div className="passenger-flow-map-panel">
          <div className="passenger-flow-toolbar" id="text-text-passenger-flow-toolbar">
            <label>
              <span>Network line</span>
              <select
                data-testid="passenger-flow-line-filter"
                value={lineCode}
                onChange={(event) => {
                  setLineCode(event.target.value as NativeLineCode | "ALL");
                  setZoom(1);
                }}
              >
                <option value="ALL">All Metro + RER lines</option>
                {NATIVE_LINES.map((line) => <option key={line.code} value={line.code}>{line.label} · {line.name}</option>)}
              </select>
            </label>
            <div className="passenger-flow-zoom" role="group" aria-label="Passenger map zoom">
              <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, value - 0.25))}>−</button>
              <output>{Math.round(zoom * 100)}%</output>
              <button type="button" onClick={() => setZoom(1)}>Fit</button>
              <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(2.5, value + 0.25))}>+</button>
            </div>
          </div>

          <div className="passenger-flow-map" id="text-text-passenger-flow-map" data-testid="passenger-flow-map">
            <div className="passenger-flow-map__surface" style={{ width: `${zoom * 100}%` }}>
              <img src={nativeMapUrl} alt="" aria-hidden="true" />
              <svg
                viewBox={`${NATIVE_NETWORK_BOUNDS.minX} ${NATIVE_NETWORK_BOUNDS.minY} ${NATIVE_NETWORK_BOUNDS.width} ${NATIVE_NETWORK_BOUNDS.height}`}
                role="img"
                aria-label="Paris Metro and RER station passenger-pressure heatmap"
                preserveAspectRatio="xMidYMid meet"
              >
                <g className="passenger-flow-heat-layer">
                  {view.stations.map((item) => {
                    const selected = item.station.code === selectedStation?.station.code;
                    const radius = item.passengerPressure > 0
                      ? Math.min(17, 5 + Math.sqrt(item.passengerPressure) * 0.38)
                      : 2.4;
                    return (
                      <circle
                        key={item.station.code}
                        className={`passenger-flow-marker passenger-flow-marker--${item.level}${selected ? " is-selected" : ""}`}
                        data-testid="passenger-flow-station-marker"
                        data-station-code={item.station.code}
                        data-passenger-pressure={item.passengerPressure}
                        cx={item.station.anchor.x}
                        cy={item.station.anchor.y}
                        r={selected ? radius + 3 : radius}
                        role="button"
                        tabIndex={0}
                        aria-label={`${item.station.name}: ${item.passengerPressure} passenger pressure, ${item.loadPercent}% load`}
                        onClick={() => chooseStation(item.station.code)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          chooseStation(item.station.code);
                        }}
                      >
                        <title>{`${item.station.name} · ${item.passengerPressure} pressure · ${item.loadPercent}% · ${item.contributions.length} trains`}</title>
                      </circle>
                    );
                  })}
                </g>
              </svg>
            </div>
          </div>

          <footer className="passenger-flow-map-footer" id="text-text-passenger-flow-legend">
            <div className="passenger-flow-legend" aria-label="Passenger pressure legend">
              {LEVEL_LABELS.map((item) => <span key={item.level}><i className={`passenger-flow-legend__${item.level}`} />{item.label}</span>)}
            </div>
            <p><Icon name="shield" size={13} /> Pressure is decision-support evidence, not an access-control or automatic dispatch command.</p>
          </footer>
        </div>

        <aside className="passenger-flow-detail" id="text-text-passenger-flow-detail" aria-live="polite">
          {selectedStation ? (
            <>
              <header>
                <span className={`passenger-flow-detail__level passenger-flow-detail__level--${selectedStation.level}`}>{selectedStation.level}</span>
                <h2>{selectedStation.station.name}</h2>
                <p>{selectedStation.station.lines.map(lineLabel).join(" · ")}</p>
              </header>
              <dl className="passenger-flow-detail__metrics">
                <div><dt>Waiting queue</dt><dd>{selectedStation.queuePassengers.toLocaleString("en-GB")}</dd></div>
                <div><dt>Arrival rate</dt><dd>{selectedStation.arrivalsPerSecond === null ? "—" : `${selectedStation.arrivalsPerSecond.toFixed(4)}/s`}</dd></div>
                <div><dt>Last boarded</dt><dd>{selectedStation.lastBoarded === null ? "—" : selectedStation.lastBoarded.toLocaleString("en-GB")}</dd></div>
                <div><dt>Last alighted</dt><dd>{selectedStation.lastAlighted === null ? "—" : selectedStation.lastAlighted.toLocaleString("en-GB")}</dd></div>
                <div><dt>Total boarded</dt><dd>{selectedStation.totalBoarded === null ? "—" : selectedStation.totalBoarded.toLocaleString("en-GB")}</dd></div>
                <div><dt>Total alighted</dt><dd>{selectedStation.totalAlighted === null ? "—" : selectedStation.totalAlighted.toLocaleString("en-GB")}</dd></div>
                <div><dt>Last exchange</dt><dd>{selectedStation.lastExchangeAt === null ? "—" : formatTime(selectedStation.lastExchangeAt)}</dd></div>
                <div><dt>Train pressure</dt><dd>{(selectedStation.passengerPressure - selectedStation.queuePassengers).toLocaleString("en-GB")}</dd></div>
                <div><dt>Reference load</dt><dd>{selectedStation.loadPercent}%</dd></div>
                <div><dt>Contributing trains</dt><dd>{selectedStation.contributions.length}</dd></div>
                <div><dt>Passenger-feed calls</dt><dd>{selectedStation.serviceCalls}</dd></div>
              </dl>
              <div className="passenger-flow-detail__basis" id="text-text-passenger-flow-estimate-basis">
                <Icon name="activity" size={15} />
                <span><strong>{selectedStation.source === "modelled-queue" ? "Modelled station queue" : "Occupation-based estimate"}</strong>Waiting queues are aggregated per station and line; only trains physically dwelling at the station contribute their onboard load.</span>
              </div>
              <section className="passenger-flow-trains" id="text-text-passenger-flow-station-trains">
                <h3>Trains influencing this station</h3>
                {selectedStation.contributions.length ? selectedStation.contributions.map((contribution) => (
                  <button
                    type="button"
                    key={`${contribution.train.id}-${contribution.relationship}`}
                    className={selectedTrainId === contribution.train.id ? "is-active" : ""}
                    onClick={() => setSelectedTrainId(contribution.train.id)}
                  >
                    <span><strong>{contribution.train.id}</strong><small>{contribution.train.mission} · {contribution.relationship.replace("-", " ")}</small></span>
                    <span><b>{contribution.train.passengers}/{getReferenceCapacity(contribution.train.lineCode)}</b><small>{Math.round(contribution.train.passengers / getReferenceCapacity(contribution.train.lineCode) * 100)}% load</small></span>
                  </button>
                )) : <p className="passenger-flow-trains__empty">No train is currently dwelling at this station.</p>}
              </section>
              {selectedTrain && (
                <section className="passenger-flow-train-detail" id="text-text-passenger-flow-train-detail">
                  <span>SELECTED TRAIN</span>
                  <h3>{selectedTrain.id} · {selectedTrain.mission}</h3>
                  <dl>
                    <div><dt>Onboard</dt><dd>{selectedTrain.passengers.toLocaleString("en-GB")}</dd></div>
                    <div><dt>Delay</dt><dd>{selectedTrain.delaySeconds}s</dd></div>
                    <div><dt>Status</dt><dd>{selectedTrain.status}</dd></div>
                    <div><dt>Destination</dt><dd>{selectedTrain.destinationStationCode}</dd></div>
                  </dl>
                </section>
              )}
            </>
          ) : (
            <div className="passenger-flow-detail__empty"><Icon name="users" size={24} /><strong>No station in scope</strong><span>Select another line filter.</span></div>
          )}
        </aside>
      </section>
    </div>
  );
}
