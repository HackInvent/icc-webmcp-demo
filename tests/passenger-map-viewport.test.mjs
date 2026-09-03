import { describe, expect, it } from "vitest";
import {
  PASSENGER_MAP_MAX_ZOOM,
  PASSENGER_MAP_MIN_ZOOM,
  clampPassengerMapViewport,
  panPassengerMap,
  passengerMapRenderTransform,
  passengerMapWheelZoom,
  zoomPassengerMapAt,
} from "../src/passenger/passengerMapViewport.ts";

describe("Passenger heatmap viewport", () => {
  it("keeps the map position under the pointer stable while zooming", () => {
    const anchor = { x: 250, y: 150 };
    const current = { zoom: 1, x: 0, y: 0 };
    const next = zoomPassengerMapAt(current, 2, anchor, 1_000, 600);

    expect(next).toEqual({ zoom: 2, x: -250, y: -150 });
    expect((anchor.x - current.x) / current.zoom).toBe((anchor.x - next.x) / next.zoom);
    expect((anchor.y - current.y) / current.zoom).toBe((anchor.y - next.y) / next.zoom);
  });

  it("clamps drag movement so the map cannot be lost outside its viewport", () => {
    const current = { zoom: 2, x: -400, y: -200 };
    expect(panPassengerMap(current, 900, 900, 1_000, 600)).toEqual({ zoom: 2, x: 0, y: 0 });
    expect(panPassengerMap(current, -900, -900, 1_000, 600)).toEqual({ zoom: 2, x: -1_000, y: -600 });
    expect(clampPassengerMapViewport({ zoom: 1, x: -800, y: -400 }, 1_000, 600))
      .toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("converts mouse-wheel and trackpad deltas into bounded smooth zoom", () => {
    expect(passengerMapWheelZoom(1, -100, 0, 600)).toBeGreaterThan(1);
    expect(passengerMapWheelZoom(2, 100, 0, 600)).toBeLessThan(2);
    expect(passengerMapWheelZoom(1, 100_000, 0, 600)).toBe(PASSENGER_MAP_MIN_ZOOM);
    expect(passengerMapWheelZoom(5, -100_000, 0, 600)).toBe(PASSENGER_MAP_MAX_ZOOM);
  });

  it("fits and zooms the native map through a vector-space transform", () => {
    const bounds = { minX: 0, minY: 0, width: 1_000, height: 1_000 };
    expect(passengerMapRenderTransform(
      { zoom: 1, x: 0, y: 0 },
      1_000,
      600,
      bounds,
    )).toEqual({ scale: 0.6, translateX: 200, translateY: 0 });
    expect(passengerMapRenderTransform(
      { zoom: 2, x: -250, y: -150 },
      1_000,
      600,
      bounds,
    )).toEqual({ scale: 1.2, translateX: 150, translateY: -150 });
  });
});
