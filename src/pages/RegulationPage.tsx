import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import type { EntitySelection, RailSnapshot } from "../rail/domain";
import {
  NATIVE_INTERSTATION_BY_ID,
  NATIVE_LINES,
  NATIVE_STATION_BY_CODE,
  type NativeLineCode,
} from "../rail/nativeNetwork";
import {
  createNativeSimulationSnapshot,
  type NativeSimulationSnapshot,
  type NativeTrainState,
} from "../rail/nativeSimulation";
import {
  buildNativeLineSynoptic,
  buildNativeRegulationQueue,
  calculateNativeLineMetrics,
  calculateOperationalCellCrowding,
  incidentsAtOperationalCell,
  trainsAtOperationalCell,
  type NativeRegulationAxisCell,
} from "../rail/regulationModel";
import {
  DEMO_TRACTION_METHODOLOGY,
  getReferenceAssignment,
  getRollingStockFamily,
} from "../rail/rollingStock";

export interface RegulationPageProps {
  nativeSimulation?: NativeSimulationSnapshot;
  snapshot?: RailSnapshot;
  onSelect?: (selection: EntitySelection) => void;
}

const FALLBACK_NATIVE_SNAPSHOT = createNativeSimulationSnapshot({ scenarioId: "multi-event" });

function delayLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `+${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function elapsedLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder} min`;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`;
}

function stationLabel(stationCode: string): string {
  return NATIVE_STATION_BY_CODE.get(stationCode)?.name ?? stationCode;
}

function locationLabel(train: NativeTrainState): string {
  if (train.location.type === "station") return stationLabel(train.location.id);
  const edge = NATIVE_INTERSTATION_BY_ID.get(train.location.id);
  return edge
    ? `${stationLabel(edge.fromStationCode)} — ${stationLabel(edge.toStationCode)}`
    : train.location.id;
}

function stationOccurrence(cell: NativeRegulationAxisCell): "primary" | "continuation" | undefined {
  if (cell.type !== "station") return undefined;
  return cell.primaryOccurrence ? "primary" : "continuation";
}

export function RegulationPage(props: RegulationPageProps) {
  const native = props.nativeSimulation ?? FALLBACK_NATIVE_SNAPSHOT;
  const [lineCode, setLineCode] = useState<NativeLineCode>("RER_A");
  const line = NATIVE_LINES.find((candidate) => candidate.code === lineCode) ?? NATIVE_LINES[0];
  const trains = useMemo(
    () => native.trains.filter((train) => train.lineCode === lineCode),
    [lineCode, native.trains],
  );
  const incidents = useMemo(
    () => native.incidents.filter(
      (incident) => incident.lineCode === lineCode && incident.status === "active",
    ),
    [lineCode, native.incidents],
  );
  const synoptic = useMemo(() => buildNativeLineSynoptic(lineCode), [lineCode]);
  const metrics = useMemo(() => calculateNativeLineMetrics(native, lineCode), [lineCode, native]);
  const queue = useMemo(() => buildNativeRegulationQueue(native, lineCode), [lineCode, native]);
  const referenceAssignment = getReferenceAssignment(lineCode);
  const referenceFamily = getRollingStockFamily(referenceAssignment.familyId);
  const activeTabId = `native-regulation-tab-${lineCode}`;

  return (
    <div className="page native-regulation" id="text-text-regulation-page">
      <PageHeader
        contentId="text-text-regulation-header"
        eyebrow="LINE REGULATION · DISCRETE OCCUPATION"
        title="Delays & regulation"
        description="Select one line to inspect its complete native station/interstation topology, current train occupations and operational pressure."
        actions={(
          <div className="native-regulation__clock" id="text-text-regulation-clock">
            <span>{metrics.shiftWindow.name} shift · since {metrics.shiftWindow.startLabel}</span>
            <strong>{new Date(native.timestamp).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              timeZone: "Europe/Paris",
            })}</strong>
            <small>{elapsedLabel(metrics.shiftWindow.elapsedMinutes)} elapsed · rev. {native.telemetryRevision}</small>
          </div>
        )}
      />

      <nav className="native-regulation__line-tabs" role="tablist" aria-label="Regulation line">
        {NATIVE_LINES.map((candidate) => (
          <button
            id={`native-regulation-tab-${candidate.code}`}
            type="button"
            role="tab"
            aria-selected={candidate.code === lineCode}
            aria-controls="native-regulation-line-panel"
            tabIndex={candidate.code === lineCode ? 0 : -1}
            key={candidate.code}
            onClick={() => setLineCode(candidate.code)}
          >
            <i style={{ backgroundColor: candidate.color }} />
            {candidate.label}
          </button>
        ))}
      </nav>

      <section className="native-regulation__shift-strip" id="text-text-regulation-kpi-basis">
        <div>
          <span>Current shift evidence boundary</span>
          <strong>{metrics.shiftWindow.name} shift · {metrics.shiftWindow.asOfLabel}</strong>
        </div>
        <p>Live object counters plus clearly labelled shift-to-now estimates. This view does not claim an unpersisted historical time series.</p>
      </section>

      <section className="native-regulation__kpis" aria-label={`${line.label} current shift performance indicators`}>
        <article>
          <span>Current cumulative train delay</span>
          <strong>{delayLabel(metrics.cumulativeDelaySeconds)}</strong>
          <small>sum of live train delay counters · not historical</small>
        </article>
        <article>
          <span>Current production state</span>
          <strong>{metrics.productionRatePercent}%</strong>
          <small>running + dwelling / {metrics.trainCount} trains now</small>
        </article>
        <article>
          <span>Current punctuality state</span>
          <strong>{metrics.punctualityPercent}%</strong>
          <small>live trains below 3 minutes delay</small>
        </article>
        <article>
          <span>Current load / capacity</span>
          <strong>{metrics.crowdingPercent}%</strong>
          <small>{metrics.passengerCount.toLocaleString("en-GB")} passengers · peak object {metrics.highestObjectCrowdingPercent}%</small>
        </article>
        <article>
          <span>Active incidents</span>
          <strong>{metrics.activeIncidentCount}</strong>
          <small>{metrics.highCrowdingObjectCount} high-pressure object{metrics.highCrowdingObjectCount === 1 ? "" : "s"}</small>
        </article>
        <article className="native-regulation__kpi-estimate">
          <span>Shift-to-now traction <b>ESTIMATE</b></span>
          <strong>{metrics.estimatedShiftEnergyIndex}</strong>
          <small>relative index-hours over {elapsedLabel(metrics.shiftWindow.elapsedMinutes)} · not kWh</small>
        </article>
      </section>

      <section
        className="panel native-regulation__synoptic-panel"
        id="native-regulation-line-panel"
        role="tabpanel"
        aria-labelledby={activeTabId}
        style={{ "--native-line-color": line.color } as CSSProperties}
      >
        <header className="native-regulation__section-header">
          <div>
            <span className="panel__eyebrow">{line.label} · COMPLETE NATIVE SYNOPTIC</span>
            <h2>{line.name}</h2>
            <p>Every object published by NATIVE_LINE_BY_CODE is shown, including branches and detached schematic termini. Trains occupy one station or one interstation—never an interpolated position.</p>
          </div>
          <div className="native-regulation__coverage" id="text-text-regulation-topology-coverage">
            <strong>{synoptic.uniqueStationCount + synoptic.uniqueInterstationCount} objects</strong>
            <span>{synoptic.uniqueStationCount} stations · {synoptic.uniqueInterstationCount} interstations · {synoptic.lanes.length} sections</span>
          </div>
        </header>
        <div className="native-regulation__legend">
          <span><i className="native-regulation__legend-train" /> exact train occupation</span>
          <span><i className="native-regulation__legend-crowding" /> passenger pressure estimate</span>
          <span><i className="native-regulation__legend-incident">!</i> active incident</span>
          <small>Scroll horizontally to inspect the full line</small>
        </div>
        <div
          className="native-regulation__synoptic-scroll"
          tabIndex={0}
          aria-label={`Scrollable complete ${line.label} operational synoptic`}
          data-complete-stations={synoptic.uniqueStationCount}
          data-complete-interstations={synoptic.uniqueInterstationCount}
        >
          <div className="native-regulation__lanes">
            {synoptic.lanes.map((lane) => {
              const laneStationCount = lane.cells.filter((cell) => cell.type === "station").length;
              const laneInterstationCount = lane.cells.filter((cell) => cell.type === "interstation").length;
              return (
                <div className={`native-regulation__lane native-regulation__lane--${lane.kind}`} key={lane.id}>
                  <header className="native-regulation__lane-label">
                    <span>{lane.kind}</span>
                    <strong>{lane.label}</strong>
                    <small>{laneStationCount} station nodes · {laneInterstationCount} interstations</small>
                  </header>
                  <div className="native-regulation__axis">
                    {lane.cells.map((cell, index) => {
                      const cellTrains = trainsAtOperationalCell(trains, cell);
                      const cellIncidents = incidentsAtOperationalCell(incidents, cell);
                      const crowding = calculateOperationalCellCrowding(trains, cell, lineCode);
                      return (
                        <article
                          className={`native-regulation__cell native-regulation__cell--${cell.type} ${cell.type === "station" && !cell.primaryOccurrence ? "native-regulation__cell--continuation" : ""}`}
                          data-occupation-type={cell.type}
                          data-topology-object={cell.id}
                          data-station-occurrence={stationOccurrence(cell)}
                          key={`${lane.id}:${cell.type}:${cell.id}:${index}`}
                        >
                          <div className="native-regulation__cell-track">
                            {cell.type === "station"
                              ? <i className={`native-regulation__station-node ${cell.junction ? "native-regulation__station-node--junction" : ""}`} />
                              : <i className="native-regulation__interstation-line" />}
                            {cellIncidents.map((incident) => (
                              <span
                                className="native-regulation__incident-marker"
                                title={`${incident.incidentCode} · ${incident.title}`}
                                aria-label={`Active incident: ${incident.title}`}
                                key={incident.id}
                              >!</span>
                            ))}
                          </div>
                          <div className="native-regulation__cell-label">
                            <strong>{cell.type === "station" ? cell.label : "Interstation"}</strong>
                            <small>{cell.type === "station" ? cell.id : cell.label}</small>
                          </div>
                          {crowding.contributingTrainCount > 0 && (
                            <div
                              className={`native-regulation__crowding native-regulation__crowding--${crowding.level}`}
                              title={`${crowding.passengerPressure} passenger pressure; ${crowding.loadPercent}% of reference places; ${crowding.basis}`}
                            >
                              <i />
                              <span>{crowding.loadPercent}%</span>
                              <small>{crowding.passengerPressure.toLocaleString("en-GB")} pax pressure</small>
                            </div>
                          )}
                          <div className="native-regulation__occupants">
                            {cellTrains.map((train) => (
                              <span
                                className={`native-regulation__train native-regulation__train--${train.status}`}
                                data-train-location={cell.type}
                                key={train.id}
                              >
                                <Icon name="train" size={14} />
                                <span><b>{train.mission}</b><small>{train.circulationId}</small></span>
                                <em>{delayLabel(train.delaySeconds)}</em>
                              </span>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="native-regulation__workspace">
        <section className="panel native-regulation__queue" id="text-text-regulation-queue">
          <header className="native-regulation__section-header">
            <div>
              <span className="panel__eyebrow">CURRENT-STATE PRIORITY</span>
              <h2>Regulation queue</h2>
              <p>Ranked from active incidents, exact held states, live delay counters and reference crowding.</p>
            </div>
            <strong>{queue.length}</strong>
          </header>
          {queue.length > 0 ? (
            <div className="native-regulation__queue-list">
              {queue.map((item, index) => (
                <article key={item.id}>
                  <span className={`native-regulation__queue-rank native-regulation__queue-rank--${item.kind}`}>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <span>{item.kind.replace("-", " ")} · score {item.score}</span>
                    <h3>{item.title}</h3>
                    <p>{item.detail}</p>
                    <small>{item.evidence}</small>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="native-regulation__empty">
              <Icon name="shield" size={23} />
              <strong>No object exceeds the current regulation thresholds</strong>
              <span>The queue will populate from native incidents and exact train state.</span>
            </div>
          )}
        </section>

        <aside className="panel native-regulation__evidence" id="text-text-regulation-evidence-boundary">
          <header className="native-regulation__section-header">
            <div><span className="panel__eyebrow">EVIDENCE BOUNDARY</span><h2>Facts vs estimates</h2></div>
          </header>
          <section>
            <h3><i className="native-regulation__fact-dot" /> Current operational facts</h3>
            <dl>
              <div><dt>Exact train objects</dt><dd>{trains.length}</dd></div>
              <div><dt>Active incidents</dt><dd>{metrics.activeIncidentCount}</dd></div>
              <div><dt>Native topology coverage</dt><dd>{synoptic.uniqueStationCount + synoptic.uniqueInterstationCount} / {synoptic.uniqueStationCount + synoptic.uniqueInterstationCount}</dd></div>
              <div><dt>Telemetry revision</dt><dd>{native.telemetryRevision}</dd></div>
            </dl>
          </section>
          <section className="native-regulation__estimate-section">
            <h3><i /> Derived · current shift estimate</h3>
            <dl>
              <div><dt>Fleet reference</dt><dd>{referenceFamily.name}</dd></div>
              <div><dt>Capacity / train</dt><dd>{metrics.referenceCapacityPerTrain.toLocaleString("en-GB")}</dd></div>
              <div><dt>Passenger pressure</dt><dd>position + approach</dd></div>
              <div><dt>Traction output</dt><dd>relative index</dd></div>
            </dl>
            <p>No unpersisted history is presented as measured performance. Passenger pressure and shift traction are derived from the current snapshot and operational clock. {DEMO_TRACTION_METHODOLOGY.warning}</p>
            <a href={referenceFamily.sourceUrl} target="_blank" rel="noreferrer"><Icon name="external" size={13} /> {referenceFamily.sourceLabel}</a>
          </section>
        </aside>
      </div>

      <section className="panel native-regulation__train-board" id="text-text-regulation-train-register">
        <header className="native-regulation__section-header">
          <div><span className="panel__eyebrow">DISCRETE OBJECT REGISTER · {line.label}</span><h2>Trains in current scope</h2></div>
          <span>{trains.length} object{trains.length === 1 ? "" : "s"}</span>
        </header>
        <div className="native-regulation__table-scroll">
          <table>
            <thead><tr><th>Train</th><th>Mission</th><th>Exact occupation</th><th>Status</th><th>Passengers</th><th>Reference load</th><th>Delay counter</th></tr></thead>
            <tbody>
              {trains.map((train) => {
                const loadPercent = metrics.referenceCapacityPerTrain
                  ? Math.round(train.passengers / metrics.referenceCapacityPerTrain * 100)
                  : 0;
                return (
                  <tr key={train.id}>
                    <td><strong>{train.circulationId}</strong><small>{train.id}</small></td>
                    <td>{train.mission}</td>
                    <td><span className="native-regulation__location-type">{train.location.type}</span>{locationLabel(train)}</td>
                    <td><span className={`native-regulation__status native-regulation__status--${train.status}`}>{train.status}</span></td>
                    <td>{train.passengers.toLocaleString("en-GB")}</td>
                    <td>{loadPercent}%</td>
                    <td><b className={train.delaySeconds >= 180 ? "native-regulation__delay--high" : ""}>{delayLabel(train.delaySeconds)}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
