import type { NativeLineCode } from "./nativeNetwork";

export type RollingStockConfidence = "high" | "medium" | "low";
export type RollingStockTractionClass = "steel-wheel" | "rubber-tyred" | "rer-heavy-rail";
export type RollingStockAssignmentRole = "reference" | "in-service" | "transition";

export interface RollingStockFamily {
  id: string;
  name: string;
  cars: number;
  composition: string;
  referenceCapacity: number;
  capacityBasis: string;
  standingDensity: number | null;
  tractionClass: RollingStockTractionClass;
  sourceUrl: string;
  sourceLabel: string;
  confidence: RollingStockConfidence;
  note?: string;
}

export interface RollingStockAssignment {
  familyId: string;
  role: RollingStockAssignmentRole;
  referenceUnits: number;
  note: string;
}

export interface RollingStockLineProfile {
  lineCode: NativeLineCode;
  displayName: string;
  mode: "metro" | "rer";
  assignments: readonly RollingStockAssignment[];
  sourceUrl: string;
  sourceLabel: string;
}

const METRO_FLEET_SOURCE =
  "https://fr.wikipedia.org/wiki/Mat%C3%A9riel_roulant_du_m%C3%A9tro_de_Paris";

export const ROLLING_STOCK_FAMILIES: Readonly<Record<string, RollingStockFamily>> = Object.freeze({
  mp05: {
    id: "mp05", name: "MP 05", cars: 6, composition: "6-car automated trainset",
    referenceCapacity: 698, capacityBasis: "Published comfort/reference capacity",
    standingDensity: 4, tractionClass: "rubber-tyred",
    sourceUrl: "https://fr.wikipedia.org/wiki/MP_05", sourceLabel: "MP 05 public technical sheet",
    confidence: "high",
  },
  mf01: {
    id: "mf01", name: "MF 01", cars: 5, composition: "S1+N1+N3+N2+S2",
    referenceCapacity: 581, capacityBasis: "Comfort load at 4 standing passengers/m²",
    standingDensity: 4, tractionClass: "steel-wheel",
    sourceUrl: "https://fr.wikipedia.org/wiki/MF_01", sourceLabel: "MF 01 public technical sheet",
    confidence: "high",
  },
  mf67_5: {
    id: "mf67_5", name: "MF 67", cars: 5, composition: "Representative five-car formation",
    referenceCapacity: 575, capacityBasis: "RATP statistical reference at 4 standing passengers/m²",
    standingDensity: 4, tractionClass: "steel-wheel",
    sourceUrl: "https://temis.documentation.developpement-durable.gouv.fr/docs/Temis/0004/Temis-0004134/3373_2005.pdf",
    sourceLabel: "French transport statistics — RATP source", confidence: "high",
    note: "Interior layouts vary by sub-series; this is a comparison reference, not a consist roster.",
  },
  mf67_3: {
    id: "mf67_3", name: "MF 67 (3-car)", cars: 3, composition: "M+B+M",
    referenceCapacity: 425, capacityBasis: "Published line 3 bis reference; basis is less explicit than the five-car statistic",
    standingDensity: 4, tractionClass: "steel-wheel",
    sourceUrl: "https://fr.wikipedia.org/wiki/MF_67", sourceLabel: "MF 67 public technical sheet",
    confidence: "medium",
    note: "Kept separate from the five-car MF 67 because published capacities are not directly comparable.",
  },
  mp14_ca6: {
    id: "mp14_ca6", name: "MP 14 CA", cars: 6, composition: "6-car automated trainset",
    referenceCapacity: 696, capacityBasis: "Published total capacity",
    standingDensity: 4, tractionClass: "rubber-tyred",
    sourceUrl: "https://fr.wikipedia.org/wiki/MP_14", sourceLabel: "MP 14 public technical sheet",
    confidence: "high",
  },
  mp14_cc5: {
    id: "mp14_cc5", name: "MP 14 CC", cars: 5, composition: "5-car trainset with driving cab",
    referenceCapacity: 562, capacityBasis: "Published total capacity",
    standingDensity: 4, tractionClass: "rubber-tyred",
    sourceUrl: "https://fr.wikipedia.org/wiki/MP_14", sourceLabel: "MP 14 public technical sheet",
    confidence: "high",
  },
  mp14_ca8: {
    id: "mp14_ca8", name: "MP 14 CA", cars: 8, composition: "8-car automated trainset",
    referenceCapacity: 932, capacityBasis: "Published total capacity",
    standingDensity: 4, tractionClass: "rubber-tyred",
    sourceUrl: "https://fr.wikipedia.org/wiki/MP_14", sourceLabel: "MP 14 public technical sheet",
    confidence: "high",
  },
  mp89_ca6: {
    id: "mp89_ca6", name: "MP 89 CA", cars: 6, composition: "S+N+N+N+N+S",
    referenceCapacity: 722, capacityBasis: "Comfort load at 4 standing passengers/m²",
    standingDensity: 4, tractionClass: "rubber-tyred",
    sourceUrl: "https://fr.wikipedia.org/wiki/MP_89", sourceLabel: "MP 89 public technical sheet",
    confidence: "high",
  },
  mp89_cc5: {
    id: "mp89_cc5", name: "MP 89 CC", cars: 5, composition: "S+N+N+N+S",
    referenceCapacity: 600, capacityBasis: "Published shortened five-car line 6 formation",
    standingDensity: 4, tractionClass: "rubber-tyred",
    sourceUrl: "https://fr.wikipedia.org/wiki/MP_89", sourceLabel: "MP 89 public technical sheet",
    confidence: "medium",
  },
  mp73_5: {
    id: "mp73_5", name: "MP 73", cars: 5, composition: "Five-car trainset",
    referenceCapacity: 575, capacityBasis: "RATP statistical reference at 4 standing passengers/m²",
    standingDensity: 4, tractionClass: "rubber-tyred",
    sourceUrl: "https://temis.documentation.developpement-durable.gouv.fr/docs/Temis/0004/Temis-0004134/3373_2005.pdf",
    sourceLabel: "French transport statistics — RATP source", confidence: "high",
  },
  mf77: {
    id: "mf77", name: "MF 77", cars: 5, composition: "M+B+NA+B+M",
    referenceCapacity: 722, capacityBasis: "Published total capacity",
    standingDensity: 4, tractionClass: "steel-wheel",
    sourceUrl: "https://fr.wikipedia.org/wiki/MF_77", sourceLabel: "MF 77 public technical sheet",
    confidence: "high",
  },
  mf88: {
    id: "mf88", name: "MF 88", cars: 3, composition: "Three-car articulated trainset",
    referenceCapacity: 425, capacityBasis: "Comfort load at 4 standing passengers/m²",
    standingDensity: 4, tractionClass: "steel-wheel",
    sourceUrl: "https://fr.wikipedia.org/wiki/MF_88", sourceLabel: "MF 88 public technical sheet",
    confidence: "high",
  },
  mf19_5: {
    id: "mf19_5", name: "MF 19", cars: 5, composition: "Five-car line 10 configuration",
    referenceCapacity: 590, capacityBasis: "Published capacity at four passengers/m² for the five-car configuration",
    standingDensity: 4, tractionClass: "steel-wheel",
    sourceUrl: "https://fr.wikipedia.org/wiki/MF_19",
    sourceLabel: "MF 19 public technical sheet", confidence: "high",
  },
  mi09: {
    id: "mi09", name: "MI 09", cars: 5, composition: "R+M+M+M+R (single element)",
    referenceCapacity: 1305, capacityBasis: "Published capacity per five-car element",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/MI_09", sourceLabel: "MI 09 public technical sheet",
    confidence: "high",
  },
  alteo: {
    id: "alteo", name: "MI 2N Altéo", cars: 5, composition: "Five-car double-deck element",
    referenceCapacity: 1305, capacityBasis: "Published capacity per five-car element",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/Alt%C3%A9o", sourceLabel: "Altéo public technical sheet",
    confidence: "high",
  },
  mi79: {
    id: "mi79", name: "MI 79", cars: 4, composition: "M+R+R+M (single element)",
    referenceCapacity: 850, capacityBasis: "Published nominal capacity per four-car element",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/MI_79", sourceLabel: "MI 79 public technical sheet",
    confidence: "medium",
  },
  mi84: {
    id: "mi84", name: "MI 84", cars: 4, composition: "M+R+R+M (single element)",
    referenceCapacity: 850, capacityBasis: "Public nominal capacity; retained as a fleet comparison",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/MI_84", sourceLabel: "MI 84 public technical sheet",
    confidence: "medium",
  },
  z5600_4: {
    id: "z5600_4", name: "Z 5600", cars: 4, composition: "Four-car double-deck element",
    referenceCapacity: 1021, capacityBasis: "Published capacity for the four-car variant",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/Z_5600", sourceLabel: "Z 5600 public technical sheet",
    confidence: "high",
  },
  z5600_6: {
    id: "z5600_6", name: "Z 5600", cars: 6, composition: "Six-car double-deck element",
    referenceCapacity: 1641, capacityBasis: "Published capacity for the six-car variant",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/Z_5600", sourceLabel: "Z 5600 public technical sheet",
    confidence: "high",
  },
  z8800: {
    id: "z8800", name: "Z 8800", cars: 4, composition: "ZBe+ZRBe+ZRABe+ZBe",
    referenceCapacity: 907, capacityBasis: "Published capacity per four-car element",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/Z_8800", sourceLabel: "Z 8800 public technical sheet",
    confidence: "high",
  },
  z20900: {
    id: "z20900", name: "Z 20900", cars: 4, composition: "ZBe+ZRBe+ZRABe+ZBe",
    referenceCapacity: 1598, capacityBasis: "Published total; comparison basis is not fully documented",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/Z_20900", sourceLabel: "Z 20900 public technical sheet",
    confidence: "medium",
  },
  rerng7: {
    id: "rerng7", name: "RER NG / Z 58500", cars: 7, composition: "130 m seven-car trainset",
    referenceCapacity: 1861, capacityBasis: "Official published total capacity",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://www.iledefrance-mobilites.fr/carte-didentite-du-rer-ng",
    sourceLabel: "Île-de-France Mobilités — RER NG identity card", confidence: "high",
  },
  rerng6: {
    id: "rerng6", name: "RER NG / Z 58000", cars: 6, composition: "112 m six-car trainset",
    referenceCapacity: 1563, capacityBasis: "Official published total capacity",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://www.iledefrance-mobilites.fr/carte-didentite-du-rer-ng",
    sourceLabel: "Île-de-France Mobilités — RER NG identity card", confidence: "high",
  },
  z22500: {
    id: "z22500", name: "Z 22500 / MI 2N Eole", cars: 5, composition: "R+M+R+M+R",
    referenceCapacity: 1337, capacityBasis: "Published capacity per five-car element",
    standingDensity: null, tractionClass: "rer-heavy-rail",
    sourceUrl: "https://fr.wikipedia.org/wiki/Z_22500", sourceLabel: "Z 22500 public technical sheet",
    confidence: "high",
  },
});

function assignment(
  familyId: string,
  role: RollingStockAssignmentRole = "reference",
  referenceUnits = 1,
  note = "Reference formation for comparative decision support; not a live consist feed.",
): RollingStockAssignment {
  if (!ROLLING_STOCK_FAMILIES[familyId]) throw new Error(`Unknown rolling-stock family ${familyId}`);
  return { familyId, role, referenceUnits, note };
}

function line(
  lineCode: NativeLineCode,
  displayName: string,
  mode: "metro" | "rer",
  assignments: readonly RollingStockAssignment[],
  sourceUrl = METRO_FLEET_SOURCE,
  sourceLabel = "Paris Metro rolling-stock allocation overview",
): RollingStockLineProfile {
  return { lineCode, displayName, mode, assignments, sourceUrl, sourceLabel };
}

export const ROLLING_STOCK_LINES: readonly RollingStockLineProfile[] = Object.freeze([
  line("M1", "Metro 1", "metro", [assignment("mp05")]),
  line("M2", "Metro 2", "metro", [assignment("mf01")]),
  line("M3", "Metro 3", "metro", [assignment("mf67_5")]),
  line("M3BIS", "Metro 3 bis", "metro", [assignment("mf67_3")]),
  line("M4", "Metro 4", "metro", [assignment("mp14_ca6"), assignment("mp05", "in-service"), assignment("mp89_ca6", "in-service")]),
  line("M5", "Metro 5", "metro", [assignment("mf01")]),
  line("M6", "Metro 6", "metro", [assignment("mp89_cc5"), assignment("mp73_5", "transition")]),
  line("M7", "Metro 7", "metro", [assignment("mf77")]),
  line("M7BIS", "Metro 7 bis", "metro", [assignment("mf88")]),
  line("M8", "Metro 8", "metro", [assignment("mf77")]),
  line("M9", "Metro 9", "metro", [assignment("mf01")]),
  line("M10", "Metro 10", "metro", [assignment("mf19_5"), assignment("mf67_5", "transition")]),
  line("M11", "Metro 11", "metro", [assignment("mp14_cc5")]),
  line("M12", "Metro 12", "metro", [assignment("mf67_5")]),
  line("M13", "Metro 13", "metro", [assignment("mf77")]),
  line("M14", "Metro 14", "metro", [assignment("mp14_ca8")]),
  line("RER_A", "RER A", "rer", [assignment("mi09", "reference", 2), assignment("alteo", "in-service", 2)], "https://fr.wikipedia.org/wiki/Ligne_A_du_RER_d%27%C3%8Ele-de-France", "RER A fleet overview"),
  line("RER_B", "RER B", "rer", [assignment("mi79", "reference", 2), assignment("mi84", "in-service", 2)], "https://fr.wikipedia.org/wiki/Ligne_B_du_RER_d%27%C3%8Ele-de-France", "RER B fleet overview"),
  line("RER_C", "RER C", "rer", [assignment("z5600_4"), assignment("z5600_6", "in-service"), assignment("z8800", "in-service"), assignment("z20900", "in-service")], "https://fr.wikipedia.org/wiki/Ligne_C_du_RER_d%27%C3%8Ele-de-France", "RER C fleet overview"),
  line("RER_D", "RER D", "rer", [assignment("rerng7")], "https://www.iledefrance-mobilites.fr/actualites/rer-ng-neuf-ligne-d", "Île-de-France Mobilités — RER NG on line D"),
  line("RER_E", "RER E", "rer", [assignment("rerng6"), assignment("z22500", "transition")], "https://www.iledefrance-mobilites.fr/carte-didentite-du-rer-ng", "Île-de-France Mobilités — RER NG identity card"),
]);

export const ROLLING_STOCK_LINE_BY_CODE: ReadonlyMap<NativeLineCode, RollingStockLineProfile> =
  new Map(ROLLING_STOCK_LINES.map((profile) => [profile.lineCode, profile]));

export function getRollingStockProfile(lineCode: NativeLineCode): RollingStockLineProfile {
  const profile = ROLLING_STOCK_LINE_BY_CODE.get(lineCode);
  if (!profile) throw new Error(`No rolling-stock profile for ${lineCode}`);
  return profile;
}

export function getRollingStockFamily(familyId: string): RollingStockFamily {
  const family = ROLLING_STOCK_FAMILIES[familyId];
  if (!family) throw new Error(`Unknown rolling-stock family ${familyId}`);
  return family;
}

export function getReferenceAssignment(lineCode: NativeLineCode): RollingStockAssignment {
  const profile = getRollingStockProfile(lineCode);
  const reference = profile.assignments.find((candidate) => candidate.role === "reference") ?? profile.assignments[0];
  if (!reference) throw new Error(`No rolling-stock assignment for ${lineCode}`);
  return reference;
}

export function getReferenceCapacity(lineCode: NativeLineCode): number {
  const assignment = getReferenceAssignment(lineCode);
  return getRollingStockFamily(assignment.familyId).referenceCapacity * assignment.referenceUnits;
}

export const DEMO_TRACTION_METHODOLOGY = Object.freeze({
  classification: "DEMO ESTIMATE" as const,
  calibrated: false as const,
  passengerMassKg: 80,
  passengerMassSourceUrl: "https://www.evs.ee/en/evs-en-15663-2017-a2-2024-consolidated",
  outputUnit: "relative traction index / train-km" as const,
  warning: "Uncalibrated comparison index — never interpret or export it as measured kWh.",
  profiles: {
    "steel-wheel": {
      emptyFormationIndex: 100,
      payloadIndexPerTonne: 0.52,
      rationale: "Demo coefficient for steel-wheel metro comparison.",
    },
    "rubber-tyred": {
      emptyFormationIndex: 118,
      payloadIndexPerTonne: 0.68,
      rationale: "Demo coefficient differentiating tyre rolling losses from steel-wheel operation.",
    },
    "rer-heavy-rail": {
      emptyFormationIndex: 165,
      payloadIndexPerTonne: 0.44,
      rationale: "Demo coefficient for longer, heavier RER formations.",
    },
  },
});

export interface DemoTractionEstimate {
  classification: "DEMO ESTIMATE";
  calibrated: false;
  familyId: string;
  tractionClass: RollingStockTractionClass;
  passengerCount: number;
  passengerMassKg: 80;
  payloadMassTonnes: number;
  formationUnits: number;
  referenceCapacity: number;
  loadFactorPercent: number;
  emptyFormationIndex: number;
  relativeTractionIndexPerTrainKm: number;
  loadDeltaPercent: number;
  outputUnit: "relative traction index / train-km";
  warning: string;
}

export function estimateTractionByLoad(input: {
  familyId: string;
  passengers: number;
  formationUnits?: number;
}): DemoTractionEstimate {
  const family = getRollingStockFamily(input.familyId);
  const formationUnits = Math.max(1, Math.round(input.formationUnits ?? 1));
  const passengerCount = Math.max(0, Math.round(Number.isFinite(input.passengers) ? input.passengers : 0));
  const profile = DEMO_TRACTION_METHODOLOGY.profiles[family.tractionClass];
  const payloadMassTonnes = passengerCount * DEMO_TRACTION_METHODOLOGY.passengerMassKg / 1000;
  const referenceCapacity = family.referenceCapacity * formationUnits;
  const emptyFormationIndex = profile.emptyFormationIndex * formationUnits;
  const relativeTractionIndexPerTrainKm = Math.round(
    emptyFormationIndex + payloadMassTonnes * profile.payloadIndexPerTonne,
  );
  return {
    classification: DEMO_TRACTION_METHODOLOGY.classification,
    calibrated: false,
    familyId: family.id,
    tractionClass: family.tractionClass,
    passengerCount,
    passengerMassKg: DEMO_TRACTION_METHODOLOGY.passengerMassKg,
    payloadMassTonnes: Math.round(payloadMassTonnes * 10) / 10,
    formationUnits,
    referenceCapacity,
    loadFactorPercent: Math.round(passengerCount / referenceCapacity * 100),
    emptyFormationIndex,
    relativeTractionIndexPerTrainKm,
    loadDeltaPercent: Math.round((relativeTractionIndexPerTrainKm / emptyFormationIndex - 1) * 100),
    outputUnit: DEMO_TRACTION_METHODOLOGY.outputUnit,
    warning: DEMO_TRACTION_METHODOLOGY.warning,
  };
}
