export interface PassengerMapViewport {
  zoom: number;
  x: number;
  y: number;
}

export interface PassengerMapPoint {
  x: number;
  y: number;
}

export interface PassengerMapBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export interface PassengerMapRenderTransform {
  scale: number;
  translateX: number;
  translateY: number;
}

export const PASSENGER_MAP_MIN_ZOOM = 1;
export const PASSENGER_MAP_MAX_ZOOM = 5;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampPassengerMapViewport(
  viewport: PassengerMapViewport,
  width: number,
  height: number,
): PassengerMapViewport {
  const zoom = clamp(viewport.zoom, PASSENGER_MAP_MIN_ZOOM, PASSENGER_MAP_MAX_ZOOM);
  return {
    zoom,
    x: clamp(viewport.x, width * (1 - zoom), 0),
    y: clamp(viewport.y, height * (1 - zoom), 0),
  };
}

export function zoomPassengerMapAt(
  viewport: PassengerMapViewport,
  requestedZoom: number,
  anchor: PassengerMapPoint,
  width: number,
  height: number,
): PassengerMapViewport {
  const zoom = clamp(requestedZoom, PASSENGER_MAP_MIN_ZOOM, PASSENGER_MAP_MAX_ZOOM);
  const ratio = zoom / viewport.zoom;
  return clampPassengerMapViewport({
    zoom,
    x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio,
  }, width, height);
}

export function panPassengerMap(
  viewport: PassengerMapViewport,
  deltaX: number,
  deltaY: number,
  width: number,
  height: number,
): PassengerMapViewport {
  return clampPassengerMapViewport({
    ...viewport,
    x: viewport.x + deltaX,
    y: viewport.y + deltaY,
  }, width, height);
}

export function passengerMapWheelZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  return clamp(
    currentZoom * Math.exp(-pixels * 0.0015),
    PASSENGER_MAP_MIN_ZOOM,
    PASSENGER_MAP_MAX_ZOOM,
  );
}

export function passengerMapRenderTransform(
  viewport: PassengerMapViewport,
  viewportWidth: number,
  viewportHeight: number,
  bounds: PassengerMapBounds,
): PassengerMapRenderTransform {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const fitScale = Math.min(width / bounds.width, height / bounds.height);
  const fittedOffsetX =
    (width - bounds.width * fitScale) / 2 - bounds.minX * fitScale;
  const fittedOffsetY =
    (height - bounds.height * fitScale) / 2 - bounds.minY * fitScale;
  return {
    scale: fitScale * viewport.zoom,
    translateX: viewport.x + viewport.zoom * fittedOffsetX,
    translateY: viewport.y + viewport.zoom * fittedOffsetY,
  };
}
