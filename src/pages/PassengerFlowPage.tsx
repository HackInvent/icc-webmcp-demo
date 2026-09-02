import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import nativeMapUrl from "../../artifacts/ratp-network-native.svg?url";
import {
  analyzePassengerFlowPriorities,
  type PassengerFlowPriorityPackage,
  type PassengerFlowPriorityProgress,
} from "../agent/passengerFlowPriorityAgent";
import { Icon } from "../components/Icon";
import {
  buildPassengerFlowView,
  passengerFlowHeatColor,
  type PassengerFlowLevel,
} from "../passenger/passengerFlowModel";
import type { RailSnapshot } from "../rail/domain";
import {
  NATIVE_LINES,
  NATIVE_NETWORK_BOUNDS,
  type NativeLineCode,
} from "../rail/nativeNetwork";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import { getReferenceCapacity } from "../rail/rollingStock";
import { formatParisOperationalTime } from "../rail/operationalTime";

interface PassengerFlowPageProps {
  simulation: NativeSimulationSnapshot;
  detailedSnapshot: RailSnapshot;
  expectedToolNames?: readonly string[];
  inPageTools?: readonly WebMcpToolDefinition[];
  toolsChecked?: boolean;
  toolsPublished?: boolean;
  agentEnabled?: boolean;
  agentModel?: string | null;
  onIncidentActivate?: (incidentId: string) => void;
}

interface PassengerMapDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
  moved: boolean;
}

const PASSENGER_MAP_DRAG_THRESHOLD_PX = 4;
const PASSENGER_MAP_CLICK_SUPPRESSION_MS = 300;
const EMPTY_TOOL_NAMES: readonly string[] = Object.freeze([]);
const EMPTY_IN_PAGE_TOOLS: readonly WebMcpToolDefinition[] = Object.freeze([]);

const PRIORITY_PROGRESS_LABELS: Readonly<Record<PassengerFlowPriorityProgress, string>> = {
  discovering: "Discovering the Passenger Flow WebMCP tool",
  inspecting: "Inspecting queues and active incident scopes",
  reasoning: "Agent is ranking queue-relief priorities",
};

const LEVEL_LABELS: ReadonlyArray<{ level: PassengerFlowLevel; label: string }> = [
  { level: "quiet", label: "0% · light green" },
  { level: "moderate", label: "50% · half train capacity" },
  { level: "high", label: "100% · one train capacity" },
  { level: "critical", label: "200% · two train capacities" },
];

function formatTime(timestamp: number): string {
  return formatParisOperationalTime(timestamp, true);
}

function lineLabel(code: NativeLineCode): string {
  return NATIVE_LINES.find((line) => line.code === code)?.label ?? code;
}

export function PassengerFlowPage({
  simulation,
  detailedSnapshot,
  expectedToolNames = EMPTY_TOOL_NAMES,
  inPageTools = EMPTY_IN_PAGE_TOOLS,
  toolsChecked = false,
  toolsPublished = false,
  agentEnabled = false,
  agentModel = null,
  onIncidentActivate,
}: PassengerFlowPageProps) {
  const [lineCode, setLineCode] = useState<NativeLineCode | "ALL">("ALL");
  const [selectedStationCode, setSelectedStationCode] = useState<string | null>(null);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isMapDragging, setIsMapDragging] = useState(false);
  const [priorityAnalysis, setPriorityAnalysis] = useState<PassengerFlowPriorityPackage | null>(null);
  const [priorityProgress, setPriorityProgress] = useState<PassengerFlowPriorityProgress>("discovering");
  const [priorityLoading, setPriorityLoading] = useState(false);
  const [priorityError, setPriorityError] = useState<string | null>(null);
  const [priorityRefresh, setPriorityRefresh] = useState(0);
  const mapDragRef = useRef<PassengerMapDragState | null>(null);
  const suppressMapClickUntilRef = useRef(0);
  const view = useMemo(
    () => buildPassengerFlowView(simulation, detailedSnapshot, lineCode === "ALL" ? null : lineCode),
    [detailedSnapshot, lineCode, simulation],
  );
  const selectedStation = view.stations.find((item) => item.station.code === selectedStationCode)
    ?? view.busiestStation
    ?? view.stations[0]
    ?? null;
  const selectedTrain = selectedStation?.contributions.find((item) => item.train.id === selectedTrainId)?.train ?? null;

  useEffect(() => {
    if (selectedStationCode && view.stations.some((item) => item.station.code === selectedStationCode)) return;
    setSelectedStationCode(view.busiestStation?.station.code ?? view.stations[0]?.station.code ?? null);
    setSelectedTrainId(null);
  }, [lineCode, selectedStationCode, view.busiestStation, view.stations]);

  useEffect(() => {
    if (!toolsPublished) return undefined;
    const controller = new AbortController();
    setPriorityLoading(true);
    setPriorityError(null);
    setPriorityProgress("discovering");
    setPriorityAnalysis((current) => current?.context.line === lineCode ? current : null);
    void analyzePassengerFlowPriorities({
      line: lineCode,
      expectedToolNames,
      inPageTools,
      modelEnabled: agentEnabled,
      signal: controller.signal,
      onProgress: setPriorityProgress,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setPriorityAnalysis(result);
      setPriorityLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setPriorityLoading(false);
      setPriorityError(error instanceof Error
        ? error.message
        : "The Passenger Flow agent could not complete its analysis.");
    });
    return () => controller.abort();
  }, [agentEnabled, expectedToolNames, inPageTools, lineCode, priorityRefresh, toolsPublished]);

  const chooseStation = (stationCode: string) => {
    setSelectedStationCode(stationCode);
    setSelectedTrainId(null);
  };

  const startMapDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const map = event.currentTarget;
    suppressMapClickUntilRef.current = 0;
    mapDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: map.scrollLeft,
      startScrollTop: map.scrollTop,
      moved: false,
    };
  };

  const moveMapDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) >= PASSENGER_MAP_DRAG_THRESHOLD_PX) {
      drag.moved = true;
      setIsMapDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.startScrollLeft - deltaX;
    event.currentTarget.scrollTop = drag.startScrollTop - deltaY;
  };

  const finishMapDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressMapClickUntilRef.current = Date.now() + PASSENGER_MAP_CLICK_SUPPRESSION_MS;
    }
    mapDragRef.current = null;
    setIsMapDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="page passenger-flow-page" id="text-text-passenger-flow-page">
      <header className="passenger-flow-header" id="text-text-passenger-flow-header">
        <div>
          <span className="panel__eyebrow">PASSENGER PRESSURE · DISCRETE OPERATIONAL STATE</span>
          <h1>Passenger flow</h1>
          <p>Station waiting queues measured against the maximum configured train capacity per line, with dwelling trains retained as separate operational context.</p>
        </div>
        <div className="passenger-flow-header__time" id="text-text-passenger-flow-time">
          <Icon name="clock" size={16} />
          <span><small>Operational snapshot</small><strong>{formatTime(simulation.timestamp)}</strong></span>
        </div>
      </header>

      <section className="passenger-flow-kpis" id="text-text-passenger-flow-kpis" aria-label="Passenger flow summary">
        <article><span>Onboard passengers</span><strong>{view.totalOnboardPassengers.toLocaleString("en-GB")}</strong><small>{lineCode === "ALL" ? "All lines" : `Line ${lineLabel(lineCode)}`}</small></article>
        <article><span>Waiting queue</span><strong>{view.totalQueuePassengers.toLocaleString("en-GB")}</strong><small>{view.activeStationCount} active station estimates</small></article>
        <article><span>Cumulative boardings</span><strong>{view.totalBoardedPassengers.toLocaleString("en-GB")}</strong><small>{view.totalGeneratedPassengers.toLocaleString("en-GB")} generated · {view.totalAlightedPassengers.toLocaleString("en-GB")} alighted since reset</small></article>
        <article className={view.highPressureStationCount ? "is-alert" : ""}><span>At-capacity stations</span><strong>{view.highPressureStationCount}</strong><small>Waiting queue ≥ maximum train capacity</small></article>
        <article><span>Mean queue ratio</span><strong>{view.averageLoadPercent}%</strong><small>Waiting queue ÷ train capacity</small></article>
        <article><span>Busiest station</span><strong>{view.busiestStation?.station.name ?? "No active flow"}</strong><small>{view.busiestStation ? `${view.busiestStation.passengerPressure.toLocaleString("en-GB")} passenger pressure` : view.feedStatus}</small></article>
      </section>

      <section
        className={`passenger-flow-agent${priorityLoading ? " is-working" : ""}`}
        id="text-text-passenger-flow-agent-priorities"
        aria-labelledby="passenger-flow-agent-title"
        aria-live="polite"
      >
        <header className="passenger-flow-agent__header">
          <div className="passenger-flow-agent__identity">
            <span className="passenger-flow-agent__icon"><Icon name="radio" size={19} /></span>
            <div>
              <span className="panel__eyebrow">AGENT DECISION SUPPORT · QUEUE RELIEF</span>
              <h2 id="passenger-flow-agent-title">Priority incidents</h2>
              <p>{priorityAnalysis?.summary ?? (
                priorityLoading
                  ? PRIORITY_PROGRESS_LABELS[priorityProgress]
                  : toolsChecked && !toolsPublished
                    ? "The Passenger Flow WebMCP tool is unavailable."
                    : "Preparing the current operational context."
              )}</p>
            </div>
          </div>
          <div className="passenger-flow-agent__controls">
            <div className="passenger-flow-agent__trust">
              {priorityLoading && <span className="is-live"><i />{PRIORITY_PROGRESS_LABELS[priorityProgress]}</span>}
              {!priorityLoading && priorityAnalysis && (
                <>
                  <span><Icon name="radio" size={13} />{priorityAnalysis.modelAssisted ? agentModel ?? "OpenAI" : "Verified fallback"}</span>
                  <span><Icon name="network" size={13} />{priorityAnalysis.transport === "native" ? "Native WebMCP" : "In-page WebMCP"}</span>
                  <span><Icon name="clock" size={13} />{formatTime(priorityAnalysis.context.observedAt)}</span>
                </>
              )}
            </div>
            <button
              type="button"
              className="button button--secondary passenger-flow-agent__refresh"
              data-testid="passenger-flow-agent-refresh"
              disabled={priorityLoading || !toolsPublished}
              onClick={() => setPriorityRefresh((value) => value + 1)}
            >
              <Icon name="reset" size={14} /> {priorityLoading ? "Analyzing…" : "Refresh"}
            </button>
          </div>
        </header>

        {priorityError && (
          <div className="passenger-flow-agent__message is-error" role="alert">
            <Icon name="alert" size={16} /><span><strong>Analysis unavailable</strong>{priorityError}</span>
          </div>
        )}

        {!priorityAnalysis && priorityLoading && (
          <div className="passenger-flow-agent__loading" data-testid="passenger-flow-agent-loading">
            {[1, 2, 3].map((rank) => <span key={rank}><i>{rank}</i><b /><b /></span>)}
          </div>
        )}

        {priorityAnalysis && priorityAnalysis.priorities.length > 0 && (
          <ol className="passenger-flow-agent__priorities" data-testid="passenger-flow-agent-priorities">
            {priorityAnalysis.priorities.map((priority) => (
              <li key={priority.incidentId} className={`passenger-flow-agent-card is-${priority.severity}`}>
                <header>
                  <span className="passenger-flow-agent-card__rank">#{priority.evidenceRank}</span>
                  <div><small>{priority.lineCode} · {priority.incidentCode}</small><h3>{priority.title}</h3></div>
                  <div className="passenger-flow-agent-card__queue"><strong>{priority.waitingQueuePassengers.toLocaleString("en-GB")}</strong><span>waiting in scope</span></div>
                </header>
                <p className="passenger-flow-agent-card__recommendation">{priority.recommendation}</p>
                <p className="passenger-flow-agent-card__rationale">{priority.rationale}</p>
                {priority.queueHotspots.length > 0 && (
                  <div className="passenger-flow-agent-card__hotspots">
                    {priority.queueHotspots.map((hotspot) => (
                      <span key={hotspot.stationCode}>{hotspot.stationName} <b>{hotspot.waitingPassengers.toLocaleString("en-GB")}</b></span>
                    ))}
                  </div>
                )}
                <footer>
                  <span><Icon name="users" size={13} />+{priority.arrivalsPerMinute.toLocaleString("en-GB")} pax/min</span>
                  <span><Icon name="train" size={13} />{priority.impactedTrainCount} impacted trains</span>
                  <span><Icon name="clock" size={13} />since {formatTime(Date.parse(priority.occurrenceTime))}</span>
                  {onIncidentActivate && (
                    <button type="button" onClick={() => onIncidentActivate(priority.incidentId)}>
                      Open incident <Icon name="arrow" size={13} />
                    </button>
                  )}
                </footer>
              </li>
            ))}
          </ol>
        )}

        {priorityAnalysis && priorityAnalysis.priorities.length === 0 && (
          <div className="passenger-flow-agent__empty">
            <Icon name="shield" size={19} /><span><strong>No incident priority</strong>No active incident currently constrains a measured waiting queue in this scope.</span>
          </div>
        )}

        {priorityAnalysis?.agentWarning && (
          <p className="passenger-flow-agent__fallback" title={priorityAnalysis.agentWarning}>
            <Icon name="shield" size={12} /> Verified WebMCP queue ordering is active; operator review remains required.
          </p>
        )}
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

          <div
            className={`passenger-flow-map${isMapDragging ? " is-dragging" : ""}`}
            id="text-text-passenger-flow-map"
            data-testid="passenger-flow-map"
            data-pan-enabled="true"
            data-pan-state={isMapDragging ? "dragging" : "idle"}
            role="region"
            aria-label="Interactive passenger heatmap. Drag to pan the map when zoomed."
            onPointerDown={startMapDrag}
            onPointerMove={moveMapDrag}
            onPointerUp={finishMapDrag}
            onPointerCancel={finishMapDrag}
            onLostPointerCapture={finishMapDrag}
            onClickCapture={(event) => {
              if (Date.now() >= suppressMapClickUntilRef.current) return;
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <div className="passenger-flow-map__surface" style={{ width: `${zoom * 100}%` }}>
              <img src={nativeMapUrl} alt="" aria-hidden="true" draggable={false} />
              <svg
                viewBox={`${NATIVE_NETWORK_BOUNDS.minX} ${NATIVE_NETWORK_BOUNDS.minY} ${NATIVE_NETWORK_BOUNDS.width} ${NATIVE_NETWORK_BOUNDS.height}`}
                role="img"
                aria-label="Paris Metro and RER station passenger-pressure heatmap"
                preserveAspectRatio="xMidYMid meet"
              >
                <g className="passenger-flow-heat-layer">
                  {view.stations.map((item) => {
                    const selected = item.station.code === selectedStation?.station.code;
                    const radius = Math.min(17, 5 + Math.sqrt(item.passengerPressure) * 0.38);
                    return (
                      <circle
                        key={item.station.code}
                        className={`passenger-flow-marker passenger-flow-marker--${item.level}${selected ? " is-selected" : ""}`}
                        data-testid="passenger-flow-station-marker"
                        data-station-code={item.station.code}
                        data-passenger-pressure={item.passengerPressure}
                        data-queue-capacity-percent={item.loadPercent}
                        data-capacity-reference={item.capacityReferencePlaces}
                        style={{ fill: passengerFlowHeatColor(item.loadPercent) }}
                        cx={item.station.anchor.x}
                        cy={item.station.anchor.y}
                        r={selected ? radius + 3 : radius}
                        role="button"
                        tabIndex={0}
                        aria-label={`${item.station.name}: ${item.queuePassengers} waiting passengers, ${item.loadPercent}% of maximum train capacity`}
                        onClick={() => chooseStation(item.station.code)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          chooseStation(item.station.code);
                        }}
                      >
                        <title>{`${item.station.name} · ${item.queuePassengers} waiting · ${item.loadPercent}% of ${item.capacityReferencePlaces} capacity-reference places · ${item.contributions.length} trains`}</title>
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
            <p><Icon name="shield" size={13} /> Waiting queue ÷ maximum configured train capacity. In all-lines view, one maximum-capacity train is counted per served line. Decision-support evidence only.</p>
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
                <div><dt>Max train capacity</dt><dd>{selectedStation.capacityReferencePlaces.toLocaleString("en-GB")}</dd></div>
                <div><dt>Queue / capacity</dt><dd>{selectedStation.loadPercent}%</dd></div>
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
