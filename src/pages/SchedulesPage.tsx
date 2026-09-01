import { useRef, useState, useSyncExternalStore } from "react";
import type { EntitySelection, RailSnapshot } from "../rail/domain";
import { lineDefinition } from "../rail/topology";
import {
  MAX_SCHEDULE_FILE_BYTES,
  parseScheduleCsv,
} from "../schedules/csv";
import type { ScheduleService } from "../schedules/types";
import { formatScheduleMinutes } from "../schedules/time";
import { scheduleWorkspace } from "../schedules/workspace";
import { Icon } from "../components/Icon";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { ScheduleDecisionDesk } from "../components/ScheduleDecisionDesk";
import { StatusPill } from "../components/StatusPill";

interface SchedulesPageProps {
  snapshot: RailSnapshot;
  onSelect: (selection: EntitySelection) => void;
}

interface Feedback {
  message: string;
  tone: "notice" | "error";
}


function serviceStatusTone(status: ScheduleService["status"]): "ok" | "neutral" {
  return status === "scheduled" ? "ok" : "neutral";
}

function TimeCell({ before, after }: { before: number; after: number }) {
  if (before === after) return <strong>{formatScheduleMinutes(before)}</strong>;
  return (
    <span className="schedule-table-diff">
      <del>{formatScheduleMinutes(before)}</del>
      <ins>{formatScheduleMinutes(after)}</ins>
    </span>
  );
}

function TextCell({ before, after, empty = "Unassigned" }: { before: string | null; after: string | null; empty?: string }) {
  const beforeLabel = before || empty;
  const afterLabel = after || empty;
  if (beforeLabel === afterLabel) return <strong>{beforeLabel}</strong>;
  return (
    <span className="schedule-table-diff">
      <del>{beforeLabel}</del>
      <ins>{afterLabel}</ins>
    </span>
  );
}

export function SchedulesPage({ snapshot, onSelect }: SchedulesPageProps) {
  const state = useSyncExternalStore(
    scheduleWorkspace.subscribe,
    scheduleWorkspace.getSnapshot,
    scheduleWorkspace.getSnapshot,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const plan = scheduleWorkspace.currentPlan();
  const preview = state.pendingPreview;
  const projectedById = new Map(
    (preview?.result.services ?? []).map((service) => [service.serviceId, service]),
  );
  const operating = plan.services.filter((service) => service.status === "scheduled");
  const automatic = operating.filter((service) => service.lineId === "M14").length;
  const covered = operating.filter(
    (service) => service.lineId === "M14" || service.driverToken !== null,
  ).length;
  const driverTokens = new Set(operating.map((service) => service.driverToken).filter(Boolean));
  const conflicts = state.pendingImpact?.conflicts.length ?? 0;

  function report(message: string, tone: "notice" | "error" = "notice"): void {
    setFeedback({ message, tone });
  }

  async function importFile(file: File): Promise<void> {
    setFeedback(null);
    if (file.size > MAX_SCHEDULE_FILE_BYTES) {
      report(`Choose a CSV smaller than ${Math.round(MAX_SCHEDULE_FILE_BYTES / 1_048_576)} MB.`, "error");
      return;
    }
    try {
      const text = await file.text();
      const imported = parseScheduleCsv(
        text,
        file.name,
        plan.serviceDate,
      );
      await scheduleWorkspace.loadPlan(imported);
      report("Schedule imported into the current operational workspace. The source file was not overwritten.");
    } catch (caught) {
      report(caught instanceof Error ? caught.message : "Could not parse the schedule CSV.", "error");
    }
  }

  return (
    <div className="page schedule-page" id="text-text-schedules-page">
      <PageHeader
        contentId="text-text-schedules-header"
        eyebrow="DAY-AHEAD DECISION SUPPORT"
        title="Schedules & decisions"
        description="Load a bounded next-day operating plan, prepare one versioned change, and require an impact assessment before application."
        actions={(
          <>
            <button type="button" className="button button--secondary" onClick={() => fileInput.current?.click()}>
              <Icon name="external" size={15} /> Import schedule CSV
            </button>
            <input
              ref={fileInput}
              data-testid="schedule-file-input"
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <span className="button button--secondary schedule-service-date" aria-label={`Service date ${plan.serviceDate}`}>
              <Icon name="calendar" size={15} /> {plan.serviceDate}
            </span>
          </>
        )}
      />

      <div className="notice notice--info schedule-trust-notice" id="text-text-schedules-transaction-pattern">
        <Icon name="shield" size={18} />
        <div>
          <strong>ProofSheet transaction pattern · D-1 decision workspace</strong>
          <span>Next-day plan {plan.serviceDate} · local import · immutable source · impact gate · undoable receipt · crew tokens abstract the RER A Nanterre-Préfecture handover.</span>
        </div>
      </div>

      {feedback && (
        <div className={`schedule-feedback schedule-feedback--${feedback.tone}`} id="text-text-schedules-feedback" role={feedback.tone === "error" ? "alert" : "status"} aria-atomic="true">
          <Icon name={feedback.tone === "error" ? "alert" : "shield"} size={16} />
          <span>{feedback.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setFeedback(null)}><Icon name="close" size={13} /></button>
        </div>
      )}

      <section className="kpi-grid kpi-grid--compact schedule-kpis" id="text-text-schedules-summary">
        <KpiCard
          label="Operating services"
          value={`${operating.length}/${plan.services.length}`}
          detail={`${plan.name} · current version`}
          icon="calendar"
          trend={`v${state.cursor + 1}`}
        />
        <KpiCard
          label="Driver token assignment"
          value={`${operating.length ? Math.round((covered / operating.length) * 1000) / 10 : 100}%`}
          detail={`${driverTokens.size} pseudonymous driver tokens · ${automatic} automatic`}
          icon="users"
          tone={covered < operating.length ? "warning" : "default"}
        />
        <KpiCard
          label="Decision state"
          value={preview ? (state.pendingImpact ? "Evaluated" : "Draft") : "Clean"}
          detail={preview ? "Committed plan is unchanged" : "No pending schedule patch"}
          icon="activity"
          tone={preview ? "purple" : "default"}
        />
        <KpiCard
          label="Detected conflicts"
          value={conflicts}
          detail={state.pendingImpact ? `${state.pendingImpact.hardBlocks.length} hard block(s)` : "Run impact evaluation to calculate"}
          icon="alert"
          tone={state.pendingImpact?.hardBlocks.length ? "danger" : conflicts ? "warning" : "default"}
        />
      </section>

      <section className="schedule-workspace-layout" id="text-text-schedules-workspace">
        <article className="panel schedule-stage" id="text-text-schedules-timetable">
          <header className="panel__header">
            <div>
              <span className="panel__eyebrow">VERSIONED TIMETABLE</span>
              <h2>{plan.name}</h2>
            </div>
            <div className="schedule-stage__meta">
              {preview && <StatusPill tone="purple">Preview overlay</StatusPill>}
              <code title={scheduleWorkspace.currentHash()}>{scheduleWorkspace.currentHash().slice(0, 14)}…</code>
            </div>
          </header>

          {preview && (
            <div className="schedule-preview-ribbon">
              <i /> Proposed values are overlaid below — committed timetable remains unchanged
            </div>
          )}

          <div
            id="text-text-schedules-timetable-table"
            className="table-wrap schedule-table-wrap"
            role="region"
            aria-label="Versioned timetable"
            tabIndex={0}
          >
            <table className="data-table schedule-table">
              <caption className="sr-only">Services in the current versioned D-1 timetable</caption>
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Route</th>
                  <th scope="col">Departure</th>
                  <th scope="col">Arrival</th>
                  <th scope="col">Track</th>
                  <th scope="col">Driver token</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {plan.services.map((service) => {
                  const projected = projectedById.get(service.serviceId) ?? service;
                  const line = lineDefinition(service.lineId);
                  const changed = projected !== service && (
                    projected.departureMinutes !== service.departureMinutes ||
                    projected.arrivalMinutes !== service.arrivalMinutes ||
                    projected.track !== service.track ||
                    projected.driverToken !== service.driverToken ||
                    projected.status !== service.status
                  );
                  return (
                    <tr
                      key={service.serviceId}
                      className={changed ? "schedule-row--changed" : undefined}
                    >
                      <td>
                        <div className="cell-main">
                          <span className="line-badge" style={{ background: line.color, color: line.textColor }}>{line.shortName}</span>
                          <span><strong>{service.serviceId}</strong><small>{service.circulationId}</small></span>
                        </div>
                      </td>
                      <td><strong>{service.origin}</strong><small className="cell-sub">→ {service.destination}</small></td>
                      <td><TimeCell before={service.departureMinutes} after={projected.departureMinutes} /></td>
                      <td><TimeCell before={service.arrivalMinutes} after={projected.arrivalMinutes} /></td>
                      <td><TextCell before={service.track} after={projected.track} empty="Unallocated" /></td>
                      <td>
                        {service.driverToken === projected.driverToken && service.driverToken ? (
                          <button
                            type="button"
                            className="inline-link"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelect({ type: "driver", id: service.driverToken! });
                            }}
                          >
                            {service.driverToken}
                          </button>
                        ) : (
                          <TextCell before={service.driverToken} after={projected.driverToken} />
                        )}
                      </td>
                      <td>
                        {service.status === projected.status ? (
                          <StatusPill tone={serviceStatusTone(service.status)}>{service.status}</StatusPill>
                        ) : (
                          <span className="schedule-table-diff schedule-table-diff--status">
                            <del>{service.status}</del>
                            <ins>{projected.status}</ins>
                          </span>
                        )}
                      </td>
                      <td className="schedule-table__action">
                        {service.trainId && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Open train ${service.trainId}`}
                            onClick={() => onSelect({ type: "train", id: service.trainId! })}
                          >
                            <Icon name="external" size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer className="schedule-stage__footer" id="text-text-schedules-latest-activity">
            <span><Icon name="activity" size={14} /> Latest activity</span>
            <p>{state.lastEvent}</p>
            <em>{plan.services.length} service rows · source retained locally</em>
          </footer>
        </article>

        <ScheduleDecisionDesk snapshot={snapshot} onFeedback={report} />
      </section>
    </div>
  );
}
