import type { IncidentStatus, LineId, Severity, TrainStatus } from "./rail/domain";
import { lineDefinition } from "./rail/topology";

export function formatDelay(seconds: number): string {
  if (seconds < 60) return seconds === 0 ? "On time" : `+${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `+${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function lineLabel(lineId: LineId): string {
  return lineDefinition(lineId).name;
}

export function severityLabel(severity: Severity): string {
  return { low: "Low", medium: "Moderate", high: "Major", critical: "Critical" }[severity];
}

export function severityTone(severity: Severity): "ok" | "warning" | "danger" | "neutral" {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warning";
  return severity === "low" ? "ok" : "neutral";
}

export function incidentStatusLabel(status: IncidentStatus): string {
  return {
    planned: "Planned",
    active: "Active",
    acknowledged: "Acknowledged",
    resolved: "Resolved",
  }[status];
}

export function trainStatusLabel(status: TrainStatus): string {
  return { running: "In service", dwelling: "At platform", held: "Held", stopped: "Stopped" }[status];
}
