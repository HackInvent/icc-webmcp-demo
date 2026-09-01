import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { StatusPill } from "../components/StatusPill";
import type {
  ShiftLogCategory,
  ShiftLogEntry,
  ShiftWorkspaceSnapshot,
} from "../runtime/types";

type LogFilter = "all" | ShiftLogCategory;

const FILTERS: ReadonlyArray<{ id: LogFilter; label: string }> = [
  { id: "all", label: "All entries" },
  { id: "incident", label: "Incidents" },
  { id: "operator-action", label: "Operator actions" },
  { id: "decision-support", label: "Decision support" },
  { id: "system", label: "System" },
];

function timestamp(value: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function duration(value: number | null): string {
  if (value === null) return "—";
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  return `${remainder}s`;
}

function tone(category: ShiftLogCategory): "danger" | "warning" | "purple" | "info" {
  if (category === "incident") return "danger";
  if (category === "operator-action") return "warning";
  if (category === "decision-support") return "purple";
  return "info";
}

function searchText(entry: ShiftLogEntry): string {
  return [
    entry.id,
    entry.title,
    entry.summary,
    entry.incidentId,
    entry.eventType,
    ...entry.entityIds,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function OperationsLogPage({ shift }: { shift: ShiftWorkspaceSnapshot }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const [query, setQuery] = useState("");
  const entries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...shift.logs]
      .filter((entry) => filter === "all" || entry.category === filter)
      .filter((entry) => !normalized || searchText(entry).includes(normalized))
      .sort((left, right) => right.sequence - left.sequence);
  }, [filter, query, shift.logs]);
  const incidentCount = shift.logs.filter((entry) => entry.category === "incident").length;
  const actionCount = shift.logs.filter((entry) => entry.category === "operator-action").length;

  return (
    <div className="page operations-log-page" id="text-text-operations-log-page">
      <PageHeader
        contentId="text-text-operations-log-header"
        eyebrow="PERSISTED SHIFT EVIDENCE"
        title="Operations log"
        description="Server-recorded incidents, operator actions and decision-support events for the current shift. Newest entries are shown first; reset opens a fresh shift log."
        actions={<StatusPill tone="ok">SQLite · {shift.logs.length} entries</StatusPill>}
      />

      <section className="operations-log-summary" id="text-text-operations-log-summary">
        <article><small>SHIFT ID</small><strong>{shift.shiftId}</strong><span>Opened {timestamp(shift.startedOperationalTime)}</span></article>
        <article><small>INCIDENT EVENTS</small><strong>{incidentCount}</strong><span>Created, activated, updated or resolved</span></article>
        <article><small>OPERATOR ACTIONS</small><strong>{actionCount}</strong><span>Timestamped server receipts</span></article>
        <article><small>LATEST SEQUENCE</small><strong>{Math.max(0, shift.nextLogSequence - 1)}</strong><span>Monotonic within this shift</span></article>
      </section>

      <section className="panel operations-log" id="text-text-operations-log-register" aria-labelledby="operations-log-title">
        <header className="operations-log__toolbar" id="text-text-operations-log-controls">
          <div>
            <small>INVESTIGATION REGISTER</small>
            <h2 id="operations-log-title">Current-shift chronology</h2>
          </div>
          <label className="operations-log__search">
            <Icon name="search" size={15}/>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search ID, incident or action"
              aria-label="Search operations log"
            />
          </label>
        </header>
        <nav className="operations-log__filters" aria-label="Filter operations log">
          {FILTERS.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              className={filter === candidate.id ? "active" : ""}
              aria-pressed={filter === candidate.id}
              onClick={() => setFilter(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </nav>
        <div className="operations-log__table-wrap">
          <table className="operations-log__table">
            <thead>
              <tr>
                <th>Operational time</th>
                <th>Entry</th>
                <th>Category</th>
                <th>Incident / entities</th>
                <th>Elapsed</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} data-log-entry-id={entry.id}>
                  <td><time dateTime={new Date(entry.operationalTime).toISOString()}>{timestamp(entry.operationalTime)}</time><small>Recorded {timestamp(entry.recordedAt)}</small></td>
                  <td><strong>{entry.title}</strong><p>{entry.summary}</p><code>{entry.id}</code></td>
                  <td><StatusPill tone={tone(entry.category)}>{entry.category}</StatusPill><small>{entry.eventType}</small></td>
                  <td><strong>{entry.incidentId ?? "—"}</strong><small>{entry.entityIds.join(" · ") || "No linked entity"}</small></td>
                  <td><strong>{duration(entry.durationSeconds)}</strong></td>
                  <td><span className={`operations-log__actor operations-log__actor--${entry.actor}`}>{entry.actor}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && (
            <div className="operations-log__empty" role="status">
              <Icon name="search" size={22}/>
              <strong>No matching log entry</strong>
              <span>Change the filter or search term.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
