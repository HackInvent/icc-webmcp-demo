import type { SchedulePlan } from "./types";
import { cloneSchedulePlan, serializeScheduleCsv } from "./csv";

export const SAMPLE_SCHEDULE_PLAN: SchedulePlan = {
  name: "Paris ICC D-1 plan v3",
  serviceDate: "2026-08-27",
  importedAt: "2026-08-26T03:10:00.000Z",
  services: [
    { serviceId: "SVC-RB-101", circulationId: "ERIO42", trainId: "MI79-101", lineId: "RER_B", origin: "Massy–Palaiseau", destination: "Aéroport Charles de Gaulle 2 TGV", departureMinutes: 330, arrivalMinutes: 408, track: "B1", driverToken: "ADC-RB-041", status: "scheduled" },
    { serviceId: "SVC-RB-205", circulationId: "ILOT44", trainId: "MI79-205", lineId: "RER_B", origin: "Robinson", destination: "Mitry - Claye", departureMinutes: 338, arrivalMinutes: 410, track: "B2", driverToken: "ADC-RB-017", status: "scheduled" },
    { serviceId: "SVC-RB-312", circulationId: "KALI06", trainId: "MI84-312", lineId: "RER_B", origin: "Aéroport Charles de Gaulle 2 TGV", destination: "Massy–Palaiseau", departureMinutes: 370, arrivalMinutes: 448, track: "B4", driverToken: "ADC-RB-063", status: "scheduled" },
    { serviceId: "SVC-RA-042", circulationId: "QYAN42", trainId: "MI09-042", lineId: "RER_A", origin: "Cergy-le-Haut", destination: "Marne-la-Vallée–Chessy", departureMinutes: 332, arrivalMinutes: 405, track: "A1", driverToken: "ADC-RA-038", status: "scheduled" },
    { serviceId: "SVC-RA-117", circulationId: "NELY44", trainId: "MI09-117", lineId: "RER_A", origin: "Saint-Germain-en-Laye", destination: "Boissy-Saint-Léger", departureMinutes: 350, arrivalMinutes: 410, track: "A2", driverToken: "ADC-RA-052", status: "scheduled" },
    { serviceId: "SVC-RA-157", circulationId: "UPAC43", trainId: "MI2N-157", lineId: "RER_A", origin: "Marne-la-Vallée–Chessy", destination: "Cergy-le-Haut", departureMinutes: 342, arrivalMinutes: 426, track: "A4", driverToken: "ADC-RA-011", status: "scheduled" },
    { serviceId: "SVC-M13-037", circulationId: "13-FOUR-037", trainId: "MF77-037", lineId: "M13", origin: "Châtillon–Montrouge", destination: "Saint-Denis–Université", departureMinutes: 336, arrivalMinutes: 373, track: "13A", driverToken: "ADC-M13-024", status: "scheduled" },
    { serviceId: "SVC-M13-082", circulationId: "13-ASNI-082", trainId: "MF77-082", lineId: "M13", origin: "Châtillon–Montrouge", destination: "Les Courtilles", departureMinutes: 344, arrivalMinutes: 381, track: "13B", driverToken: "ADC-M13-008", status: "scheduled" },
    { serviceId: "SVC-M13-116", circulationId: "13-CHAT-116", trainId: "MF77-116", lineId: "M13", origin: "Saint-Denis–Université", destination: "Châtillon–Montrouge", departureMinutes: 380, arrivalMinutes: 417, track: "13R", driverToken: "ADC-M13-055", status: "scheduled" },
    { serviceId: "SVC-M14-014", circulationId: "14-PLYL-014", trainId: "MP14-014", lineId: "M14", origin: "Aéroport d'Orly", destination: "Saint-Denis–Pleyel", departureMinutes: 334, arrivalMinutes: 376, track: "14A", driverToken: null, status: "scheduled" },
    { serviceId: "SVC-M14-028", circulationId: "14-ORLY-028", trainId: "MP14-028", lineId: "M14", origin: "Saint-Denis–Pleyel", destination: "Aéroport d'Orly", departureMinutes: 340, arrivalMinutes: 382, track: "14B", driverToken: null, status: "scheduled" },
    { serviceId: "SVC-M14-041", circulationId: "14-CHAT-041", trainId: "MP14-041", lineId: "M14", origin: "Aéroport d'Orly", destination: "Saint-Denis–Pleyel", departureMinutes: 346, arrivalMinutes: 388, track: "14R", driverToken: null, status: "scheduled" },
  ],
};

export const SAMPLE_SCHEDULE_CSV = serializeScheduleCsv(SAMPLE_SCHEDULE_PLAN);

export function createSampleSchedulePlan(): SchedulePlan {
  return cloneSchedulePlan(SAMPLE_SCHEDULE_PLAN);
}

export const createSamplePlan = createSampleSchedulePlan;
