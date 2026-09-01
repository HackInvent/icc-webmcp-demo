import { describe, expect, it } from "vitest";
import { createInitialSnapshot } from "../scenario";
import {
  parsePrimSiriLine,
  PrimContractError,
  PRIM_LINE_IDS,
  PRIM_LINE_REFS,
} from "./contract";
import { createPrimReplayPayload } from "./replay";

describe("IDFM PRIM SIRI Lite contract", () => {
  it("round-trips all four line fixtures through the production parser", () => {
    const snapshot = createInitialSnapshot();

    for (const lineId of PRIM_LINE_IDS) {
      const result = parsePrimSiriLine(
        createPrimReplayPayload(snapshot, lineId),
        lineId,
        "simulated",
      );
      expect(result.lineRef).toBe(PRIM_LINE_REFS[lineId]);
      expect(result.responseTimestamp).toBe(new Date(snapshot.timestamp).toISOString());
      expect(result.observations).toHaveLength(3);
      expect(result.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          lineId,
          lineRef: PRIM_LINE_REFS[lineId],
          quality: "simulated",
          expectedArrivalTime: expect.any(String),
          stopPointRef: expect.stringMatching(/^STIF:StopPoint:Q:SIM-/),
        }),
      ]));
    }
  });

  it("parses direct SIRI scalar values used by compatible producers", () => {
    const result = parsePrimSiriLine({
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: "2026-08-27T04:00:00+02:00",
          EstimatedTimetableDelivery: {
            EstimatedJourneyVersionFrame: {
              EstimatedVehicleJourney: {
                LineRef: "STIF:Line::C01742:",
                FramedVehicleJourneyRef: { DatedVehicleJourneyRef: "journey-1" },
                VehicleJourneyName: "QYAN42",
                DirectionName: "Eastbound",
                DestinationName: "Marne-la-Vallée–Chessy",
                EstimatedCalls: {
                  EstimatedCall: {
                    StopPointRef: "STIF:StopPoint:Q:411355:",
                    StopPointName: "Châtelet–Les Halles",
                    AimedArrivalTime: "2026-08-27T04:05:00+02:00",
                    ExpectedArrivalTime: "2026-08-27T04:07:30+02:00",
                    ExpectedDepartureTime: "2026-08-27T04:08:00+02:00",
                    DepartureStatus: "delayed",
                    VehicleAtStop: "false",
                  },
                },
              },
            },
          },
        },
      },
    }, "RER_A", "live", "2026-08-27T02:00:30.000Z");

    expect(result.observations[0]).toEqual(expect.objectContaining({
      journeyRef: "journey-1",
      vehicleJourneyName: "QYAN42",
      delaySeconds: 150,
      vehicleAtStop: false,
      quality: "live",
    }));
  });

  it("fails closed on a missing delivery or mismatched official line reference", () => {
    expect(() => parsePrimSiriLine({}, "RER_A")).toThrow(PrimContractError);
    const payload = createPrimReplayPayload(createInitialSnapshot(), "RER_A") as {
      Siri: { ServiceDelivery: { EstimatedTimetableDelivery: Array<{
        EstimatedJourneyVersionFrame: Array<{
          EstimatedVehicleJourney: Array<{ LineRef: { value: string } }>;
        }>;
      }> } };
    };
    payload.Siri.ServiceDelivery.EstimatedTimetableDelivery[0]
      .EstimatedJourneyVersionFrame[0]
      .EstimatedVehicleJourney[0]
      .LineRef.value = PRIM_LINE_REFS.RER_B;
    expect(() => parsePrimSiriLine(payload, "RER_A")).toThrow("Unexpected LineRef");
  });
});
