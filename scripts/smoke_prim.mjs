const LINE_REFS = Object.freeze({
  RER_A: "STIF:Line::C01742:",
  RER_B: "STIF:Line::C01743:",
  M13: "STIF:Line::C01383:",
  M14: "STIF:Line::C01384:",
});

const endpoint = process.env.PRIM_API_URL
  || "https://prim.iledefrance-mobilites.fr/marketplace/requete-ligne";
const apiKey = process.env.PRIM_API_KEY;

if (!apiKey) {
  console.error("PRIM_API_KEY is required. The credential is never printed or sent to the browser.");
  process.exit(2);
}

function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function summarize(payload, lineId, lineRef) {
  const serviceDelivery = record(record(payload)?.Siri)?.ServiceDelivery;
  const delivery = record(serviceDelivery);
  if (!delivery) throw new Error("missing Siri.ServiceDelivery");
  const timetables = list(delivery.EstimatedTimetableDelivery).map(record).filter(Boolean);
  if (timetables.length === 0) throw new Error("missing EstimatedTimetableDelivery");
  const journeys = timetables.flatMap((item) =>
    list(item.EstimatedJourneyVersionFrame).map(record).filter(Boolean).flatMap((frame) =>
      list(frame.EstimatedVehicleJourney).map(record).filter(Boolean)
    )
  );
  const estimatedCalls = journeys.reduce((total, journey) => {
    const calls = record(journey.EstimatedCalls)?.EstimatedCall;
    return total + list(calls).length;
  }, 0);
  return {
    lineId,
    lineRef,
    responseTimestamp: delivery.ResponseTimestamp ?? null,
    journeys: journeys.length,
    estimatedCalls,
    contract: "SIRI Lite Estimated Timetable",
  };
}

async function checkLine([lineId, lineRef]) {
  const url = new URL(endpoint);
  url.searchParams.set("LineRef", lineRef);
  const response = await fetch(url, {
    headers: { Accept: "application/json", apikey: apiKey },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  return summarize(await response.json(), lineId, lineRef);
}

const results = await Promise.allSettled(Object.entries(LINE_REFS).map(checkLine));
const report = results.map((result, index) => {
  const [lineId, lineRef] = Object.entries(LINE_REFS)[index];
  return result.status === "fulfilled"
    ? { status: "ready", ...result.value }
    : {
        status: "error",
        lineId,
        lineRef,
        error: result.reason instanceof Error ? result.reason.message.slice(0, 160) : "unknown error",
      };
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  endpoint,
  credentialExposed: false,
  lines: report,
}, null, 2));

if (report.some((line) => line.status !== "ready")) process.exitCode = 1;
