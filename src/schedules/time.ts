export function formatScheduleMinutes(minutes: number): string {
  const dayOffset = Math.floor(minutes / 1_440);
  const normalized = ((minutes % 1_440) + 1_440) % 1_440;
  const time = `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
  return dayOffset > 0 ? `${time} +${dayOffset}d` : time;
}
