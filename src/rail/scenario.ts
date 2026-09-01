import type {
  DriverResource,
  Incident,
  LineId,
  PowerSection,
  RailEvent,
  RailSnapshot,
  TrainView,
} from "./domain";
import { classifyIncidentCode } from "../procedures";
import { emptyCircuitViews, routeFor, TRACK_CIRCUITS } from "./topology";

// 26 August 2026, 05:42 CEST (Europe/Paris): the D-1 view for the 27 August plan.
export const SCENARIO_EPOCH = Date.UTC(2026, 7, 26, 3, 42, 0);

interface TrainSeed {
  id: string;
  circulationId: string;
  mission: string;
  lineId: LineId;
  origin: string;
  destination: string;
  direction: 1 | -1;
  routeIndex: number;
  progress: number;
  delaySeconds: number;
  driverId: string | null;
  passengers: number;
}

const TRAIN_SEEDS: TrainSeed[] = [
  {
    id: "MI79-101",
    circulationId: "ERIO42",
    mission: "ERIO",
    lineId: "RER_B",
    origin: "Massy–Palaiseau",
    destination: "Aéroport Charles de Gaulle 2 TGV",
    direction: 1,
    routeIndex: 0,
    progress: 0.24,
    delaySeconds: 45,
    driverId: "ADC-RB-041",
    passengers: 624,
  },
  {
    id: "MI79-205",
    circulationId: "ILOT44",
    mission: "ILOT",
    lineId: "RER_B",
    origin: "Robinson",
    destination: "Mitry - Claye",
    direction: 1,
    routeIndex: 3,
    progress: 0.48,
    delaySeconds: 386,
    driverId: "ADC-RB-017",
    passengers: 771,
  },
  {
    id: "MI84-312",
    circulationId: "KALI06",
    mission: "KALI",
    lineId: "RER_B",
    origin: "Aéroport Charles de Gaulle 2 TGV",
    destination: "Massy–Palaiseau",
    direction: -1,
    routeIndex: 1,
    progress: 0.66,
    delaySeconds: 112,
    driverId: "ADC-RB-063",
    passengers: 492,
  },
  {
    id: "MI09-042",
    circulationId: "QYAN42",
    mission: "QYAN",
    lineId: "RER_A",
    origin: "Cergy-le-Haut",
    destination: "Marne-la-Vallée–Chessy",
    direction: 1,
    routeIndex: 1,
    progress: 0.18,
    delaySeconds: 204,
    driverId: "ADC-RA-038",
    passengers: 853,
  },
  {
    id: "MI09-117",
    circulationId: "NELY44",
    mission: "NELY",
    lineId: "RER_A",
    origin: "Saint-Germain-en-Laye",
    destination: "Boissy-Saint-Léger",
    direction: 1,
    routeIndex: 4,
    progress: 0.32,
    delaySeconds: 72,
    driverId: "ADC-RA-052",
    passengers: 602,
  },
  {
    id: "MI2N-157",
    circulationId: "UPAC43",
    mission: "UPAC",
    lineId: "RER_A",
    origin: "Marne-la-Vallée–Chessy",
    destination: "Cergy-le-Haut",
    direction: -1,
    routeIndex: 2,
    progress: 0.72,
    delaySeconds: 518,
    driverId: "ADC-RA-011",
    passengers: 688,
  },
  {
    id: "MF77-037",
    circulationId: "13-FOUR-037",
    mission: "FOUR",
    lineId: "M13",
    origin: "Châtillon–Montrouge",
    destination: "Saint-Denis–Université",
    direction: 1,
    routeIndex: 0,
    progress: 0.58,
    delaySeconds: 94,
    driverId: "ADC-M13-024",
    passengers: 412,
  },
  {
    id: "MF77-082",
    circulationId: "13-ASNI-082",
    mission: "ASNI",
    lineId: "M13",
    origin: "Châtillon–Montrouge",
    destination: "Les Courtilles",
    direction: 1,
    routeIndex: 3,
    progress: 0.16,
    delaySeconds: 248,
    driverId: "ADC-M13-008",
    passengers: 538,
  },
  {
    id: "MF77-116",
    circulationId: "13-CHAT-116",
    mission: "CHAT",
    lineId: "M13",
    origin: "Saint-Denis–Université",
    destination: "Châtillon–Montrouge",
    direction: -1,
    routeIndex: 1,
    progress: 0.43,
    delaySeconds: 31,
    driverId: "ADC-M13-055",
    passengers: 356,
  },
  {
    id: "MP14-014",
    circulationId: "14-PLYL-014",
    mission: "PLYL",
    lineId: "M14",
    origin: "Aéroport d'Orly",
    destination: "Saint-Denis–Pleyel",
    direction: -1,
    routeIndex: 1,
    progress: 0.36,
    delaySeconds: 0,
    driverId: null,
    passengers: 716,
  },
  {
    id: "MP14-028",
    circulationId: "14-ORLY-028",
    mission: "ORLY",
    lineId: "M14",
    origin: "Saint-Denis–Pleyel",
    destination: "Aéroport d'Orly",
    direction: 1,
    routeIndex: 4,
    progress: 0.62,
    delaySeconds: 48,
    driverId: null,
    passengers: 544,
  },
  {
    id: "MP14-041",
    circulationId: "14-CHAT-041",
    mission: "CHAT",
    lineId: "M14",
    origin: "Aéroport d'Orly",
    destination: "Saint-Denis–Pleyel",
    direction: -1,
    routeIndex: 2,
    progress: 0.27,
    delaySeconds: 0,
    driverId: null,
    passengers: 481,
  },
];

function createTrains(): TrainView[] {
  return TRAIN_SEEDS.map((seed) => {
    const lineRoute = routeFor(seed.lineId, seed.direction);
    const circuit = lineRoute[seed.routeIndex];
    const reverseRoute = routeFor(seed.lineId, -seed.direction as 1 | -1);
    return {
      ...seed,
      circuitId: circuit.id,
      speedKmh: Math.min(seed.lineId.startsWith("RER") ? 72 : 54, circuit.speedLimitKmh),
      status: "running",
      nextStop: circuit.toStation,
      holdTicks: 0,
      quality: "simulated",
      // Keeps TypeScript aware that both route directions are valid at initialization.
      ...(reverseRoute.length === 0 ? { status: "stopped" as const } : {}),
    };
  });
}

const DRIVERS: DriverResource[] = [
  { id: "ADC-RB-041", depot: "Massy", qualifications: ["RER_B"], shiftStart: "05:12", shiftEnd: "12:46", dutyMinutes: 231, status: "assigned", assignedTrainId: "MI79-101" },
  { id: "ADC-RB-017", depot: "Mitry", qualifications: ["RER_B"], shiftStart: "04:58", shiftEnd: "12:22", dutyMinutes: 267, status: "relief-risk", assignedTrainId: "MI79-205" },
  { id: "ADC-RB-063", depot: "Massy", qualifications: ["RER_B"], shiftStart: "06:02", shiftEnd: "13:35", dutyMinutes: 184, status: "assigned", assignedTrainId: "MI84-312" },
  { id: "ADC-RA-038", depot: "Rueil", qualifications: ["RER_A"], shiftStart: "05:20", shiftEnd: "12:51", dutyMinutes: 214, status: "assigned", assignedTrainId: "MI09-042" },
  { id: "ADC-RA-052", depot: "Torcy", qualifications: ["RER_A"], shiftStart: "05:44", shiftEnd: "13:02", dutyMinutes: 171, status: "assigned", assignedTrainId: "MI09-117" },
  { id: "ADC-RA-011", depot: "Achères", qualifications: ["RER_A"], shiftStart: "04:42", shiftEnd: "11:58", dutyMinutes: 289, status: "relief-risk", assignedTrainId: "MI2N-157" },
  { id: "ADC-M13-024", depot: "Châtillon", qualifications: ["M13"], shiftStart: "05:28", shiftEnd: "12:36", dutyMinutes: 198, status: "assigned", assignedTrainId: "MF77-037" },
  { id: "ADC-M13-008", depot: "Châtillon", qualifications: ["M13"], shiftStart: "04:51", shiftEnd: "12:10", dutyMinutes: 252, status: "assigned", assignedTrainId: "MF77-082" },
  { id: "ADC-M13-055", depot: "Châtillon", qualifications: ["M13"], shiftStart: "06:18", shiftEnd: "13:42", dutyMinutes: 142, status: "assigned", assignedTrainId: "MF77-116" },
  { id: "ADC-RB-088", depot: "Massy", qualifications: ["RER_B"], shiftStart: "07:00", shiftEnd: "14:34", dutyMinutes: 0, status: "reserve", assignedTrainId: null },
  { id: "ADC-RA-091", depot: "Sucy", qualifications: ["RER_A"], shiftStart: "06:45", shiftEnd: "14:18", dutyMinutes: 0, status: "reserve", assignedTrainId: null },
];

function circuitIds(sectionId: string): string[] {
  return TRACK_CIRCUITS.filter((circuit) => circuit.electricalSectionId === sectionId).map(
    (circuit) => circuit.id,
  );
}

function powerSection(
  id: string,
  name: string,
  lineIds: LineId[],
  nominalVoltage: number,
  loadPercent: number,
  status: "energized" | "degraded" = "energized",
): PowerSection {
  return {
    id,
    name,
    lineIds,
    nominalVoltage,
    voltage: Math.round(nominalVoltage * (status === "degraded" ? 0.89 : 0.98)),
    currentAmps: Math.round(780 + loadPercent * 11.4),
    loadPercent,
    status,
    substation: `PR-${name.toUpperCase().replaceAll(" ", "-")}`,
    circuitIds: circuitIds(id),
    updatedAt: SCENARIO_EPOCH,
  };
}

function createPowerSections(): PowerSection[] {
  return [
    powerSection("PWR-RA-OUEST", "RER A central west", ["RER_A"], 1500, 67),
    powerSection("PWR-RA-EST", "RER A central east", ["RER_A"], 1500, 74),
    powerSection("PWR-RB-SUD", "RER B south", ["RER_B"], 1500, 71),
    powerSection("PWR-RB-NORD", "RER B central north", ["RER_B"], 1500, 88, "degraded"),
    powerSection("PWR-M13-SUD", "Metro 13 south", ["M13"], 750, 63),
    powerSection("PWR-M13-NORD", "Metro 13 north", ["M13"], 750, 81),
    powerSection("PWR-M14-NORD", "Metro 14 north", ["M14"], 750, 77),
    powerSection("PWR-M14-SUD", "Metro 14 south", ["M14"], 750, 69),
  ];
}

function createIncidents(): Incident[] {
  return [
    {
      id: "INC-2407",
      incidentCode: classifyIncidentCode({
        type: "passenger",
        targetType: "station",
        effect: "station-closure",
      }),
      title: "Passenger reported on track",
      type: "passenger",
      severity: "high",
      status: "active",
      lineIds: ["M13"],
      location: "Place de Clichy → La Fourche",
      startedAt: SCENARIO_EPOCH - 8 * 60_000,
      blockedCircuitIds: ["M13-05-A"],
      impactedTrainIds: ["MF77-082", "MF77-116"],
      owner: "M13 traffic controller",
      summary: "Checks in progress. Trains are being held upstream of the affected section.",
      actions: ["Station agent dispatched", "Traffic control notified", "Passenger information issued"],
      target: { type: "station", id: "Place de Clichy" },
      effect: "station-closure",
    },
    {
      id: "INC-2410",
      incidentCode: classifyIncidentCode({
        type: "power",
        targetType: "power",
        effect: "degrade-power",
      }),
      title: "Intermittent low voltage",
      type: "power",
      severity: "medium",
      status: "acknowledged",
      lineIds: ["RER_B"],
      location: "RER B central north section",
      startedAt: SCENARIO_EPOCH - 17 * 60_000,
      blockedCircuitIds: [],
      impactedTrainIds: ["MI79-205"],
      owner: "Power duty manager",
      summary: "Voltage is stable but degraded. Enhanced monitoring at Gare du Nord.",
      actions: ["Alarm acknowledged", "Measurement every 30 seconds", "Power team notified"],
      target: { type: "power", id: "PWR-RB-NORD" },
      effect: "degrade-power",
    },
    {
      id: "INC-J1-32",
      incidentCode: classifyIncidentCode({
        type: "works",
        targetType: "interstation",
        effect: "block-interstation",
      }),
      title: "Overnight works — planned closure",
      type: "works",
      severity: "low",
      status: "planned",
      lineIds: ["RER_B"],
      location: "Gare du Nord → Aulnay-sous-Bois",
      startedAt: SCENARIO_EPOCH + (17 * 60 + 18) * 60_000,
      blockedCircuitIds: [],
      impactedTrainIds: [],
      owner: "D-1 planning",
      summary: "Engineering possession scheduled at 23:00. Last constrained service at 22:47.",
      actions: ["Adjusted plan v3 calculated", "Replacement buses pre-positioned"],
      target: { type: "interstation", id: "RER_B:GARE_DU_NORD-AULNAY" },
      effect: "block-interstation",
    },
  ];
}

const INITIAL_EVENTS: RailEvent[] = [
  {
    id: "EVT-001",
    timestamp: SCENARIO_EPOCH - 2 * 60_000,
    kind: "planning",
    title: "D-1 plan v3 certifiable",
    detail: "98.4% of services covered; two reliefs under monitoring.",
    severity: "low",
  },
  {
    id: "EVT-002",
    timestamp: SCENARIO_EPOCH - 60_000,
    kind: "power",
    title: "RER B central north in degraded mode",
    detail: "Measured voltage below nominal; no traction power outage.",
    severity: "medium",
  },
];

export function createInitialSnapshot(): RailSnapshot {
  const trains = createTrains();
  const occupied = new Map(trains.map((train) => [train.circuitId, train]));
  const incidents = createIncidents();
  const blocked = new Set(
    incidents
      .filter((incident) => incident.status === "active")
      .flatMap((incident) => incident.blockedCircuitIds),
  );

  return {
    decisionRevision: 1,
    revision: 1,
    timestamp: SCENARIO_EPOCH,
    source: "simulation",
    scenarioName: "Morning peak — D-1 events",
    trains,
    circuits: emptyCircuitViews().map((circuit) => {
      const train = occupied.get(circuit.id);
      return {
        ...circuit,
        state: train ? "occupied" : blocked.has(circuit.id) ? "blocked" : "free",
        occupiedBy: train?.id ?? null,
        circulationId: train?.circulationId ?? null,
      };
    }),
    drivers: DRIVERS,
    incidents,
    powerSections: createPowerSections(),
    events: INITIAL_EVENTS,
  };
}
