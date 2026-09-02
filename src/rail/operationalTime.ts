export const PARIS_TIME_ZONE = "Europe/Paris";

/** 28 August 2026, 01:00 PM CEST (Europe/Paris). */
export const DEFAULT_OPERATIONAL_START_TIMESTAMP = Date.UTC(2026, 7, 28, 11, 0, 0);

export const PASSENGER_DEMAND_PAUSE_START_HOUR = 1;
export const PASSENGER_DEMAND_PAUSE_END_HOUR = 5;
export const PASSENGER_SERVICE_HOURS_PER_DAY = 20;
export const PASSENGER_SERVICE_SECONDS_PER_DAY =
  PASSENGER_SERVICE_HOURS_PER_DAY * 60 * 60;
export const PASSENGER_DEMAND_PAUSE_LABEL = "01:00 AM–05:00 AM";

const PARIS_HOUR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: PARIS_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

export function parisOperationalHour(timestamp: number): number {
  const hour = PARIS_HOUR_FORMATTER.formatToParts(new Date(timestamp)).find(
    (part) => part.type === "hour",
  )?.value;
  if (hour === undefined) throw new Error("Unable to resolve the Paris operational hour.");
  return Number(hour);
}

/** Passenger demand is paused from 01:00 AM inclusive until 05:00 AM exclusive. */
export function isPassengerDemandActive(timestamp: number): boolean {
  const hour = parisOperationalHour(timestamp);
  return hour < PASSENGER_DEMAND_PAUSE_START_HOUR ||
    hour >= PASSENGER_DEMAND_PAUSE_END_HOUR;
}

export function effectivePassengerArrivalRate(
  arrivalsPerSecond: number,
  timestamp: number,
): number {
  return isPassengerDemandActive(timestamp) ? arrivalsPerSecond : 0;
}

export function formatParisOperationalTime(
  timestamp: number,
  includeSeconds = false,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PARIS_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hour12: true,
  }).format(new Date(timestamp));
}
