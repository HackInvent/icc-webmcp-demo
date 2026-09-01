/**
 * Bounded CSV parser and defensive clone pattern adapted from ProofSheet.
 * Copyright (c) 2026 Alexandre EL — used under the MIT License.
 * See the repository LICENSE for the complete license text.
 */

import type { LineId } from "../rail/domain";
import type { SchedulePlan, ScheduleService, ScheduleServiceStatus } from "./types";

export const MAX_SCHEDULE_FILE_BYTES = 1024 * 1024;
export const MAX_SCHEDULE_ROWS = 2_000;
export const MAX_SCHEDULE_COLUMNS = 11;
export const MAX_SCHEDULE_CELL_LENGTH = 160;

export const SCHEDULE_CSV_HEADERS = [
  "serviceId",
  "circulationId",
  "trainId",
  "lineId",
  "origin",
  "destination",
  "departureMinutes",
  "arrivalMinutes",
  "track",
  "driverToken",
  "status",
] as const;

const LINE_IDS: readonly LineId[] = ["RER_A", "RER_B", "M13", "M14"];
const STATUSES: readonly ScheduleServiceStatus[] = ["scheduled", "cancelled"];
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const TRACK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export class ScheduleCsvError extends Error {
  readonly row?: number;
  readonly column?: string;

  constructor(message: string, row?: number, column?: string) {
    super(message);
    this.name = "ScheduleCsvError";
    this.row = row;
    this.column = column;
  }
}

function bytesIn(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseMatrix(text: string): string[][] {
  if (bytesIn(text) > MAX_SCHEDULE_FILE_BYTES) {
    throw new ScheduleCsvError("Schedule CSV exceeds the 1 MB local safety limit.");
  }

  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;

  const pushField = (): void => {
    if (field.length > MAX_SCHEDULE_CELL_LENGTH) {
      throw new ScheduleCsvError(
        `Schedule CSV cells must be ${MAX_SCHEDULE_CELL_LENGTH} characters or fewer.`,
      );
    }
    row.push(field);
    if (row.length > MAX_SCHEDULE_COLUMNS) {
      throw new ScheduleCsvError(
        `Schedule CSV exceeds the ${MAX_SCHEDULE_COLUMNS} column safety limit.`,
      );
    }
    field = "";
    quoteClosed = false;
  };
  const pushRow = (): void => {
    pushField();
    matrix.push(row);
    if (matrix.length > MAX_SCHEDULE_ROWS + 1) {
      throw new ScheduleCsvError(
        `Schedule CSV exceeds the ${MAX_SCHEDULE_ROWS.toLocaleString("en-US")} service safety limit.`,
      );
    }
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        field += char;
        if (field.length > MAX_SCHEDULE_CELL_LENGTH) {
          throw new ScheduleCsvError(
            `Schedule CSV cells must be ${MAX_SCHEDULE_CELL_LENGTH} characters or fewer.`,
          );
        }
      }
      continue;
    }

    if (quoteClosed && char !== "," && char !== "\n" && char !== "\r") {
      throw new ScheduleCsvError("Schedule CSV has characters after a closing quote.");
    }
    if (char === '"') {
      if (field.length > 0) {
        throw new ScheduleCsvError("Schedule CSV contains a quote inside an unquoted field.");
      }
      quoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") index += 1;
      pushRow();
    } else {
      field += char;
      if (field.length > MAX_SCHEDULE_CELL_LENGTH) {
        throw new ScheduleCsvError(
          `Schedule CSV cells must be ${MAX_SCHEDULE_CELL_LENGTH} characters or fewer.`,
        );
      }
    }
  }

  if (quoted) throw new ScheduleCsvError("Schedule CSV contains an unclosed quoted field.");
  if (row.length > 0 || field.length > 0 || quoteClosed) pushRow();
  while (matrix.length > 0 && matrix.at(-1)?.every((value) => value === "")) matrix.pop();
  if (matrix.length === 0) throw new ScheduleCsvError("Schedule CSV is empty.");
  return matrix;
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formulaRisk(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .replace(/^[\uFEFF\u0000-\u0020\u007F]+/, "");
  return /^[=+@]/.test(normalized) || (/^-/.test(normalized) && !/^-\d+(?:\.\d+)?$/.test(normalized));
}

function stringField(
  value: unknown,
  field: string,
  rowNumber: number,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new ScheduleCsvError(`${field} must be a non-empty trimmed string.`, rowNumber, field);
  }
  if (value.length > MAX_SCHEDULE_CELL_LENGTH || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new ScheduleCsvError(`${field} contains unsupported characters.`, rowNumber, field);
  }
  if (formulaRisk(value)) {
    throw new ScheduleCsvError(`${field} contains a spreadsheet formula risk.`, rowNumber, field);
  }
  if (pattern && !pattern.test(value)) {
    throw new ScheduleCsvError(`${field} has an invalid format.`, rowNumber, field);
  }
  return value;
}

function nullableToken(value: unknown, field: string, rowNumber: number): string | null {
  if (value === "" || value === null) return null;
  return stringField(value, field, rowNumber, TOKEN_PATTERN);
}

function integerField(value: unknown, field: string, rowNumber: number): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
  } else if (typeof value === "string" && INTEGER_PATTERN.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new ScheduleCsvError(`${field} must be a canonical non-negative integer.`, rowNumber, field);
}

function validateService(value: unknown, index: number): ScheduleService {
  const rowNumber = index + 2;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduleCsvError("Each schedule service must be an object.", rowNumber);
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find(
    (key) => !SCHEDULE_CSV_HEADERS.includes(key as (typeof SCHEDULE_CSV_HEADERS)[number]),
  );
  if (extra) throw new ScheduleCsvError(`Unexpected service property "${extra}".`, rowNumber, extra);

  const lineId = record.lineId;
  if (typeof lineId !== "string" || !LINE_IDS.includes(lineId as LineId)) {
    throw new ScheduleCsvError(`lineId must be one of ${LINE_IDS.join(", ")}.`, rowNumber, "lineId");
  }
  const status = record.status;
  if (typeof status !== "string" || !STATUSES.includes(status as ScheduleServiceStatus)) {
    throw new ScheduleCsvError(`status must be one of ${STATUSES.join(", ")}.`, rowNumber, "status");
  }
  const departureMinutes = integerField(record.departureMinutes, "departureMinutes", rowNumber);
  const arrivalMinutes = integerField(record.arrivalMinutes, "arrivalMinutes", rowNumber);
  if (departureMinutes > 1_439) {
    throw new ScheduleCsvError("departureMinutes must be between 0 and 1439.", rowNumber, "departureMinutes");
  }
  if (arrivalMinutes <= departureMinutes || arrivalMinutes > departureMinutes + 1_440) {
    throw new ScheduleCsvError(
      "arrivalMinutes must be after departure and no more than 24 hours later.",
      rowNumber,
      "arrivalMinutes",
    );
  }

  return {
    serviceId: stringField(record.serviceId, "serviceId", rowNumber, TOKEN_PATTERN),
    circulationId: stringField(record.circulationId, "circulationId", rowNumber, TOKEN_PATTERN),
    trainId: nullableToken(record.trainId, "trainId", rowNumber),
    lineId: lineId as LineId,
    origin: stringField(record.origin, "origin", rowNumber),
    destination: stringField(record.destination, "destination", rowNumber),
    departureMinutes,
    arrivalMinutes,
    track: stringField(record.track, "track", rowNumber, TRACK_PATTERN),
    driverToken: nullableToken(record.driverToken, "driverToken", rowNumber),
    status: status as ScheduleServiceStatus,
  };
}

export function assertValidSchedulePlan(plan: SchedulePlan): void {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new ScheduleCsvError("Schedule plan must be an object.");
  }
  stringField(plan.name, "name", 1);
  if (!validIsoDate(plan.serviceDate)) {
    throw new ScheduleCsvError("serviceDate must be a real ISO date (YYYY-MM-DD).", 1, "serviceDate");
  }
  if (!Array.isArray(plan.services) || plan.services.length === 0) {
    throw new ScheduleCsvError("Schedule plan must contain at least one service.");
  }
  if (plan.services.length > MAX_SCHEDULE_ROWS) {
    throw new ScheduleCsvError(
      `Schedule plan exceeds the ${MAX_SCHEDULE_ROWS.toLocaleString("en-US")} service safety limit.`,
    );
  }
  const serviceIds = new Set<string>();
  const circulationIds = new Set<string>();
  plan.services.forEach((service, index) => {
    const validated = validateService(service, index);
    if (serviceIds.has(validated.serviceId)) {
      throw new ScheduleCsvError(`Duplicate serviceId "${validated.serviceId}".`, index + 2, "serviceId");
    }
    if (circulationIds.has(validated.circulationId)) {
      throw new ScheduleCsvError(
        `Duplicate circulationId "${validated.circulationId}".`,
        index + 2,
        "circulationId",
      );
    }
    serviceIds.add(validated.serviceId);
    circulationIds.add(validated.circulationId);
  });
}

export function parseScheduleCsv(
  text: string,
  name = "schedule.csv",
  serviceDate = new Date().toISOString().slice(0, 10),
): SchedulePlan {
  const matrix = parseMatrix(text);
  const header = matrix[0];
  if (
    header.length !== SCHEDULE_CSV_HEADERS.length ||
    header.some((value, index) => value !== SCHEDULE_CSV_HEADERS[index])
  ) {
    throw new ScheduleCsvError(
      `Schedule CSV header must be exactly: ${SCHEDULE_CSV_HEADERS.join(",")}.`,
      1,
    );
  }
  if (matrix.length === 1) throw new ScheduleCsvError("Schedule CSV contains no services.");

  const services = matrix.slice(1).map((values, index) => {
    const rowNumber = index + 2;
    if (values.length !== SCHEDULE_CSV_HEADERS.length) {
      throw new ScheduleCsvError(
        `CSV row ${rowNumber} has ${values.length} fields; expected ${SCHEDULE_CSV_HEADERS.length}.`,
        rowNumber,
      );
    }
    const record = Object.fromEntries(
      SCHEDULE_CSV_HEADERS.map((column, columnIndex) => [column, values[columnIndex]]),
    );
    return validateService(record, index);
  });
  const plan: SchedulePlan = {
    name: stringField(name, "name", 1),
    serviceDate,
    services,
    importedAt: new Date().toISOString(),
  };
  assertValidSchedulePlan(plan);
  return plan;
}

function quoteCsvValue(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

export function serializeScheduleCsv(plan: SchedulePlan): string {
  assertValidSchedulePlan(plan);
  const rows = plan.services.map((service) => [
    service.serviceId,
    service.circulationId,
    service.trainId ?? "",
    service.lineId,
    service.origin,
    service.destination,
    String(service.departureMinutes),
    String(service.arrivalMinutes),
    service.track,
    service.driverToken ?? "",
    service.status,
  ]);
  return [SCHEDULE_CSV_HEADERS, ...rows]
    .map((row) => row.map((value) => quoteCsvValue(String(value))).join(","))
    .join("\r\n");
}

export function cloneSchedulePlan(plan: SchedulePlan): SchedulePlan {
  return {
    ...plan,
    services: plan.services.map((service) => ({ ...service })),
  };
}
