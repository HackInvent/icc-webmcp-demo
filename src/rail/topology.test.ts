import { describe, expect, it } from "vitest";
import { SCENARIO_EPOCH, createInitialSnapshot } from "./scenario";
import { LINES, TRACK_CIRCUITS, routeFor } from "./topology";

describe("realistic Paris ICC topology", () => {
  it("defines the intended lines with Wikipedia reference metadata", () => {
    expect(LINES.map((line) => line.id)).toEqual(["RER_A", "RER_B", "M13", "M14"]);

    expect(LINES.map(({ id, lineLengthKm, stationCount }) => ({
      id,
      lineLengthKm,
      stationCount,
    }))).toEqual([
      { id: "RER_A", lineLengthKm: 109, stationCount: 46 },
      { id: "RER_B", lineLengthKm: 80, stationCount: 47 },
      { id: "M13", lineLengthKm: 24.4, stationCount: 32 },
      { id: "M14", lineLengthKm: 27.8, stationCount: 21 },
    ]);

    for (const line of LINES) {
      expect(line.wikipediaUrl).toMatch(/^https:\/\/fr\.wikipedia\.org\/wiki\//);
      expect(line.axis).not.toHaveLength(0);
      expect(line.operator).not.toHaveLength(0);
      expect(line.controlSystem).not.toHaveLength(0);
      expect(line.rollingStock).not.toHaveLength(0);
      expect(line.powerSupply).not.toHaveLength(0);
      expect(line.termini).not.toHaveLength(0);
      expect(line.simulatedCorridor).toContain("Central corridor");
    }

    expect(LINES.find((line) => line.id === "RER_A")).toEqual(
      expect.objectContaining({
        color: "#E3051B",
        operator: "RATP & SNCF Voyageurs",
        rollingStock: "MI 09 / MI 2N Altéo",
        controlSystem: "SACEM semi-automatic train control on the central section",
        powerSupply: "1.5 kV DC / 25 kV AC (Cergy and Poissy SNCF branches)",
      }),
    );
    expect(LINES.find((line) => line.id === "RER_B")).toEqual(
      expect.objectContaining({
        operator: "RATP & SNCF Voyageurs",
        controlSystem: "Driver-operated",
      }),
    );
    expect(LINES.find((line) => line.id === "M14")?.powerSupply).toBe(
      "750 V DC guide bars",
    );
  });

  it("anchors the operational view at 01:00 PM Paris time and planned works at 11:00 PM", () => {
    expect(SCENARIO_EPOCH).toBe(Date.UTC(2026, 7, 28, 11, 0, 0));
    const plannedWorks = createInitialSnapshot().incidents.find(
      (incident) => incident.id === "INC-J1-32",
    );
    expect(plannedWorks?.startedAt).toBe(Date.UTC(2026, 7, 28, 21, 0, 0));
  });
  it("uses consecutive, ordered central-Paris corridors", () => {
    expect(LINES.find((line) => line.id === "RER_A")?.stations).toEqual([
      "La Défense",
      "Charles de Gaulle – Étoile",
      "Auber",
      "Châtelet – Les Halles",
      "Gare de Lyon",
      "Nation",
    ]);
    expect(LINES.find((line) => line.id === "RER_B")?.stations).toEqual([
      "Denfert-Rochereau",
      "Port-Royal",
      "Luxembourg",
      "Saint-Michel – Notre-Dame",
      "Châtelet – Les Halles",
      "Gare du Nord",
    ]);
    expect(LINES.find((line) => line.id === "M13")?.stations).toEqual([
      "Champs-Élysées – Clemenceau",
      "Miromesnil",
      "Saint-Lazare",
      "Liège",
      "Place de Clichy",
      "La Fourche",
    ]);
    expect(LINES.find((line) => line.id === "M14")?.stations).toEqual([
      "Saint-Lazare",
      "Madeleine",
      "Pyramides",
      "Châtelet",
      "Gare de Lyon",
      "Bercy",
    ]);

    for (const line of LINES) {
      const forward = routeFor(line.id, 1);
      expect(forward.map((circuit) => circuit.fromStation)).toEqual(line.stations.slice(0, -1));
      expect(forward.map((circuit) => circuit.toStation)).toEqual(line.stations.slice(1));
    }
  });

  it("builds 40 unique CDVs with RER A and no residual RER D", () => {
    expect(TRACK_CIRCUITS).toHaveLength(40);
    expect(new Set(TRACK_CIRCUITS.map((circuit) => circuit.id)).size).toBe(40);
    expect(TRACK_CIRCUITS.filter((circuit) => circuit.lineId === "RER_A")).toHaveLength(10);
    expect(TRACK_CIRCUITS.some((circuit) => circuit.id.startsWith("RA-"))).toBe(true);
    expect(TRACK_CIRCUITS.some((circuit) => circuit.id.startsWith("RD-"))).toBe(false);
    expect(TRACK_CIRCUITS.every((circuit) => circuit.lengthMeters > 0)).toBe(true);
    expect(TRACK_CIRCUITS.every((circuit) => circuit.speedLimitKmh > 0)).toBe(true);
  });

  it("uses realistic rolling stock, mission codes, branches, and driver depots", () => {
    const snapshot = createInitialSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("RER_D");
    expect(serialized).not.toContain("Z2N");
    expect(serialized).not.toContain("MI20");

    expect(snapshot.trains.map((train) => train.id)).toEqual([
      "MI79-101",
      "MI79-205",
      "MI84-312",
      "MI09-042",
      "MI09-117",
      "MI2N-157",
      "MF77-037",
      "MF77-082",
      "MF77-116",
      "MP14-014",
      "MP14-028",
      "MP14-041",
    ]);

    const expectedRerMissions = [
      {
        id: "MI79-101",
        circulationId: "ERIO42",
        mission: "ERIO",
        origin: "Massy–Palaiseau",
        destination: "Aéroport Charles de Gaulle 2 TGV",
        direction: 1,
      },
      {
        id: "MI79-205",
        circulationId: "ILOT44",
        mission: "ILOT",
        origin: "Robinson",
        destination: "Mitry - Claye",
        direction: 1,
      },
      {
        id: "MI84-312",
        circulationId: "KALI06",
        mission: "KALI",
        origin: "Aéroport Charles de Gaulle 2 TGV",
        destination: "Massy–Palaiseau",
        direction: -1,
      },
      {
        id: "MI09-042",
        circulationId: "QYAN42",
        mission: "QYAN",
        origin: "Cergy-le-Haut",
        destination: "Marne-la-Vallée–Chessy",
        direction: 1,
      },
      {
        id: "MI09-117",
        circulationId: "NELY44",
        mission: "NELY",
        origin: "Saint-Germain-en-Laye",
        destination: "Boissy-Saint-Léger",
        direction: 1,
      },
      {
        id: "MI2N-157",
        circulationId: "UPAC43",
        mission: "UPAC",
        origin: "Marne-la-Vallée–Chessy",
        destination: "Cergy-le-Haut",
        direction: -1,
      },
    ];

    for (const expectedTrain of expectedRerMissions) {
      expect(snapshot.trains.find((train) => train.id === expectedTrain.id)).toEqual(
        expect.objectContaining(expectedTrain),
      );
    }

    expect(
      snapshot.drivers
        .filter((driver) => driver.qualifications.includes("RER_A"))
        .map((driver) => [driver.id, driver.depot]),
    ).toEqual([
      ["ADC-RA-038", "Rueil"],
      ["ADC-RA-052", "Torcy"],
      ["ADC-RA-011", "Achères"],
      ["ADC-RA-091", "Sucy"],
    ]);
  });

  it("maps every CDV to a non-empty, voltage-correct power section", () => {
    const snapshot = createInitialSnapshot();
    expect(snapshot.powerSections.map((section) => section.id)).toEqual([
      "PWR-RA-OUEST",
      "PWR-RA-EST",
      "PWR-RB-SUD",
      "PWR-RB-NORD",
      "PWR-M13-SUD",
      "PWR-M13-NORD",
      "PWR-M14-NORD",
      "PWR-M14-SUD",
    ]);

    for (const section of snapshot.powerSections) {
      expect(section.circuitIds.length).toBeGreaterThan(0);
      expect(section.nominalVoltage).toBe(section.lineIds[0].startsWith("RER") ? 1500 : 750);
    }

    const poweredCircuitIds = new Set(
      snapshot.powerSections.flatMap((section) => section.circuitIds),
    );
    expect(poweredCircuitIds).toEqual(new Set(TRACK_CIRCUITS.map((circuit) => circuit.id)));
  });
});
