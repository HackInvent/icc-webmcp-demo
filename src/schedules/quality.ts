/**
 * SHA-256 fingerprinting adapted from ProofSheet's quality engine.
 * Copyright (c) 2026 Alexandre EL — used under the MIT License.
 * See the repository LICENSE for the complete license text.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { RailSnapshot } from "../rail/domain";
import type {
  ImpactAssessment,
  ImpactEvaluation,
  IncidentExposure,
  PowerExposure,
  ScheduleConflict,
  ScheduleConflictKind,
  ScheduleCoverage,
  SchedulePlan,
  SchedulePreview,
  ScheduleService,
} from "./types";

const AUTOMATIC_LINES = new Set(["M14"]);

function digest(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableStringify(record[key]))
      .join(",") +
    "}"
  );
}

function canonicalServices(plan: SchedulePlan): ScheduleService[] {
  return [...plan.services]
    .sort((left, right) => left.serviceId.localeCompare(right.serviceId))
    .map((service) => ({ ...service }));
}

export function hashSchedulePlan(plan: SchedulePlan): string {
  return (
    "schedule-" +
    digest(
      stableStringify({
        serviceDate: plan.serviceDate,
        services: canonicalServices(plan),
      }),
    )
  );
}

export function hashOperationalContext(snapshot: RailSnapshot): string {
  const context = {
    resources: [...snapshot.drivers]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((driver) => ({
        id: driver.id,
        depot: driver.depot,
        qualifications: [...driver.qualifications].sort(),
        shiftStart: driver.shiftStart,
        shiftEnd: driver.shiftEnd,
        dutyMinutes: driver.dutyMinutes,
        status: driver.status,
        assignedTrainId: driver.assignedTrainId,
      })),
    incidents: [...snapshot.incidents]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((incident) => ({
        id: incident.id,
        type: incident.type,
        severity: incident.severity,
        status: incident.status,
        lineIds: [...incident.lineIds].sort(),
        blockedCircuitIds: [...incident.blockedCircuitIds].sort(),
        impactedTrainIds: [...incident.impactedTrainIds].sort(),
      })),
    circuitClosures: snapshot.circuits
      .filter((circuit) => circuit.closure !== null)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((circuit) => ({
        id: circuit.id,
        lineId: circuit.lineId,
        fromStation: circuit.fromStation,
        toStation: circuit.toStation,
        closure: circuit.closure,
      })),
    power: [...snapshot.powerSections]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((section) => ({
        id: section.id,
        lineIds: [...section.lineIds].sort(),
        status: section.status,
        circuitIds: [...section.circuitIds].sort(),
      })),
  };
  return "context-" + digest(stableStringify(context));
}

export function shortScheduleHash(hash: string): string {
  return hash.length > 26 ? hash.slice(0, 15) + "…" + hash.slice(-8) : hash;
}

function minutesFromClock(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function serviceWithinShift(
  service: ScheduleService,
  shiftStart: string,
  shiftEnd: string,
): boolean {
  const start = minutesFromClock(shiftStart);
  let end = minutesFromClock(shiftEnd);
  if (end <= start) end += 24 * 60;
  let departure = service.departureMinutes;
  let arrival = service.arrivalMinutes;
  if (departure < start && start >= 18 * 60) {
    departure += 24 * 60;
    arrival += 24 * 60;
  }
  return departure >= start && arrival <= end;
}

function conflictKey(conflict: ScheduleConflict): string {
  return stableStringify({
    kind: conflict.kind,
    resourceId: conflict.resourceId ?? null,
    serviceIds: [...conflict.serviceIds].sort(),
  });
}

function conflict(
  kind: ScheduleConflictKind,
  severity: ScheduleConflict["severity"],
  serviceIds: string[],
  message: string,
  resourceId?: string,
): ScheduleConflict {
  const normalizedServiceIds = [...new Set(serviceIds)].sort();
  const key = stableStringify({ kind, resourceId: resourceId ?? null, serviceIds: normalizedServiceIds });
  return {
    id: "conflict-" + digest(key).slice(0, 20),
    kind,
    severity,
    serviceIds: normalizedServiceIds,
    ...(resourceId ? { resourceId } : {}),
    message,
  };
}

interface PlanAnalysis {
  coverage: ScheduleCoverage;
  conflicts: ScheduleConflict[];
  incidentExposure: IncidentExposure;
  powerExposure: PowerExposure;
}

function analyzePlan(plan: SchedulePlan, snapshot: RailSnapshot): PlanAnalysis {
  const operating = plan.services
    .filter((service) => service.status === "scheduled")
    .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  const drivers = new Map(snapshot.drivers.map((driver) => [driver.id, driver]));
  const conflicts: ScheduleConflict[] = [];
  const invalidCoverage = new Set<string>();

  operating.forEach((service) => {
    if (AUTOMATIC_LINES.has(service.lineId)) return;
    if (!service.driverToken) {
      invalidCoverage.add(service.serviceId);
      conflicts.push(
        conflict(
          "missing_driver",
          "hard",
          [service.serviceId],
          `Service ${service.serviceId} has no driver capacity token.`,
        ),
      );
      return;
    }
    const driver = drivers.get(service.driverToken);
    if (!driver || driver.status === "unavailable") {
      invalidCoverage.add(service.serviceId);
      conflicts.push(
        conflict(
          "unknown_driver",
          "hard",
          [service.serviceId],
          `Driver token ${service.driverToken} is unavailable for ${service.serviceId}.`,
          service.driverToken,
        ),
      );
      return;
    }
    if (!driver.qualifications.includes(service.lineId)) {
      invalidCoverage.add(service.serviceId);
      conflicts.push(
        conflict(
          "driver_qualification",
          "hard",
          [service.serviceId],
          `Driver token ${driver.id} is not qualified for ${service.lineId}.`,
          driver.id,
        ),
      );
    }
    if (!serviceWithinShift(service, driver.shiftStart, driver.shiftEnd)) {
      invalidCoverage.add(service.serviceId);
      conflicts.push(
        conflict(
          "driver_shift",
          "hard",
          [service.serviceId],
          `Service ${service.serviceId} falls outside driver token ${driver.id}'s shift.`,
          driver.id,
        ),
      );
    }
    if (driver.status === "relief-risk") {
      conflicts.push(
        conflict(
          "driver_relief_risk",
          "warning",
          [service.serviceId],
          `Driver token ${driver.id} has a modelled relief risk for ${service.serviceId}.`,
          driver.id,
        ),
      );
    }
  });

  const byDriver = new Map<string, ScheduleService[]>();
  operating.forEach((service) => {
    if (!service.driverToken) return;
    const entries = byDriver.get(service.driverToken) ?? [];
    entries.push(service);
    byDriver.set(service.driverToken, entries);
  });
  [...byDriver.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([driverToken, services]) => {
      const sorted = services.sort(
        (left, right) => left.departureMinutes - right.departureMinutes || left.serviceId.localeCompare(right.serviceId),
      );
      for (let index = 0; index < sorted.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < sorted.length; otherIndex += 1) {
          const left = sorted[index];
          const right = sorted[otherIndex];
          if (right.departureMinutes >= left.arrivalMinutes) break;
          invalidCoverage.add(left.serviceId);
          invalidCoverage.add(right.serviceId);
          conflicts.push(
            conflict(
              "driver_overlap",
              "hard",
              [left.serviceId, right.serviceId],
              `Driver token ${driverToken} is assigned to overlapping services ${left.serviceId} and ${right.serviceId}.`,
              driverToken,
            ),
          );
        }
      }
    });

  const byRollingStock = new Map<string, ScheduleService[]>();
  operating.forEach((service) => {
    if (!service.trainId) return;
    const entries = byRollingStock.get(service.trainId) ?? [];
    entries.push(service);
    byRollingStock.set(service.trainId, entries);
  });
  [...byRollingStock.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([trainId, services]) => {
      const sorted = services.sort(
        (left, right) => left.departureMinutes - right.departureMinutes || left.serviceId.localeCompare(right.serviceId),
      );
      for (let index = 0; index < sorted.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < sorted.length; otherIndex += 1) {
          const left = sorted[index];
          const right = sorted[otherIndex];
          if (right.departureMinutes >= left.arrivalMinutes) break;
          conflicts.push(
            conflict(
              "rolling_stock_overlap",
              "hard",
              [left.serviceId, right.serviceId],
              `Rolling stock ${trainId} is assigned to overlapping services ${left.serviceId} and ${right.serviceId}.`,
              trainId,
            ),
          );
        }
      }
    });

  const byRoute = new Map<string, ScheduleService[]>();
  operating.forEach((service) => {
    const key = `${service.lineId}\u0000${service.origin}\u0000${service.destination}`;
    const entries = byRoute.get(key) ?? [];
    entries.push(service);
    byRoute.set(key, entries);
  });
  [...byRoute.values()].forEach((services) => {
    const sorted = services.sort(
      (left, right) => left.departureMinutes - right.departureMinutes || left.serviceId.localeCompare(right.serviceId),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      const minimum = current.lineId.startsWith("RER_") ? 4 : 2;
      if (current.departureMinutes - previous.departureMinutes < minimum) {
        conflicts.push(
          conflict(
            "headway",
            "warning",
            [previous.serviceId, current.serviceId],
            `Headway is below ${minimum} minutes between ${previous.serviceId} and ${current.serviceId}.`,
            current.lineId,
          ),
        );
      }
    }
  });

  const byPlatform = new Map<string, ScheduleService[]>();
  operating.forEach((service) => {
    const key = `${service.origin}\u0000${service.track}`;
    const entries = byPlatform.get(key) ?? [];
    entries.push(service);
    byPlatform.set(key, entries);
  });
  [...byPlatform.entries()].forEach(([platform, services]) => {
    const sorted = services.sort(
      (left, right) => left.departureMinutes - right.departureMinutes || left.serviceId.localeCompare(right.serviceId),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (current.departureMinutes - previous.departureMinutes < 3) {
        conflicts.push(
          conflict(
            "track",
            "hard",
            [previous.serviceId, current.serviceId],
            `Track ${current.track} at ${current.origin} is double-booked by ${previous.serviceId} and ${current.serviceId}.`,
            platform.replace("\u0000", "/"),
          ),
        );
      }
    }
  });

  const isolatedSections = snapshot.powerSections.filter((section) => section.status === "isolated");
  const isolatedServiceIds = new Set<string>();
  isolatedSections.forEach((section) => {
    const exposed = operating.filter((service) => section.lineIds.includes(service.lineId));
    exposed.forEach((service) => isolatedServiceIds.add(service.serviceId));
    exposed.forEach((service) => {
      conflicts.push(
        conflict(
          "power_isolation",
          "hard",
          [service.serviceId],
          `${section.id} is isolated and blocks scheduled service ${service.serviceId}.`,
          section.id,
        ),
      );
    });
  });

  const relevantIncidents = snapshot.incidents.filter(
    (incident) => incident.status === "active" || incident.status === "acknowledged",
  );
  const incidentServiceIds = new Set<string>();
  const incidentIds = new Set<string>();
  relevantIncidents.forEach((incident) => {
    operating.forEach((service) => {
      if (
        incident.lineIds.includes(service.lineId) ||
        (service.trainId !== null && incident.impactedTrainIds.includes(service.trainId))
      ) {
        incidentServiceIds.add(service.serviceId);
        incidentIds.add(incident.id);
      }
    });
  });

  const affectedPowerSections = snapshot.powerSections.filter(
    (section) => section.status !== "energized",
  );
  const powerServiceIds = new Set<string>();
  const sectionIds = new Set<string>();
  affectedPowerSections.forEach((section) => {
    operating.forEach((service) => {
      if (section.lineIds.includes(service.lineId)) {
        powerServiceIds.add(service.serviceId);
        sectionIds.add(section.id);
      }
    });
  });

  const totalServices = plan.services.length;
  const operatingServices = operating.length;
  const coveredServices = operatingServices - invalidCoverage.size;
  return {
    coverage: {
      totalServices,
      operatingServices,
      coveredServices,
      uncoveredServiceIds: [...invalidCoverage].sort(),
      percent:
        operatingServices === 0
          ? 100
          : Math.round((coveredServices / operatingServices) * 1000) / 10,
    },
    conflicts: conflicts.sort((left, right) => left.id.localeCompare(right.id)),
    incidentExposure: {
      serviceCount: incidentServiceIds.size,
      serviceIds: [...incidentServiceIds].sort(),
      incidentIds: [...incidentIds].sort(),
    },
    powerExposure: {
      serviceCount: powerServiceIds.size,
      serviceIds: [...powerServiceIds].sort(),
      sectionIds: [...sectionIds].sort(),
      isolatedServiceIds: [...isolatedServiceIds].sort(),
    },
  };
}

function passengerImpact(
  baseline: SchedulePlan,
  preview: SchedulePreview,
  snapshot: RailSnapshot,
): { passengersAffected: number; passengerDelayMinutes: number } {
  const trainPassengers = new Map(snapshot.trains.map((train) => [train.id, train.passengers]));
  const baselineServices = new Map(baseline.services.map((service) => [service.serviceId, service]));
  let passengersAffected = 0;
  let passengerDelayMinutes = 0;

  preview.affectedServiceIds.forEach((serviceId) => {
    const before = baselineServices.get(serviceId);
    const after = preview.result.services.find((service) => service.serviceId === serviceId);
    if (!before || !after) return;
    const passengers = before.trainId ? (trainPassengers.get(before.trainId) ?? 0) : 0;
    passengersAffected += passengers;
    if (before.status !== "cancelled" && after.status === "cancelled") {
      passengerDelayMinutes += passengers * Math.max(30, before.arrivalMinutes - before.departureMinutes);
    } else {
      const delay = Math.max(0, after.departureMinutes - before.departureMinutes);
      passengerDelayMinutes += passengers * delay;
    }
  });

  return { passengersAffected, passengerDelayMinutes };
}

function assessmentFor(score: number, hardBlocks: string[], warnings: string[]): ImpactAssessment {
  if (hardBlocks.length > 0) return "blocked";
  if (score < 60) return "high-risk";
  if (score < 85 || warnings.length > 0) return "review";
  return "acceptable";
}

export function evaluateSchedulePreview(
  baselinePlan: SchedulePlan,
  preview: SchedulePreview,
  snapshot: RailSnapshot,
): ImpactEvaluation {
  const contextHash = hashOperationalContext(snapshot);
  const baseline = analyzePlan(baselinePlan, snapshot);
  const candidate = analyzePlan(preview.result, snapshot);
  const baselineKeys = new Set(baseline.conflicts.map(conflictKey));
  const newConflicts = candidate.conflicts.filter((item) => !baselineKeys.has(conflictKey(item)));
  const hardBlocks = newConflicts
    .filter((item) => item.severity === "hard")
    .map((item) => item.message);
  const warnings = [
    ...preview.warnings,
    ...newConflicts.filter((item) => item.severity === "warning").map((item) => item.message),
  ];
  const { passengersAffected, passengerDelayMinutes } = passengerImpact(
    baselinePlan,
    preview,
    snapshot,
  );

  if (candidate.incidentExposure.serviceCount > 0) {
    warnings.push(
      `${candidate.incidentExposure.serviceCount} candidate service(s) are exposed to active or acknowledged incidents.`,
    );
  }
  if (candidate.powerExposure.serviceCount > 0) {
    warnings.push(
      `${candidate.powerExposure.serviceCount} candidate service(s) cross degraded or isolated power sections.`,
    );
  }

  const closedCircuits = snapshot.circuits
    .filter((circuit) => circuit.closure !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  const closedLineIds = new Set(closedCircuits.map((circuit) => circuit.lineId));
  const closureExposedServiceIds = preview.result.services
    .filter(
      (service) =>
        service.status === "scheduled" &&
        closedLineIds.has(service.lineId),
    )
    .map((service) => service.serviceId)
    .sort();
  if (closureExposedServiceIds.length > 0) {
    warnings.push(
      `${closureExposedServiceIds.length} candidate service(s) run on line(s) with manually closed track circuit(s): ${closedCircuits.map((circuit) => circuit.id).join(", ")}.`,
    );
  }

  const score = Math.max(
    0,
    Math.round(
      100 -
        candidate.conflicts.filter((item) => item.severity === "hard").length * 12 -
        candidate.conflicts.filter((item) => item.severity === "warning").length * 4 -
        candidate.coverage.uncoveredServiceIds.length * 8 -
        candidate.incidentExposure.serviceCount * 1.5 -
        candidate.powerExposure.isolatedServiceIds.length * 10 -
        Math.min(12, closureExposedServiceIds.length * 2) -
        Math.min(15, passengerDelayMinutes / 10_000),
    ),
  );
  const uniqueWarnings = [...new Set(warnings)];
  const assessment = assessmentFor(score, hardBlocks, uniqueWarnings);
  const impactPayload = {
    previewId: preview.id,
    beforeHash: preview.beforeHash,
    afterHash: preview.afterHash,
    contextHash,
    baselineCoverage: baseline.coverage,
    baselineConflicts: baseline.conflicts,
    coverage: candidate.coverage,
    conflicts: candidate.conflicts,
    passengersAffected,
    passengerDelayMinutes,
    incidentExposure: candidate.incidentExposure,
    powerExposure: candidate.powerExposure,
    score,
    assessment,
    hardBlocks,
    warnings: uniqueWarnings,
  };
  const id = "impact-" + digest(stableStringify(impactPayload));

  return {
    id,
    ...impactPayload,
    summary:
      `${candidate.coverage.percent}% coverage; ${newConflicts.length} new conflict(s); ` +
      `${passengersAffected} passenger(s) affected; decision ${assessment}.`,
    evaluatedAt: new Date().toISOString(),
  };
}
