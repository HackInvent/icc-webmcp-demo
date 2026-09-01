import { describe, expect, it } from "vitest";
import {
  NATIVE_ADJACENCY,
  NATIVE_INTERSTATIONS,
  NATIVE_INTERSTATION_BY_ID,
  NATIVE_LINES,
  NATIVE_LINE_BY_CODE,
  NATIVE_LINE_COMPONENTS,
  NATIVE_NETWORK_BOUNDS,
  NATIVE_NETWORK_MANIFEST,
  NATIVE_STATIONS,
  NATIVE_STATION_BY_CODE,
  findNativeInterstation,
  getNativeNeighbors,
  resolveRenderedInterstationId,
  searchNativeStations,
} from "./nativeNetwork";

describe("native RATP network adapter", () => {
  it("loads the canonical native object model with its exact audited counts", () => {
    expect(NATIVE_NETWORK_MANIFEST.schema).toBe("paris-icc-native-ratp-network-v1");
    expect(NATIVE_LINES).toHaveLength(21);
    expect(NATIVE_STATIONS).toHaveLength(390);
    expect(NATIVE_INTERSTATIONS).toHaveLength(467);
    expect(NATIVE_NETWORK_MANIFEST.renderedMap.topologyCrosswalk).toHaveLength(484);
    expect(NATIVE_NETWORK_BOUNDS).toEqual({
      minX: 0,
      minY: 0,
      maxX: 1133.86,
      maxY: 1133.86,
      width: 1133.86,
      height: 1133.86,
    });
  });

  it("indexes every line, station and physical interstation without collision", () => {
    expect(NATIVE_LINE_BY_CODE.size).toBe(NATIVE_LINES.length);
    expect(NATIVE_STATION_BY_CODE.size).toBe(NATIVE_STATIONS.length);
    expect(NATIVE_INTERSTATION_BY_ID.size).toBe(NATIVE_INTERSTATIONS.length);
    expect(NATIVE_LINE_BY_CODE.get("RER_A")?.color).toBe("#E3051B");
    expect(NATIVE_STATION_BY_CODE.get("IDFM:478926")?.name).toBe("Auber");
    expect(NATIVE_INTERSTATION_BY_ID.get("interstation-M14-71264--73626")).toEqual(
      expect.objectContaining({ lineCode: "M14", rendered: true }),
    );
  });

  it("builds symmetric line-scoped adjacency and stable connected components", () => {
    for (const edge of NATIVE_INTERSTATIONS) {
      expect(getNativeNeighbors(edge.lineCode, edge.fromStationCode)).toContainEqual(
        expect.objectContaining({
          neighborStationCode: edge.toStationCode,
          interstationId: edge.id,
        }),
      );
      expect(getNativeNeighbors(edge.lineCode, edge.toStationCode)).toContainEqual(
        expect.objectContaining({
          neighborStationCode: edge.fromStationCode,
          interstationId: edge.id,
        }),
      );
    }
    expect(NATIVE_ADJACENCY.size).toBe(21);
    expect(NATIVE_LINE_COMPONENTS.get("RER_B")).toHaveLength(2);
    expect(NATIVE_LINE_COMPONENTS.get("RER_C")).toHaveLength(6);
    expect(
      NATIVE_LINE_COMPONENTS.get("RER_C")?.filter((component) => component.interstationIds.length > 0),
    ).toHaveLength(3);
    expect(NATIVE_LINE_COMPONENTS.get("M13")?.[0].interstationIds.length).toBe(31);
  });

  it("resolves physical station pairs and repaired source-object identities", () => {
    expect(findNativeInterstation("M13", "IDFM:71435", "IDFM:71474")?.id).toBe(
      "interstation-M13-71435--71474",
    );
    expect(findNativeInterstation("M13", "IDFM:71474", "IDFM:71435")?.id).toBe(
      "interstation-M13-71435--71474",
    );
    expect(resolveRenderedInterstationId("interstation-RER_A-64589--71517")).toBe(
      "interstation-RER_A-64883--71517",
    );
    expect(resolveRenderedInterstationId("does-not-exist")).toBeUndefined();
  });

  it("searches names accent-insensitively and accepts exact IDFM codes", () => {
    expect(searchNativeStations("chatelet", 4).map((station) => station.name)).toContain("Châtelet");
    expect(searchNativeStations("IDFM:478926", 1)[0]?.name).toBe("Auber");
    expect(searchNativeStations("gare de lyon", 1)[0]?.code).toBe("IDFM:73626");
    expect(searchNativeStations("", 10)).toEqual([]);
  });
});
