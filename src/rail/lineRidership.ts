export type RidershipLineCode =
  | "M1" | "M2" | "M3" | "M3BIS" | "M4" | "M5" | "M6" | "M7" | "M7BIS"
  | "M8" | "M9" | "M10" | "M11" | "M12" | "M13" | "M14"
  | "RER_A" | "RER_B" | "RER_C" | "RER_D" | "RER_E";

export type RidershipSource = Readonly<{
  publisher: "RATP" | "Île-de-France Mobilités" | "Transilien SNCF Voyageurs";
  title: string;
  url: string;
  licence?: string;
}>;

export type LineRidershipRecord = Readonly<{
  lineCode: RidershipLineCode;
  mode: "metro" | "rer";
  referenceYear: number;
  metric: "passenger_journeys";
  dailyPassengerJourneys: number | null;
  annualPassengerJourneys: number;
  unit: "passenger_journeys_per_year";
  annualizationMethod: "official_annual" | "daily_reference_x_365";
  annualizationDays: 365 | null;
  qualifier: "reported" | "about" | "nearly";
  source: RidershipSource;
  sourceNote: string;
  limitations: readonly string[];
}>;

export const OMNIL_2025_ANNUAL_TRAFFIC_SOURCE: RidershipSource = Object.freeze({
  publisher: "Île-de-France Mobilités",
  title: "2025 annual traffic — Metro annual journeys",
  url: "https://omnil.cdn.prismic.io/omnil/ajFb3Y1P9HI4Uk5i_TCC_trafic_annuel_2025.xlsx",
});

const RATP_RER_A_SOURCE: RidershipSource = Object.freeze({
  publisher: "RATP",
  title: "Working for you — RER A",
  url: "https://www.ratp.fr/mobilisespourvous",
});

const IDFM_RER_B_SOURCE: RidershipSource = Object.freeze({
  publisher: "Île-de-France Mobilités",
  title: "RER B recovery continues under the emergency action plan",
  url: "https://presse.iledefrance-mobilites.fr/rer-b-le-redressement-se-poursuit-grace-au-plan-daction-durgence/?lang=fr",
});

const IDFM_RER_C_SOURCE: RidershipSource = Object.freeze({
  publisher: "Île-de-France Mobilités",
  title: "RER C master plan: EUR 4 billion to transform the line",
  url: "https://presse.iledefrance-mobilites.fr/schema-directeur-du-rer-c-4-milliards-deuros-pour-transformer-la-ligne/?lang=fr",
});

const TRANSILIEN_RER_D_SOURCE: RidershipSource = Object.freeze({
  publisher: "Transilien SNCF Voyageurs",
  title: "RER D continues its modernisation",
  url: "https://www.transilien.com/fr/premieres-lignes/la-ligne-D-du-RER-poursuit-sa-modernisation",
});

const TRANSILIEN_RER_E_SOURCE: RidershipSource = Object.freeze({
  publisher: "Transilien SNCF Voyageurs",
  title: "Heavy traffic on RER E: practical travel advice",
  url: "https://malignee.transilien.com/2025/01/14/forte-affluence-sur-le-rer-e-adoptez-les-bons-reflexes-et-optimisez-vos-trajets/",
});

const METRO_LIMITATIONS = Object.freeze([
  "OMNIL calls these annual journeys/usages: entries from the street, surface network or RER are counted, but Metro-to-Metro transfers are not counted again.",
  "The workbook reports values in millions to two decimal places, so checked-in integer values retain that published precision (10,000 journeys).",
  "The line 14 value includes estimated validations for the 2024 extension stations, as stated in the workbook.",
]);

const RER_LIMITATIONS = Object.freeze([
  "The source is a rounded daily headline rather than an observed annual total.",
  "The annual reference is a mechanical daily value × 365 conversion; it does not model weekday, weekend, holiday or seasonal variation.",
  "Daily references come from different publication years and must not be summed as a same-year audited network total.",
]);

type MetroSeed = readonly [RidershipLineCode, number];

const METRO_2025_SEEDS: readonly MetroSeed[] = Object.freeze([
  ["M1", 168_740_000], ["M2", 92_260_000], ["M3", 80_420_000], ["M3BIS", 1_420_000],
  ["M4", 167_460_000], ["M5", 105_230_000], ["M6", 100_480_000], ["M7", 118_940_000],
  ["M7BIS", 3_390_000], ["M8", 105_540_000], ["M9", 128_770_000], ["M10", 43_730_000],
  ["M11", 52_370_000], ["M12", 84_040_000], ["M13", 117_630_000], ["M14", 152_210_000],
]);

function metroRecord([lineCode, annualPassengerJourneys]: MetroSeed): LineRidershipRecord {
  return Object.freeze({
    lineCode, mode: "metro", referenceYear: 2025, metric: "passenger_journeys",
    dailyPassengerJourneys: null, annualPassengerJourneys,
    unit: "passenger_journeys_per_year", annualizationMethod: "official_annual",
    annualizationDays: null, qualifier: "reported", source: OMNIL_2025_ANNUAL_TRAFFIC_SOURCE,
    sourceNote: "Metro annual journeys workbook sheet, 2025 column; values are published in millions.",
    limitations: METRO_LIMITATIONS,
  });
}

function dailyRerRecord(
  lineCode: Extract<RidershipLineCode, `RER_${string}`>,
  referenceYear: number,
  dailyPassengerJourneys: number,
  qualifier: "about" | "nearly",
  source: RidershipSource,
  sourceNote: string,
): LineRidershipRecord {
  return Object.freeze({
    lineCode, mode: "rer", referenceYear, metric: "passenger_journeys", dailyPassengerJourneys,
    annualPassengerJourneys: dailyPassengerJourneys * 365,
    unit: "passenger_journeys_per_year", annualizationMethod: "daily_reference_x_365",
    annualizationDays: 365, qualifier, source, sourceNote, limitations: RER_LIMITATIONS,
  });
}

export const LINE_RIDERSHIP: readonly LineRidershipRecord[] = Object.freeze([
  ...METRO_2025_SEEDS.map(metroRecord),
  dailyRerRecord("RER_A", 2024, 1_100_000, "about", RATP_RER_A_SOURCE,
    "RATP's 2024 service update says the line carries approximately 1.1 million passengers per day."),
  dailyRerRecord("RER_B", 2025, 1_000_000, "nearly", IDFM_RER_B_SOURCE,
    "IDFM's 8 July 2025 update says the line carries nearly one million passengers per day."),
  dailyRerRecord("RER_C", 2024, 540_000, "about", IDFM_RER_C_SOURCE,
    "IDFM's 2 April 2024 master-plan announcement reports 540,000 passengers per day."),
  dailyRerRecord("RER_D", 2025, 630_000, "about", TRANSILIEN_RER_D_SOURCE,
    "Transilien's line-modernisation overview reports 630,000 passengers per day."),
  dailyRerRecord("RER_E", 2025, 600_000, "about", TRANSILIEN_RER_E_SOURCE,
    "Transilien's 14 January 2025 post reports traffic rising from 370,000 to 600,000 passengers after the extension to Nanterre-la-Folie."),
]);

const BY_LINE = new Map<string, LineRidershipRecord>(LINE_RIDERSHIP.map((entry) => [entry.lineCode, entry]));

export function getOfficialLineRidership(lineCode: string): LineRidershipRecord | undefined {
  return BY_LINE.get(lineCode);
}

export const OFFICIAL_2025_METRO_TOTAL = 1_522_630_000;
