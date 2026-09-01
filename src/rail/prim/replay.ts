import type { LineId, RailSnapshot } from "../domain";
import { PRIM_LINE_REFS } from "./contract";

function siriValue(value: string): { value: string } {
  return { value };
}

function plusSeconds(timestamp: number, seconds: number): string {
  return new Date(timestamp + seconds * 1_000).toISOString();
}

function stopToken(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();
}

/**
 * Produces an offline fixture with the same SIRI Lite envelope and fields used by
 * the authenticated PRIM line endpoint. Values are deliberately synthetic.
 */
export function createPrimReplayPayload(snapshot: RailSnapshot, lineId: LineId): unknown {
  const responseTimestamp = new Date(snapshot.timestamp).toISOString();
  const lineRef = PRIM_LINE_REFS[lineId];
  const trains = snapshot.trains.filter((train) => train.lineId === lineId);

  return {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: responseTimestamp,
        ProducerRef: siriValue("Paris-ICC-contract-replay"),
        EstimatedTimetableDelivery: [{
          ResponseTimestamp: responseTimestamp,
          EstimatedJourneyVersionFrame: [{
            RecordedAtTime: responseTimestamp,
            EstimatedVehicleJourney: trains.map((train) => {
              const runSeconds = Math.max(45, Math.round((1 - train.progress) * 210));
              const expectedArrival = plusSeconds(snapshot.timestamp, runSeconds);
              const aimedArrival = plusSeconds(
                snapshot.timestamp,
                runSeconds - train.delaySeconds,
              );
              return {
                LineRef: siriValue(lineRef),
                FramedVehicleJourneyRef: {
                  DataFrameRef: siriValue(responseTimestamp.slice(0, 10)),
                  DatedVehicleJourneyRef: siriValue(train.id),
                },
                VehicleJourneyName: [siriValue(train.circulationId)],
                DirectionName: [siriValue(`${train.origin} → ${train.destination}`)],
                DestinationName: [siriValue(train.destination)],
                EstimatedCalls: {
                  EstimatedCall: [{
                    StopPointRef: siriValue(`STIF:StopPoint:Q:SIM-${stopToken(train.nextStop)}:`),
                    StopPointName: [siriValue(train.nextStop)],
                    VehicleAtStop: train.status === "dwelling",
                    AimedArrivalTime: aimedArrival,
                    ExpectedArrivalTime: expectedArrival,
                    ExpectedDepartureTime: plusSeconds(snapshot.timestamp, runSeconds + 45),
                    DepartureStatus: train.status === "held" ? "delayed" : "onTime",
                  }],
                },
              };
            }),
          }],
        }],
      },
    },
  };
}
