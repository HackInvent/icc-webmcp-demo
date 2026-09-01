import { describe, expect, it } from "vitest";
import {
  RAIL_GRAPH_INTERSTATIONS,
  RAIL_GRAPH_LINE_NODES,
  RAIL_GRAPH_STATION_CONNECTIONS,
  RAIL_GRAPH_STATIONS,
  RAIL_GRAPH_TRANSFERS,
  RAIL_INTERDEPENDENCE_GRAPH,
  analyzeRailImpact,
  findRailRoute,
  getRailGraphNeighbors,
  resolveRailGraphInterstationIds,
  resolveRailGraphStationConnectionId,
  resolveRailGraphStationId,
} from "./interdependenceGraph";

describe("rail interdependence graph", () => {
  it("loads the exact complete typed multigraph and its audited projection counts", () => {
    expect(RAIL_INTERDEPENDENCE_GRAPH).toMatchObject({
      schema: "paris-icc-rail-interdependence-graph-v2",
      counts: {
        lineCount: 21,
        stationCount: 546,
        stationLineNodeCount: 658,
        interstationLinkCount: 640,
        transferStationCount: 75,
        transferLinkCount: 163,
        stationConnectionCount: 28,
        stationConnectionTraversalLinkCount: 98,
        stationConnectionCategoryCounts: {
          "interchange-complex": 8,
          "public-way-authorized": 16,
          "mapped-walking-link": 4,
        },
        directedTraversalArcCount: 1802,
        connectedComponentCount: 1,
        svgStationProjectionCount: 390,
        svgInterstationProjectionCount: 467,
        graphInterstationProjectedCount: 546,
        graphInterstationOutsideRenderedPlanCount: 94,
      },
      validation: { verdict: "pass" },
    });
    expect(RAIL_GRAPH_STATIONS.filter((station) => station.interchange)).toHaveLength(75);
    expect(RAIL_GRAPH_STATIONS.filter((station) => station.svg.rendered)).toHaveLength(390);
    expect(RAIL_GRAPH_INTERSTATIONS.filter((link) => link.svg.rendered)).toHaveLength(546);
    expect(new Set(
      RAIL_GRAPH_INTERSTATIONS.flatMap((link) => link.svg.interstationObjectId ?? []),
    ).size).toBe(467);
    expect(RAIL_GRAPH_STATION_CONNECTIONS).toHaveLength(28);
  });

  it("keeps interstations line-specific, transfers internal and station connections cross-station", () => {
    const lineNodeById = new Map(RAIL_GRAPH_LINE_NODES.map((node) => [node.id, node]));
    for (const interstation of RAIL_GRAPH_INTERSTATIONS) {
      const from = lineNodeById.get(interstation.fromNodeId);
      const to = lineNodeById.get(interstation.toNodeId);
      expect(from).toMatchObject({
        stationId: interstation.fromStationId,
        lineCode: interstation.lineCode,
      });
      expect(to).toMatchObject({
        stationId: interstation.toStationId,
        lineCode: interstation.lineCode,
      });
      expect(interstation.fromStationId).not.toBe(interstation.toStationId);
      expect(interstation.distanceMeters).toBeGreaterThan(0);
      expect(interstation.estimatedTravelSeconds).toBeGreaterThan(0);
    }
    for (const transfer of RAIL_GRAPH_TRANSFERS) {
      const left = lineNodeById.get(transfer.leftNodeId);
      const right = lineNodeById.get(transfer.rightNodeId);
      expect(left?.stationId).toBe(transfer.stationId);
      expect(right?.stationId).toBe(transfer.stationId);
      expect(left?.lineCode).not.toBe(right?.lineCode);
      expect(transfer.estimatedTransferSeconds).toBeGreaterThan(0);
    }
    for (const connection of RAIL_GRAPH_STATION_CONNECTIONS) {
      expect(connection.fromStationId).not.toBe(connection.toStationId);
      expect(connection.fromNodeIds.every(
        (nodeId) => lineNodeById.get(nodeId)?.stationId === connection.fromStationId,
      )).toBe(true);
      expect(connection.toNodeIds.every(
        (nodeId) => lineNodeById.get(nodeId)?.stationId === connection.toStationId,
      )).toBe(true);
      expect(connection.traversalLinkCount).toBe(
        connection.fromNodeIds.length * connection.toNodeIds.length,
      );
      if (connection.evidence.selectionBasis === "reciprocal-gtfs") {
        expect(connection.evidence.gtfsTransfers?.directionCount).toBe(2);
        expect(connection.evidence.documentaryTransferEstimate).toBeNull();
      } else {
        expect(connection.evidence.gtfsTransfers).toBeNull();
        expect(connection.evidence.documentaryTransferEstimate?.distanceMeters).toBeGreaterThan(0);
        expect(connection.evidence.references.some(
          (reference) => reference.key === "idfmPublicWayDecision",
        )).toBe(true);
      }
      expect(connection.evidence.references.length).toBeGreaterThan(0);
    }
  });

  it("derives 1802 symmetric traversal arcs and one connected component", () => {
    const arcCount = RAIL_GRAPH_LINE_NODES.reduce(
      (sum, node) => sum + getRailGraphNeighbors(node.id).length,
      0,
    );
    expect(arcCount).toBe(RAIL_INTERDEPENDENCE_GRAPH.counts.directedTraversalArcCount);
    const unseen = new Set(RAIL_GRAPH_LINE_NODES.map((node) => node.id));
    const first = unseen.values().next().value as string;
    const pending = [first];
    unseen.delete(first);
    while (pending.length > 0) {
      const nodeId = pending.shift()!;
      for (const arc of getRailGraphNeighbors(nodeId)) {
        if (unseen.delete(arc.toNodeId)) pending.push(arc.toNodeId);
        expect(getRailGraphNeighbors(arc.toNodeId)).toContainEqual(
          expect.objectContaining({ linkId: arc.linkId, toNodeId: nodeId }),
        );
      }
    }
    expect(unseen.size).toBe(0);
  });

  it("resolves native SVG objects to operational graph identities", () => {
    expect(resolveRailGraphStationId("station-72126")).toBe("IDFM:72126");
    expect(resolveRailGraphStationId("IDFM:72126")).toBe("IDFM:72126");
    expect(resolveRailGraphInterstationIds("interstation-M14-72126--72168")).toEqual([
      "M14-IZ-72168--72126",
    ]);
    const contracted = resolveRailGraphInterstationIds("interstation-RER_A-64883--71517");
    expect(contracted).toHaveLength(6);
    expect(contracted.every((id) => id.startsWith("RER_A-IZ-"))).toBe(true);
    expect(resolveRailGraphInterstationIds("unknown-object")).toEqual([]);
    expect(resolveRailGraphStationConnectionId("station-connection:474151--71264"))
      .toBe("station-connection:474151--71264");
    expect(resolveRailGraphStationConnectionId("unknown-connection")).toBeUndefined();
  });

  it("navigates a direct segment and honors closures by graph or SVG ID", () => {
    const route = findRailRoute("IDFM:72126", "IDFM:72168", { maxTransfers: 0 });
    expect(route).toMatchObject({
      fromStationId: "IDFM:72126",
      toStationId: "IDFM:72168",
      transferCount: 0,
      lineCodes: ["M14"],
      interstationIds: ["M14-IZ-72168--72126"],
      svgInterstationObjectIds: ["interstation-M14-72126--72168"],
    });
    expect(route?.steps).toHaveLength(1);
    expect(findRailRoute("station-72126", "IDFM:72168", {
      maxTransfers: 0,
      blockedInterstationIds: ["interstation-M14-72126--72168"],
    })).toBeNull();
    expect(findRailRoute("IDFM:72126", "IDFM:72168", {
      maxTransfers: 0,
      disabledLineCodes: ["M14"],
    })).toBeNull();
  });

  it("charges an explicit correspondence instead of changing lines instantly", () => {
    const route = findRailRoute("IDFM:71382", "IDFM:71324", { maxTransfers: 2 });
    expect(route).not.toBeNull();
    expect(route?.transferCount).toBe(1);
    expect(route?.lineCodes).toEqual(["M13", "M12"]);
    expect(route?.steps.map((step) => step.kind)).toEqual([
      "interstation",
      "transfer",
      "interstation",
    ]);
    expect(route?.estimatedTravelSeconds).toBeGreaterThanOrEqual(
      RAIL_INTERDEPENDENCE_GRAPH.policy.costModel.defaultTransferSeconds,
    );
  });

  it("navigates documented cross-station connections without importing proximity shortcuts", () => {
    const official = findRailRoute("IDFM:478926", "IDFM:71337", { maxTransfers: 1 });
    expect(official).toMatchObject({
      transferCount: 1,
      interstationIds: [],
      transferIds: [],
      stationConnectionIds: ["station-connection:478926--71337"],
    });
    expect(official?.steps).toEqual([
      expect.objectContaining({
        kind: "station-connection",
        fromStationId: "IDFM:478926",
        toStationId: "IDFM:71337",
        estimatedSeconds: 405,
      }),
    ]);
    expect(findRailRoute("IDFM:478926", "IDFM:71337", {
      maxTransfers: 0,
      stationConnectionPolicy: "none",
    })).toBeNull();

    expect(findRailRoute("IDFM:473829", "IDFM:73844", { maxTransfers: 1 })).toBeNull();
    const mappedWalking = findRailRoute("IDFM:473829", "IDFM:73844", {
      maxTransfers: 1,
      stationConnectionPolicy: "all",
    });
    expect(mappedWalking?.stationConnectionIds).toEqual([
      "station-connection:473829--73844",
    ]);
    expect(mappedWalking?.steps[0]?.kind).toBe("station-connection");
  });

  it("uses exactly the three active April 2026 documentary public-way links", () => {
    const documentary = RAIL_GRAPH_STATION_CONNECTIONS.filter(
      (connection) => connection.evidence.selectionBasis === "official-documentary",
    );
    expect(documentary.map((connection) => connection.id).sort()).toEqual([
      "station-connection:478733--71359",
      "station-connection:478733--71363",
      "station-connection:71363--71410",
    ]);
    expect(documentary.every(
      (connection) => connection.category === "public-way-authorized",
    )).toBe(true);
    expect(RAIL_GRAPH_STATION_CONNECTIONS.some(
      (connection) => connection.id === "station-connection:474149--71410",
    )).toBe(false);

    const poissonniereToNord = findRailRoute("IDFM:71363", "IDFM:71410", {
      metric: "fewest-links",
      maxTransfers: 1,
    });
    expect(poissonniereToNord).toMatchObject({
      transferCount: 1,
      stationConnectionIds: ["station-connection:71363--71410"],
      steps: [
        {
          kind: "station-connection",
          linkId: "station-connection:71363--71410",
          fromStationId: "IDFM:71363",
          toStationId: "IDFM:71410",
          estimatedSeconds: 700,
        },
      ],
    });
  });

  it("computes a bounded direct, primary and secondary incident envelope", () => {
    const direct = analyzeRailImpact(
      { interstationIds: ["interstation-M14-72126--72168"] },
      { maxElapsedSeconds: 0, maxTransfers: 0 },
    );
    expect(direct.source.interstationIds).toEqual(["M14-IZ-72168--72126"]);
    expect(direct.affectedStations.map((station) => station.stationId).sort()).toEqual([
      "IDFM:72126",
      "IDFM:72168",
    ]);
    expect(direct.affectedStations.every((station) => station.level === "direct")).toBe(true);
    expect(direct.affectedInterstations).toEqual([
      expect.objectContaining({
        linkId: "M14-IZ-72168--72126",
        earliestSeconds: 0,
        level: "direct",
      }),
    ]);
    expect(direct.svgInterstationObjectIds).toEqual(["interstation-M14-72126--72168"]);

    const sameLine = analyzeRailImpact(
      { interstationIds: ["M14-IZ-72168--72126"] },
      { maxElapsedSeconds: 600, maxTransfers: 0 },
    );
    expect(sameLine.affectedLineCodes).toEqual(["M14"]);
    expect(sameLine.affectedTransfers).toHaveLength(0);
    expect(sameLine.affectedStations.some((station) => station.level === "primary")).toBe(true);

    const withCorrespondence = analyzeRailImpact(
      { interstationIds: ["M14-IZ-72168--72126"] },
      { maxElapsedSeconds: 900, maxTransfers: 1 },
    );
    expect(withCorrespondence.affectedLineCodes).toContain("M13");
    expect(withCorrespondence.affectedTransfers.length).toBeGreaterThan(0);
    expect(withCorrespondence.affectedStations.some((station) => station.level === "secondary")).toBe(true);
    expect(withCorrespondence.diagnostics.reachedLineNodeCount).toBeGreaterThan(
      sameLine.diagnostics.reachedLineNodeCount,
    );
  });

  it("models a station-connection incident as a direct two-endpoint dependency", () => {
    const impact = analyzeRailImpact(
      { stationConnectionIds: ["station-connection:474151--71264"] },
      { maxElapsedSeconds: 0, maxTransfers: 0 },
    );
    expect(impact).toMatchObject({
      model: "bounded-weighted-topological-envelope-v2",
      source: { stationConnectionIds: ["station-connection:474151--71264"] },
      limits: { stationConnectionPolicy: "official-only" },
      diagnostics: { reachedStationConnectionCount: 1 },
    });
    expect(impact.affectedStations.map((station) => station.stationId).sort()).toEqual([
      "IDFM:474151",
      "IDFM:71264",
    ]);
    expect(impact.affectedStationConnections).toEqual([
      expect.objectContaining({
        linkId: "station-connection:474151--71264",
        earliestSeconds: 0,
        transferCount: 0,
        level: "direct",
      }),
    ]);
  });

  it("rejects unknown references and unbounded transfer-state requests", () => {
    expect(() => findRailRoute("unknown", "IDFM:72168")).toThrow("Unknown origin station");
    expect(() => analyzeRailImpact({})).toThrow("At least one incident");
    expect(() => analyzeRailImpact({ stationConnectionIds: ["unknown"] }))
      .toThrow("Unknown incident station connection");
    expect(() => analyzeRailImpact(
      { stationIds: ["IDFM:72126"] },
      { maxTransfers: 13 },
    )).toThrow("maxTransfers");
  });
});
