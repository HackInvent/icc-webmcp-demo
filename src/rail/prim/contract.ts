import type {
  DataQuality,
  LineId,
  PrimPassengerObservation,
} from "../domain";

export const PRIM_LINE_REFS: Readonly<Record<LineId, string>> = {
  RER_A: "STIF:Line::C01742:",
  RER_B: "STIF:Line::C01743:",
  M13: "STIF:Line::C01383:",
  M14: "STIF:Line::C01384:",
};

export const PRIM_LINE_IDS = Object.keys(PRIM_LINE_REFS) as LineId[];

type JsonObject = Record<string, unknown>;

export interface ParsedPrimLine {
  lineId: LineId;
  lineRef: string;
  responseTimestamp: string | null;
  observations: PrimPassengerObservation[];
}

export class PrimContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrimContractError";
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function listValue(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = stringValue(item);
      if (result !== null) return result;
    }
    return null;
  }
  const record = objectValue(value);
  return record ? stringValue(record.value) : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const normalized = stringValue(value)?.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function isoValue(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function delaySeconds(aimed: string | null, expected: string | null): number | null {
  if (!aimed || !expected) return null;
  return Math.round((Date.parse(expected) - Date.parse(aimed)) / 1_000);
}

function nested(record: JsonObject | null, key: string): JsonObject | null {
  return objectValue(record?.[key]);
}

export function parsePrimSiriLine(
  payload: unknown,
  lineId: LineId,
  quality: Extract<DataQuality, "live" | "simulated" | "stale"> = "live",
  fallbackObservedAt = new Date().toISOString(),
): ParsedPrimLine {
  const root = objectValue(payload);
  const siri = nested(root, "Siri");
  const delivery = nested(siri, "ServiceDelivery");
  if (!delivery) {
    throw new PrimContractError("Missing Siri.ServiceDelivery in the PRIM response.");
  }

  const deliveries = listValue(delivery.EstimatedTimetableDelivery)
    .map(objectValue)
    .filter((item): item is JsonObject => item !== null);
  if (deliveries.length === 0) {
    throw new PrimContractError("Missing EstimatedTimetableDelivery in the PRIM response.");
  }

  const responseTimestamp = isoValue(delivery.ResponseTimestamp)
    ?? isoValue(deliveries[0]?.ResponseTimestamp);
  const observedAt = responseTimestamp ?? fallbackObservedAt;
  const observationQuality = quality === "live"
    && responseTimestamp
    && Date.parse(fallbackObservedAt) - Date.parse(responseTimestamp) > 180_000
    ? "stale"
    : quality;
  const expectedLineRef = PRIM_LINE_REFS[lineId];
  const observations: PrimPassengerObservation[] = [];
  let responseLineRef: string | null = null;

  for (const timetableDelivery of deliveries) {
    const frames = listValue(timetableDelivery.EstimatedJourneyVersionFrame)
      .map(objectValue)
      .filter((item): item is JsonObject => item !== null);
    for (const frame of frames) {
      const journeys = listValue(frame.EstimatedVehicleJourney)
        .map(objectValue)
        .filter((item): item is JsonObject => item !== null);
      for (const journey of journeys) {
        const lineRef = stringValue(journey.LineRef) ?? expectedLineRef;
        responseLineRef ??= lineRef;
        if (lineRef !== expectedLineRef) {
          throw new PrimContractError(
            `Unexpected LineRef ${lineRef}; expected ${expectedLineRef} for ${lineId}.`,
          );
        }

        const framedRef = objectValue(journey.FramedVehicleJourneyRef);
        const journeyRef = stringValue(framedRef?.DatedVehicleJourneyRef)
          ?? stringValue(journey.DatedVehicleJourneyRef)
          ?? "unknown-journey";
        const vehicleJourneyName = stringValue(journey.VehicleJourneyName) ?? journeyRef;
        const directionName = stringValue(journey.DirectionName) ?? "Unknown direction";
        const destinationName = stringValue(journey.DestinationName) ?? "Unknown destination";
        const estimatedCalls = objectValue(journey.EstimatedCalls);
        const calls = listValue(estimatedCalls?.EstimatedCall)
          .map(objectValue)
          .filter((item): item is JsonObject => item !== null);

        for (const call of calls) {
          const aimedArrivalTime = isoValue(call.AimedArrivalTime);
          const expectedArrivalTime = isoValue(call.ExpectedArrivalTime);
          observations.push({
            lineId,
            lineRef,
            journeyRef,
            vehicleJourneyName,
            directionName,
            destinationName,
            stopPointRef: stringValue(call.StopPointRef) ?? "unknown-stop",
            stopPointName: stringValue(call.StopPointName) ?? "Unknown stop",
            aimedArrivalTime,
            expectedArrivalTime,
            expectedDepartureTime: isoValue(call.ExpectedDepartureTime),
            departureStatus: stringValue(call.DepartureStatus),
            vehicleAtStop: booleanValue(call.VehicleAtStop),
            delaySeconds: delaySeconds(aimedArrivalTime, expectedArrivalTime),
            observedAt,
            quality: observationQuality,
          });
        }
      }
    }
  }

  return {
    lineId,
    lineRef: responseLineRef ?? expectedLineRef,
    responseTimestamp,
    observations,
  };
}
