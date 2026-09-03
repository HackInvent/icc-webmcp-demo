import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import nativeMapUrl from "../../artifacts/ratp-network-native.svg?url";
import {
  passengerFlowHeatColor,
  type PassengerFlowView,
} from "../passenger/passengerFlowModel";
import {
  panPassengerMap,
  passengerMapRenderTransform,
  passengerMapWheelZoom,
  zoomPassengerMapAt,
  type PassengerMapViewport,
} from "../passenger/passengerMapViewport";
import { NATIVE_NETWORK_BOUNDS } from "../rail/nativeNetwork";

interface PassengerMapDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startViewport: PassengerMapViewport;
  moved: boolean;
}

interface PassengerMapSize {
  width: number;
  height: number;
}

interface PassengerHeatmapProps {
  view: PassengerFlowView;
  selectedStationCode: string | null;
  onStationSelect: (stationCode: string) => void;
  testId: string;
  modal?: boolean;
}

const DRAG_THRESHOLD_PX = 4;
const CLICK_SUPPRESSION_MS = 300;
const INITIAL_VIEWPORT: PassengerMapViewport = Object.freeze({ zoom: 1, x: 0, y: 0 });
const INITIAL_MAP_SIZE: PassengerMapSize = Object.freeze({
  width: NATIVE_NETWORK_BOUNDS.width,
  height: NATIVE_NETWORK_BOUNDS.height,
});

export function PassengerHeatmap({
  view,
  selectedStationCode,
  onStationSelect,
  testId,
  modal = false,
}: PassengerHeatmapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PassengerMapDragState | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [viewport, setViewport] = useState<PassengerMapViewport>(INITIAL_VIEWPORT);
  const [mapSize, setMapSize] = useState<PassengerMapSize>(INITIAL_MAP_SIZE);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rectangle = map.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return;
      const anchor = {
        x: Math.min(rectangle.width, Math.max(0, event.clientX - rectangle.left)),
        y: Math.min(rectangle.height, Math.max(0, event.clientY - rectangle.top)),
      };
      setViewport((current) => zoomPassengerMapAt(
        current,
        passengerMapWheelZoom(current.zoom, event.deltaY, event.deltaMode, rectangle.height),
        anchor,
        rectangle.width,
        rectangle.height,
      ));
    };
    map.addEventListener("wheel", handleWheel, { passive: false });
    return () => map.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const updateSize = () => {
      const rectangle = map.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return;
      setMapSize((current) =>
        current.width === rectangle.width && current.height === rectangle.height
          ? current
          : { width: rectangle.width, height: rectangle.height }
      );
      setViewport((current) => panPassengerMap(current, 0, 0, rectangle.width, rectangle.height));
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateSize);
    observer.observe(map);
    return () => observer.disconnect();
  }, []);

  const zoomAtCentre = (factor: number) => {
    const map = mapRef.current;
    if (!map) return;
    const rectangle = map.getBoundingClientRect();
    setViewport((current) => zoomPassengerMapAt(
      current,
      current.zoom * factor,
      { x: rectangle.width / 2, y: rectangle.height / 2 },
      rectangle.width,
      rectangle.height,
    ));
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || viewport.zoom <= 1) return;
    suppressClickUntilRef.current = 0;
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewport: viewport,
      moved: false,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startClientX;
    const deltaY = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD_PX) {
      drag.moved = true;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    event.preventDefault();
    const rectangle = event.currentTarget.getBoundingClientRect();
    setViewport(panPassengerMap(
      drag.startViewport,
      deltaX,
      deltaY,
      rectangle.width,
      rectangle.height,
    ));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) suppressClickUntilRef.current = Date.now() + CLICK_SUPPRESSION_MS;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const renderTransform = passengerMapRenderTransform(
    viewport,
    mapSize.width,
    mapSize.height,
    NATIVE_NETWORK_BOUNDS,
  );

  return (
    <div
      ref={mapRef}
      className={`passenger-flow-map${modal ? " passenger-flow-map--modal" : ""}${dragging ? " is-dragging" : ""}`}
      id={modal ? "text-text-passenger-flow-expanded-map" : "text-text-passenger-flow-map"}
      data-testid={testId}
      data-pan-enabled="true"
      data-pan-state={dragging ? "dragging" : "idle"}
      data-zoom={viewport.zoom.toFixed(3)}
      data-pan-x={Math.round(viewport.x)}
      data-pan-y={Math.round(viewport.y)}
      role="region"
      aria-label="Interactive passenger heatmap. Use the mouse wheel or trackpad to zoom, then drag to move the map."
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onClickCapture={(event) => {
        if (Date.now() >= suppressClickUntilRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        className="passenger-flow-map__surface"
        data-rendering="vector-viewbox"
      >
        <svg
          viewBox={`0 0 ${mapSize.width} ${mapSize.height}`}
          role="img"
          aria-label="Paris Metro and RER station passenger-pressure heatmap"
          preserveAspectRatio="xMidYMid meet"
        >
          <g transform={`matrix(${renderTransform.scale} 0 0 ${renderTransform.scale} ${renderTransform.translateX} ${renderTransform.translateY})`}>
            <image
              className="passenger-flow-map__network"
              href={nativeMapUrl}
              x={NATIVE_NETWORK_BOUNDS.minX}
              y={NATIVE_NETWORK_BOUNDS.minY}
              width={NATIVE_NETWORK_BOUNDS.width}
              height={NATIVE_NETWORK_BOUNDS.height}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
              data-drag-disabled="true"
            />
            <g className="passenger-flow-heat-layer">
            {view.stations.map((item) => {
              const selected = item.station.code === selectedStationCode;
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
                  onClick={() => onStationSelect(item.station.code)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onStationSelect(item.station.code);
                  }}
                >
                  <title>{`${item.station.name} · ${item.queuePassengers} waiting · ${item.loadPercent}% of ${item.capacityReferencePlaces} capacity-reference places · ${item.contributions.length} trains`}</title>
                </circle>
              );
            })}
            </g>
          </g>
        </svg>
      </div>

      <div
        className="passenger-flow-map__controls passenger-flow-zoom"
        role="group"
        aria-label="Passenger map zoom"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label="Zoom out" onClick={() => zoomAtCentre(1 / 1.25)}>−</button>
        <output aria-live="polite">{Math.round(viewport.zoom * 100)}%</output>
        <button type="button" onClick={() => setViewport(INITIAL_VIEWPORT)}>Fit</button>
        <button type="button" aria-label="Zoom in" onClick={() => zoomAtCentre(1.25)}>+</button>
      </div>
      <span className="passenger-flow-map__gesture-hint">Wheel / trackpad to zoom · drag to move</span>
    </div>
  );
}
