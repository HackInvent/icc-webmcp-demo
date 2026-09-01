import { describe, expect, it } from "vitest";
import publicScheduleCsv from "../../public/sample-paris-schedule.csv?raw";
import { createInitialSnapshot } from "../rail/scenario";
import {
  cloneSchedulePlan,
  MAX_SCHEDULE_FILE_BYTES,
  MAX_SCHEDULE_ROWS,
  parseScheduleCsv,
  SCHEDULE_CSV_HEADERS,
  serializeScheduleCsv,
} from "./csv";
import { createSampleSchedulePlan, SAMPLE_SCHEDULE_CSV } from "./sample";

describe("strict bounded schedule CSV", () => {
  it("round-trips the flat schedule model without losing nullable tokens", () => {
    const parsed = parseScheduleCsv(SAMPLE_SCHEDULE_CSV, "sample.csv", "2026-08-27");
    const reparsed = parseScheduleCsv(
      serializeScheduleCsv(parsed),
      "sample.csv",
      "2026-08-27",
    );

    expect(parsed.services).toHaveLength(12);
    expect(createSampleSchedulePlan().importedAt).toBe("2026-08-26T03:10:00.000Z");
    expect(parsed.services.at(-1)?.driverToken).toBeNull();
    expect(reparsed.services).toEqual(parsed.services);
    expect(parsed.services.find((service) => service.serviceId === "SVC-RA-042")).toMatchObject({
      circulationId: "QYAN42",
      trainId: "MI09-042",
      lineId: "RER_A",
      origin: "Cergy-le-Haut",
      destination: "Marne-la-Vallée–Chessy",
      departureMinutes: 332,
      arrivalMinutes: 405,
      track: "A1",
      driverToken: "ADC-RA-038",
    });
    expect(
      parsed.services
        .filter((service) => service.lineId === "M13")
        .every((service) => service.arrivalMinutes - service.departureMinutes === 37),
    ).toBe(true);
    expect(
      parsed.services
        .filter((service) => service.lineId === "M14")
        .every((service) => service.arrivalMinutes - service.departureMinutes === 42),
    ).toBe(true);
  });

  it("keeps the downloadable public fixture identical to the in-memory sample", () => {
    const normalizeLines = (value: string) => value.replaceAll("\r\n", "\n").trimEnd();
    expect(normalizeLines(publicScheduleCsv)).toBe(normalizeLines(SAMPLE_SCHEDULE_CSV));
  });

  it("matches every scenario train and preserves the M14 directions", () => {
    const plan = createSampleSchedulePlan();
    const scenarioTrainIds = createInitialSnapshot().trains.map((train) => train.id).sort();
    const scheduleTrainIds = plan.services
      .map((service) => service.trainId)
      .filter((trainId): trainId is string => trainId !== null)
      .sort();

    expect(scheduleTrainIds).toHaveLength(12);
    expect(new Set(scheduleTrainIds).size).toBe(12);
    expect(scheduleTrainIds).toEqual(scenarioTrainIds);
    expect(plan.services.find((service) => service.trainId === "MP14-028")).toMatchObject({
      origin: "Saint-Denis–Pleyel",
      destination: "Aéroport d'Orly",
    });
    expect(plan.services.find((service) => service.trainId === "MP14-041")).toMatchObject({
      origin: "Aéroport d'Orly",
      destination: "Saint-Denis–Pleyel",
    });
  });

  it("accepts RER A and rejects the retired RER D identifier", () => {
    const parsed = parseScheduleCsv(SAMPLE_SCHEDULE_CSV, "sample.csv", "2026-08-27");
    expect(parsed.services.filter((service) => service.lineId === "RER_A")).toHaveLength(3);

    const retiredLine = SAMPLE_SCHEDULE_CSV.replace(",RER_A,", ",RER_D,");
    expect(() => parseScheduleCsv(retiredLine, "rer-d.csv", "2026-08-27")).toThrow(
      "lineId must be one of RER_A, RER_B, M13, M14",
    );
  });

  it("requires the exact schema and exact field count", () => {
    const wrongHeader = SAMPLE_SCHEDULE_CSV.replace("serviceId,circulationId", "circulationId,serviceId");
    expect(() => parseScheduleCsv(wrongHeader, "bad.csv", "2026-08-27")).toThrow(
      "header must be exactly",
    );

    const rows = SAMPLE_SCHEDULE_CSV.split("\r\n");
    rows[1] += ",unexpected";
    expect(() => parseScheduleCsv(rows.join("\r\n"), "wide.csv", "2026-08-27")).toThrow(
      "column safety limit",
    );
    expect(SCHEDULE_CSV_HEADERS).toHaveLength(11);
  });

  it("rejects duplicates, formula risks, whitespace, and malformed quoting", () => {
    const duplicate = SAMPLE_SCHEDULE_CSV.replace("SVC-RB-205", "SVC-RB-101");
    expect(() => parseScheduleCsv(duplicate, "duplicate.csv", "2026-08-27")).toThrow(
      "Duplicate serviceId",
    );

    const formula = SAMPLE_SCHEDULE_CSV.replace(
      ",Massy–Palaiseau,Aéroport Charles de Gaulle 2 TGV,",
      ",=CMD,Aéroport Charles de Gaulle 2 TGV,",
    );
    expect(() => parseScheduleCsv(formula, "formula.csv", "2026-08-27")).toThrow(
      "formula risk",
    );

    const whitespace = SAMPLE_SCHEDULE_CSV.replace(
      ",Massy–Palaiseau,Aéroport Charles de Gaulle 2 TGV,",
      ", Massy–Palaiseau,Aéroport Charles de Gaulle 2 TGV,",
    );
    expect(() => parseScheduleCsv(whitespace, "space.csv", "2026-08-27")).toThrow(
      "trimmed string",
    );
    expect(() =>
      parseScheduleCsv('serviceId,circulationId,trainId,lineId,origin,destination,departureMinutes,arrivalMinutes,track,driverToken,status\n"broken', "quote.csv", "2026-08-27"),
    ).toThrow("unclosed quoted field");
  });

  it("accepts exactly the row limit with a conventional trailing CRLF", () => {
    const rows = Array.from(
      { length: MAX_SCHEDULE_ROWS },
      (_, index) =>
        `SVC-${index},RUN-${index},TRAIN-${index},RER_A,Origin,Destination,0,1,A,DRIVER-${index},scheduled`,
    );
    const csv = `${SCHEDULE_CSV_HEADERS.join(",")}\r\n${rows.join("\r\n")}\r\n`;

    expect(parseScheduleCsv(csv, "bounded.csv", "2026-08-27").services).toHaveLength(
      MAX_SCHEDULE_ROWS,
    );
  });

  it("enforces byte and cell bounds before accepting input", () => {
    expect(() =>
      parseScheduleCsv("x".repeat(MAX_SCHEDULE_FILE_BYTES + 1), "large.csv", "2026-08-27"),
    ).toThrow("1 MB");

    const oversizedCell = SAMPLE_SCHEDULE_CSV.replace(
      "Massy–Palaiseau",
      "D".repeat(161),
    );
    expect(() => parseScheduleCsv(oversizedCell, "cell.csv", "2026-08-27")).toThrow(
      "160 characters",
    );
  });

  it("clones plans deeply enough for non-destructive previews", () => {
    const plan = createSampleSchedulePlan();
    const copy = cloneSchedulePlan(plan);
    copy.services[0].track = "X9";

    expect(plan.services[0].track).toBe("B1");
    expect(copy.services[0].track).toBe("X9");
  });
});
