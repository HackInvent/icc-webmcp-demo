import type {
  CircuitView,
  Direction,
  LineDefinition,
  LineId,
  TrackCircuitDefinition,
} from "./domain";

export const LINES: LineDefinition[] = [
  {
    id: "RER_A",
    shortName: "A",
    name: "RER A",
    color: "#E3051B",
    textColor: "#ffffff",
    axis: "East–west regional express axis",
    operator: "RATP & SNCF Voyageurs",
    controlSystem: "SACEM semi-automatic train control on the central section",
    rollingStock: "MI 09 / MI 2N Altéo",
    powerSupply: "1.5 kV DC / 25 kV AC (Cergy and Poissy SNCF branches)",
    lineLengthKm: 109,
    stationCount: 46,
    termini: [
      "Saint-Germain-en-Laye / Cergy-le-Haut / Poissy",
      "Boissy-Saint-Léger / Marne-la-Vallée–Chessy",
    ],
    simulatedCorridor: "Central corridor · La Défense → Nation",
    wikipediaUrl: "https://fr.wikipedia.org/wiki/Ligne_A_du_RER_d%27%C3%8Ele-de-France",
    y: 94,
    stations: [
      "La Défense",
      "Charles de Gaulle – Étoile",
      "Auber",
      "Châtelet – Les Halles",
      "Gare de Lyon",
      "Nation",
    ],
  },
  {
    id: "RER_B",
    shortName: "B",
    name: "RER B",
    color: "#5ca8ff",
    textColor: "#07131e",
    axis: "North-east–south-west regional express axis",
    operator: "RATP & SNCF Voyageurs",
    controlSystem: "Driver-operated",
    rollingStock: "MI 79 / MI 84",
    powerSupply: "1.5 kV DC (RATP south) / 25 kV AC (SNCF north) overhead",
    lineLengthKm: 80,
    stationCount: 47,
    termini: [
      "Aéroport Charles de Gaulle 2 TGV / Mitry - Claye",
      "Robinson / Saint-Rémy-lès-Chevreuse",
    ],
    simulatedCorridor: "Central corridor · Denfert-Rochereau → Gare du Nord",
    wikipediaUrl: "https://fr.wikipedia.org/wiki/Ligne_B_du_RER_d%27%C3%8Ele-de-France",
    y: 224,
    stations: [
      "Denfert-Rochereau",
      "Port-Royal",
      "Luxembourg",
      "Saint-Michel – Notre-Dame",
      "Châtelet – Les Halles",
      "Gare du Nord",
    ],
  },
  {
    id: "M13",
    shortName: "13",
    name: "Metro 13",
    color: "#79d2c2",
    textColor: "#061411",
    axis: "Branched north–south Paris metro axis",
    operator: "RATP",
    controlSystem: "Driver-operated with OURAGAN train control",
    rollingStock: "MF 77",
    powerSupply: "750 V DC third rail",
    lineLengthKm: 24.4,
    stationCount: 32,
    termini: ["Les Courtilles / Saint-Denis–Université", "Châtillon–Montrouge"],
    simulatedCorridor: "Central corridor · Champs-Élysées – Clemenceau → La Fourche",
    wikipediaUrl: "https://fr.wikipedia.org/wiki/Ligne_13_du_m%C3%A9tro_de_Paris",
    y: 354,
    stations: [
      "Champs-Élysées – Clemenceau",
      "Miromesnil",
      "Saint-Lazare",
      "Liège",
      "Place de Clichy",
      "La Fourche",
    ],
  },
  {
    id: "M14",
    shortName: "14",
    name: "Metro 14",
    color: "#b684f7",
    textColor: "#160b25",
    axis: "North-west–south-east fully automated metro axis",
    operator: "RATP",
    controlSystem: "Fully automatic SAET train control",
    rollingStock: "MP 14 CA · 8-car formation",
    powerSupply: "750 V DC guide bars",
    lineLengthKm: 27.8,
    stationCount: 21,
    termini: ["Saint-Denis–Pleyel", "Aéroport d'Orly"],
    simulatedCorridor: "Central corridor · Saint-Lazare → Bercy",
    wikipediaUrl: "https://fr.wikipedia.org/wiki/Ligne_14_du_m%C3%A9tro_de_Paris",
    y: 484,
    stations: ["Saint-Lazare", "Madeleine", "Pyramides", "Châtelet", "Gare de Lyon", "Bercy"],
  },
];

const X_POSITIONS = [88, 272, 456, 640, 824, 1008];

function circuitPrefix(lineId: LineId): string {
  return lineId.replace("RER_", "R");
}

function sectionId(lineId: LineId, segmentIndex: number): string {
  const orientation =
    lineId === "RER_A"
      ? segmentIndex < 3
        ? "OUEST"
        : "EST"
      : lineId === "M14"
        ? segmentIndex < 3
          ? "NORD"
          : "SUD"
        : segmentIndex < 3
          ? "SUD"
          : "NORD";
  return `PWR-${circuitPrefix(lineId)}-${orientation}`;
}

// These lengths and limits describe the condensed ICC demonstration corridors,
// not the full-line values carried in LineDefinition.
const SIMULATED_SEGMENT_LENGTHS_METERS: Record<LineId, readonly number[]> = {
  RER_A: [3_900, 1_700, 1_800, 2_600, 2_900],
  RER_B: [1_500, 800, 900, 900, 2_200],
  M13: [850, 900, 650, 750, 800],
  M14: [900, 700, 1_000, 1_700, 1_000],
};

const SIMULATED_SPEED_LIMITS_KMH: Record<LineId, readonly number[]> = {
  RER_A: [90, 80, 80, 90, 90],
  RER_B: [90, 80, 70, 80, 90],
  M13: [60, 60, 50, 55, 60],
  M14: [70, 70, 70, 80, 70],
};

function makeDirectionCircuits(line: LineDefinition, direction: Direction): TrackCircuitDefinition[] {
  const suffix = direction === 1 ? "A" : "R";
  const laneOffset = direction === 1 ? -9 : 9;
  const indices = direction === 1 ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];

  return indices.map((segmentIndex) => {
    const fromIndex = direction === 1 ? segmentIndex : segmentIndex + 1;
    const toIndex = direction === 1 ? segmentIndex + 1 : segmentIndex;
    const prefix = circuitPrefix(line.id);
    return {
      id: `${prefix}-${String(segmentIndex + 1).padStart(2, "0")}-${suffix}`,
      label: `${prefix} ${String(segmentIndex + 1).padStart(2, "0")}${suffix}`,
      lineId: line.id,
      direction,
      segmentIndex,
      fromStation: line.stations[fromIndex],
      toStation: line.stations[toIndex],
      x1: X_POSITIONS[fromIndex],
      x2: X_POSITIONS[toIndex],
      y: line.y + laneOffset,
      lengthMeters: SIMULATED_SEGMENT_LENGTHS_METERS[line.id][segmentIndex],
      speedLimitKmh: SIMULATED_SPEED_LIMITS_KMH[line.id][segmentIndex],
      electricalSectionId: sectionId(line.id, segmentIndex),
    };
  });
}

export const TRACK_CIRCUITS: TrackCircuitDefinition[] = LINES.flatMap((line) => [
  ...makeDirectionCircuits(line, 1),
  ...makeDirectionCircuits(line, -1),
]);

export function routeFor(lineId: LineId, direction: Direction): TrackCircuitDefinition[] {
  return TRACK_CIRCUITS.filter(
    (circuit) => circuit.lineId === lineId && circuit.direction === direction,
  ).sort((left, right) => {
    if (direction === 1) return left.segmentIndex - right.segmentIndex;
    return right.segmentIndex - left.segmentIndex;
  });
}

export function circuitDefinition(id: string): TrackCircuitDefinition {
  const result = TRACK_CIRCUITS.find((circuit) => circuit.id === id);
  if (!result) throw new Error(`Unknown track circuit: ${id}`);
  return result;
}

export function emptyCircuitViews(): CircuitView[] {
  return TRACK_CIRCUITS.map((circuit) => ({
    ...circuit,
    state: "free",
    occupiedBy: null,
    circulationId: null,
    reservedBy: null,
    closure: null,
  }));
}

export function lineDefinition(id: LineId): LineDefinition {
  const line = LINES.find((candidate) => candidate.id === id);
  if (!line) throw new Error(`Unknown line: ${id}`);
  return line;
}
