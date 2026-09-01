import { describe, expect, it } from "vitest";
import {
  RATP_NETWORK_LINES,
  RATP_NETWORK_TOPOLOGY,
  ratpNetworkStationId,
  ratpNetworkZoneId,
} from "./ratpNetwork";

describe("RATP exhaustive GTFS network topology", () => {
  it("covers every Metro axis plus RER A and B exactly once", () => {
    expect(RATP_NETWORK_LINES.map((line) => line.id)).toEqual([
      "M1", "M2", "M3", "M3BIS", "M4", "M5", "M6", "M7", "M7BIS",
      "M8", "M9", "M10", "M11", "M12", "M13", "M14", "RER_A", "RER_B",
    ]);
    expect(new Set(RATP_NETWORK_LINES.map((line) => line.id)).size).toBe(18);
    expect(RATP_NETWORK_LINES.filter((line) => line.mode === "metro")).toHaveLength(16);
    expect(RATP_NETWORK_LINES.filter((line) => line.mode === "rer")).toHaveLength(2);
  });

  it("contains the exhaustive normalized station and interstation graph", () => {
    expect(RATP_NETWORK_TOPOLOGY).toMatchObject({
      schema: "paris-icc-ratp-topology-v2",
      lineCount: 18,
      stationOccurrenceCount: 498,
      physicalStationCount: 406,
      interstationCount: 483,
    });
    expect(RATP_NETWORK_LINES.map((line) => [line.id, line.stops.length])).toEqual([
      ["M1", 25], ["M2", 25], ["M3", 25], ["M3BIS", 4],
      ["M4", 29], ["M5", 22], ["M6", 28], ["M7", 38],
      ["M7BIS", 8], ["M8", 38], ["M9", 37], ["M10", 23],
      ["M11", 19], ["M12", 31], ["M13", 32], ["M14", 21],
      ["RER_A", 46], ["RER_B", 47],
    ]);
  });

  it("keeps every physical station and interstation addressable with stable IDs", () => {
    const stationIds = new Set(
      RATP_NETWORK_LINES.flatMap((line) =>
        line.stops.map((stop) => ratpNetworkStationId(stop.hubId))
      ),
    );
    const zoneIds = RATP_NETWORK_LINES.flatMap((line) =>
      line.edges.map((edge) => {
        expect(edge.id).toBe(ratpNetworkZoneId(line.id, edge.from, edge.to));
        return edge.id;
      }),
    );

    expect(stationIds.size).toBe(RATP_NETWORK_TOPOLOGY.physicalStationCount);
    expect(new Set(zoneIds).size).toBe(RATP_NETWORK_TOPOLOGY.interstationCount);
    expect(zoneIds).toHaveLength(RATP_NETWORK_TOPOLOGY.interstationCount);
  });

  it("contains valid branches, loops and current termini", () => {
    for (const line of RATP_NETWORK_LINES) {
      const stopIds = new Set(line.stops.map((stop) => stop.id));
      expect(line.terminalStopIds.length).toBeGreaterThanOrEqual(2);
      expect(line.terminalStopIds.every((stopId) => stopIds.has(stopId))).toBe(true);
      expect(line.edges.every((edge) => stopIds.has(edge.from) && stopIds.has(edge.to))).toBe(true);
    }

    const names = (lineId: string) => {
      const line = RATP_NETWORK_LINES.find((candidate) => candidate.id === lineId)!;
      const byId = new Map(line.stops.map((stop) => [stop.id, stop.name]));
      return line.terminalStopIds.map((stopId) => byId.get(stopId));
    };
    expect(names("M7")).toEqual(expect.arrayContaining([
      "La Courneuve - 8 Mai 1945", "Mairie d'Ivry", "Villejuif - Louis Aragon",
    ]));
    expect(names("M11")).toContain("Rosny-Bois-Perrier");
    expect(names("M14")).toContain("Aéroport d'Orly");
    expect(names("RER_A")).toHaveLength(5);
    expect(names("RER_B")).toHaveLength(4);
    expect(RATP_NETWORK_LINES.find((line) => line.id === "M7BIS")?.edges).toHaveLength(8);
    expect(RATP_NETWORK_LINES.find((line) => line.id === "M10")?.edges).toHaveLength(24);
  });

  it("binds only the four currently simulated lines to operational telemetry", () => {
    expect(RATP_NETWORK_LINES.flatMap((line) => line.operationalLineId ?? [])).toEqual([
      "M13", "M14", "RER_A", "RER_B",
    ]);
    expect(RATP_NETWORK_TOPOLOGY.source.url).toBe(
      "https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip",
    );
  });
});
