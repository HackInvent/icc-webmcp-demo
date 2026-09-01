/**
 * Non-destructive preview pattern adapted from ProofSheet transformations.
 * Copyright (c) 2026 Alexandre EL — used under the MIT License.
 * See the repository LICENSE for the complete license text.
 */

import type { RailSnapshot } from "../rail/domain";
import { assertValidSchedulePlan, cloneSchedulePlan } from "./csv";
import { hashOperationalContext, hashSchedulePlan } from "./quality";
import type {
  Actor,
  ScheduleChange,
  ScheduleChangeRequest,
  SchedulePlan,
  SchedulePreview,
  ScheduleService,
} from "./types";
import { ScheduleWorkspaceError } from "./types";

let previewCounter = 0;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const TRACK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$/;

function previewId(): string {
  previewCounter += 1;
  return `preview-${Date.now().toString(36)}-${previewCounter.toString(36)}`;
}

function invalid(message: string): never {
  throw new ScheduleWorkspaceError("INVALID_REQUEST", message);
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(record).find((key) => !keys.includes(key));
  if (extra) invalid(`Unexpected request property "${extra}".`);
  const missing = keys.find((key) => !(key in record));
  if (missing) invalid(`Missing request property "${missing}".`);
}

function validateRequest(request: ScheduleChangeRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    invalid("Schedule change request must be an object.");
  }
  const record = request as unknown as Record<string, unknown>;
  if (typeof request.serviceId !== "string" || !TOKEN_PATTERN.test(request.serviceId)) {
    invalid("serviceId must be a short schedule token.");
  }
  if (request.kind === "shift_service") {
    assertExactKeys(record, ["kind", "serviceId", "deltaMinutes"]);
    if (
      !Number.isInteger(request.deltaMinutes) ||
      request.deltaMinutes === 0 ||
      request.deltaMinutes < -15 ||
      request.deltaMinutes > 15
    ) {
      invalid("deltaMinutes must be a non-zero integer between -15 and 15.");
    }
  } else if (request.kind === "reassign_driver") {
    assertExactKeys(record, ["kind", "serviceId", "driverToken"]);
    if (
      request.driverToken !== null &&
      (typeof request.driverToken !== "string" || !TOKEN_PATTERN.test(request.driverToken))
    ) {
      invalid("driverToken must be null or a short pseudonymous resource token.");
    }
  } else if (request.kind === "change_track") {
    assertExactKeys(record, ["kind", "serviceId", "track"]);
    if (typeof request.track !== "string" || !TRACK_PATTERN.test(request.track)) {
      invalid("track must be a short platform token.");
    }
  } else if (request.kind === "cancel_service") {
    assertExactKeys(record, ["kind", "serviceId"]);
  } else {
    invalid("Unsupported schedule change kind.");
  }
}

function change(
  changes: ScheduleChange[],
  service: ScheduleService,
  field: keyof ScheduleService,
  after: string | number | null,
): void {
  const before = service[field];
  if (before === after) return;
  changes.push({ serviceId: service.serviceId, field, before, after });
  Object.assign(service, { [field]: after });
}

export function buildSchedulePreview(
  plan: SchedulePlan,
  request: ScheduleChangeRequest,
  snapshot: RailSnapshot,
  actor: Actor = "human",
): SchedulePreview {
  validateRequest(request);
  assertValidSchedulePlan(plan);
  const result = cloneSchedulePlan(plan);
  const service = result.services.find((candidate) => candidate.serviceId === request.serviceId);
  if (!service) invalid(`Unknown serviceId "${request.serviceId}".`);

  const changes: ScheduleChange[] = [];
  const warnings: string[] = [];
  let summary: string;

  if (request.kind === "shift_service") {
    const departureMinutes = service.departureMinutes + request.deltaMinutes;
    const arrivalMinutes = service.arrivalMinutes + request.deltaMinutes;
    if (departureMinutes < 0 || departureMinutes > 1_439 || arrivalMinutes <= departureMinutes) {
      invalid("The requested shift would move the service outside the supported operating day.");
    }
    change(changes, service, "departureMinutes", departureMinutes);
    change(changes, service, "arrivalMinutes", arrivalMinutes);
    summary = `Shift ${service.serviceId} by ${request.deltaMinutes > 0 ? "+" : ""}${request.deltaMinutes} minute(s)`;
  } else if (request.kind === "reassign_driver") {
    change(changes, service, "driverToken", request.driverToken);
    summary = request.driverToken
      ? `Reassign ${service.serviceId} to driver token ${request.driverToken}`
      : `Remove the driver token from ${service.serviceId}`;
  } else if (request.kind === "change_track") {
    change(changes, service, "track", request.track);
    summary = `Move ${service.serviceId} to track ${request.track}`;
  } else {
    change(changes, service, "status", "cancelled");
    warnings.push("Cancellation affects passenger service and remains local to this undoable simulation.");
    summary = `Cancel ${service.serviceId} in the local simulation plan`;
  }

  if (changes.length === 0) {
    throw new ScheduleWorkspaceError(
      "NO_CHANGES",
      `The requested ${request.kind} already matches ${service.serviceId}.`,
    );
  }

  assertValidSchedulePlan(result);
  const beforeHash = hashSchedulePlan(plan);
  const afterHash = hashSchedulePlan(result);
  return {
    id: previewId(),
    request,
    beforeHash,
    afterHash,
    contextHash: hashOperationalContext(snapshot),
    result,
    changes,
    affectedServiceIds: [...new Set(changes.map((item) => item.serviceId))].sort(),
    summary,
    warnings,
    createdAt: new Date().toISOString(),
    actor,
    simulationOnly: true,
  };
}

export const createSchedulePreview = buildSchedulePreview;
