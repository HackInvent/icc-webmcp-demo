import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { RailSnapshot } from "../rail/domain";
import { hashOperationalContext } from "../schedules/quality";
import { formatScheduleMinutes } from "../schedules/time";
import { scheduleWorkspace } from "../schedules/workspace";
import type {
  ScheduleChange,
  ScheduleChangeRequest,
  ScheduleService,
} from "../schedules/types";
import { Icon } from "./Icon";
import { StatusPill } from "./StatusPill";

interface ScheduleDecisionDeskProps {
  snapshot: RailSnapshot;
  onFeedback: (message: string, tone?: "notice" | "error") => void;
}

type ActionKind = ScheduleChangeRequest["kind"];

const actionLabels: Record<ActionKind, string> = {
  shift_service: "Shift times",
  reassign_driver: "Reassign driver",
  change_track: "Change track",
  cancel_service: "Cancel service",
};


function displayValue(field: keyof ScheduleService, value: string | number | null): string {
  if (value === null || value === "") return "Unassigned";
  if ((field === "departureMinutes" || field === "arrivalMinutes") && typeof value === "number") {
    return formatScheduleMinutes(value);
  }
  return String(value);
}

function fieldLabel(field: keyof ScheduleService): string {
  const labels: Partial<Record<keyof ScheduleService, string>> = {
    departureMinutes: "Departure",
    arrivalMinutes: "Arrival",
    driverToken: "Driver",
    track: "Track",
    status: "Status",
  };
  return labels[field] ?? field;
}

function trustedActivation(event: ReactMouseEvent<HTMLButtonElement>): boolean {
  return event.isTrusted && (navigator.userActivation?.isActive ?? true);
}

function issueMessage(issue: unknown): string {
  if (typeof issue === "string") return issue;
  if (issue && typeof issue === "object" && "message" in issue) {
    return String((issue as { message: unknown }).message);
  }
  return "Operational constraint requires review.";
}

function requestSummary(request: ScheduleChangeRequest, service?: ScheduleService): string {
  const target = service?.serviceId ?? request.serviceId;
  switch (request.kind) {
    case "shift_service":
      return `${target} · shift ${request.deltaMinutes > 0 ? "+" : ""}${request.deltaMinutes} minutes`;
    case "reassign_driver":
      return `${target} · assign ${request.driverToken ?? "no driver"}`;
    case "change_track":
      return `${target} · move to track ${request.track}`;
    case "cancel_service":
      return `${target} · cancel scheduled service`;
  }
}

function DiffRow({ change }: { change: ScheduleChange }) {
  return (
    <div className="schedule-diff-row">
      <span>
        <strong>{change.serviceId}</strong>
        <small>{fieldLabel(change.field)}</small>
      </span>
      <div>
        <del>{displayValue(change.field, change.before)}</del>
        <Icon name="arrow" size={13} />
        <ins>{displayValue(change.field, change.after)}</ins>
      </div>
    </div>
  );
}

export function ScheduleDecisionDesk({ snapshot, onFeedback }: ScheduleDecisionDeskProps) {
  const state = useSyncExternalStore(
    scheduleWorkspace.subscribe,
    scheduleWorkspace.getSnapshot,
    scheduleWorkspace.getSnapshot,
  );
  const plan = scheduleWorkspace.currentPlan();
  const [kind, setKind] = useState<ActionKind>("shift_service");
  const [selectedServiceId, setSelectedServiceId] = useState(plan.services[0]?.serviceId ?? "");
  const [deltaMinutes, setDeltaMinutes] = useState(5);
  const [driverToken, setDriverToken] = useState(snapshot.drivers[0]?.id ?? "");
  const [track, setTrack] = useState("2");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const effectiveServiceId = plan.services.some((service) => service.serviceId === selectedServiceId)
    ? selectedServiceId
    : (plan.services[0]?.serviceId ?? "");
  const selectedService = plan.services.find((service) => service.serviceId === effectiveServiceId);
  const preview = state.pendingPreview;
  const impact = preview && state.pendingImpact?.previewId === preview.id ? state.pendingImpact : null;
  const contextHash = useMemo(() => hashOperationalContext(snapshot), [snapshot]);
  const contextCurrent = Boolean(
    preview && impact && preview.contextHash === contextHash && impact.contextHash === contextHash,
  );
  const isAuthorized = Boolean(
    preview &&
    contextCurrent &&
    impact &&
    state.authorizedPreviewId === preview.id &&
    state.authorizedImpactId === impact.id,
  );
  const hardBlockCount = impact?.hardBlocks.length ?? 0;

  const draft = useMemo<ScheduleChangeRequest | null>(() => {
    if (!effectiveServiceId) return null;
    switch (kind) {
      case "shift_service":
        return { kind, serviceId: effectiveServiceId, deltaMinutes };
      case "reassign_driver":
        return { kind, serviceId: effectiveServiceId, driverToken: driverToken || null };
      case "change_track":
        return { kind, serviceId: effectiveServiceId, track: track.trim() };
      case "cancel_service":
        return { kind, serviceId: effectiveServiceId };
    }
  }, [deltaMinutes, driverToken, effectiveServiceId, kind, track]);

  function run(action: () => unknown | Promise<unknown>, success: string): void {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void Promise.resolve()
      .then(action)
      .then(() => onFeedback(success, "notice"))
      .catch((caught: unknown) => {
        onFeedback(caught instanceof Error ? caught.message : "The schedule action failed.", "error");
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }

  function requireTrusted(
    event: ReactMouseEvent<HTMLButtonElement>,
    action: () => unknown | Promise<unknown>,
    success: string,
  ): void {
    if (!trustedActivation(event)) {
      onFeedback("This action requires a trusted browser activation in the visible decision desk.", "error");
      return;
    }
    run(action, success);
  }

  return (
    <aside className="schedule-decision-column" id="text-text-schedules-decision-support" aria-label="Schedule decision support" aria-busy={busy}>
      {!preview ? (
        <section className="panel schedule-builder" id="text-text-schedules-decision-builder" aria-labelledby="schedule-builder-heading">
          <header className="panel__header">
            <div>
              <span className="panel__eyebrow">DECISION BUILDER</span>
              <h2 id="schedule-builder-heading">Prepare one action</h2>
            </div>
            <StatusPill tone="neutral">Not applied</StatusPill>
          </header>

          <div className="schedule-builder__body" id="text-text-schedules-decision-form">
            <label className="schedule-field">
              <span>Action</span>
              <select value={kind} onChange={(event) => setKind(event.target.value as ActionKind)}>
                {Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="schedule-field">
              <span>Target service</span>
              <select value={effectiveServiceId} onChange={(event) => setSelectedServiceId(event.target.value)}>
                {plan.services.map((service) => (
                  <option key={service.serviceId} value={service.serviceId}>
                    {service.serviceId} · {formatScheduleMinutes(service.departureMinutes)} · {service.origin}
                  </option>
                ))}
              </select>
            </label>

            {kind === "shift_service" && (
              <label className="schedule-field">
                <span>Time adjustment</span>
                <select value={deltaMinutes} onChange={(event) => setDeltaMinutes(Number(event.target.value))}>
                  <option value={5}>5 minutes later</option>
                  <option value={10}>10 minutes later</option>
                  <option value={15}>15 minutes later</option>
                  <option value={-5}>5 minutes earlier</option>
                  <option value={-10}>10 minutes earlier</option>
                  <option value={-15}>15 minutes earlier</option>
                </select>
              </label>
            )}
            {kind === "reassign_driver" && (
              <label className="schedule-field">
                <span>Driver token</span>
                <select value={driverToken} onChange={(event) => setDriverToken(event.target.value)}>
                  <option value="">Unassigned</option>
                  {snapshot.drivers.map((driver) => (
                    <option key={driver.id} value={driver.id}>{driver.id} · {driver.depot}</option>
                  ))}
                </select>
              </label>
            )}
            {kind === "change_track" && (
              <label className="schedule-field">
                <span>New track</span>
                <input value={track} maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9._/-]{0,19}" onChange={(event) => setTrack(event.target.value)} />
              </label>
            )}
            {kind === "cancel_service" && (
              <div className="schedule-cancel-warning">
                <Icon name="alert" size={16} />
                Cancellation remains a draft until its passenger and operational impact is evaluated.
              </div>
            )}

            {draft && (
              <div className="schedule-draft" id="text-text-schedules-decision-draft" aria-label="Visible decision draft">
                <span><i /> DRAFT · NOT EVALUATED</span>
                <strong>{requestSummary(draft, selectedService)}</strong>
                <small>Bound to {scheduleWorkspace.currentHash().slice(0, 18)}…</small>
              </div>
            )}

            <button
              type="button"
              className="button button--primary button--block"
              disabled={busy || !draft || (draft.kind === "change_track" && !draft.track)}
              onClick={() => draft && run(
                () => scheduleWorkspace.preview(draft, snapshot, "human"),
                "Decision draft staged. Committed schedules are unchanged.",
              )}
            >
              Stage decision draft <Icon name="arrow" size={15} />
            </button>
            <p className="schedule-policy-note">
              This creates a hash-bound preview only. The current timetable stays unchanged.
            </p>
          </div>
        </section>
      ) : (
        <section className="panel schedule-review" id="text-text-schedules-decision-review" aria-labelledby="schedule-review-heading">
          <header className="panel__header">
            <div>
              <span className="panel__eyebrow">REVIEW GATE</span>
              <h2 id="schedule-review-heading">Evaluate before application</h2>
            </div>
            <StatusPill tone={impact ? (hardBlockCount ? "danger" : "ok") : "warning"}>
              {impact ? (hardBlockCount ? "Blocked" : "Evaluated") : "Impact required"}
            </StatusPill>
          </header>

          <div className="schedule-review__body" id="text-text-schedules-decision-review-body">
            <div className="schedule-preview-summary">
              <span>UNCOMMITTED PREVIEW</span>
              <strong>{preview.summary}</strong>
              <small>{preview.affectedServiceIds.length} service{preview.affectedServiceIds.length === 1 ? "" : "s"} touched · preview only</small>
            </div>
            <div className="schedule-hash-route" aria-label="Projected schedule hash">
              <code title={preview.beforeHash}>{preview.beforeHash.slice(0, 12)}…</code>
              <Icon name="arrow" size={14} />
              <code title={preview.afterHash}>{preview.afterHash.slice(0, 12)}…</code>
            </div>

            <div className="schedule-diff-list" aria-label="Complete schedule patch">
              {preview.changes.map((change, index) => <DiffRow key={`${change.serviceId}-${change.field}-${index}`} change={change} />)}
            </div>

            {preview.warnings.length > 0 && (
              <div className="schedule-issues schedule-issues--warning">
                <strong><Icon name="clock" size={15} /> Draft warning{preview.warnings.length === 1 ? "" : "s"}</strong>
                {preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
              </div>
            )}

            {!impact ? (
              <div className="schedule-evaluation-gate">
                <Icon name="activity" size={19} />
                <div>
                  <strong>Operational impact has not been calculated</strong>
                  <span>Check coverage, conflicts, passenger delay, incidents, and isolated power sections.</span>
                </div>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => run(
                    () => scheduleWorkspace.evaluatePreview(preview.id, snapshot),
                    "Impact evaluation completed. Review every block and warning before applying.",
                  )}
                >
                  Evaluate impacts
                </button>
              </div>
            ) : (
              <>
                <section className="schedule-impact" id="text-text-schedules-impact-assessment" aria-label="Before and after impact comparison">
                  <div className="schedule-impact__headline">
                    <span>IMPACT ASSESSMENT</span>
                    <strong>{impact.assessment}</strong>
                    <em>Score {impact.score}/100</em>
                  </div>
                  <div className="schedule-impact-grid">
                    <article>
                      <span>Driver coverage</span>
                      <strong>{impact.baselineCoverage.percent}% <i>→</i> {impact.coverage.percent}%</strong>
                      <small>{impact.coverage.coveredServices}/{impact.coverage.operatingServices} staffed services</small>
                    </article>
                    <article>
                      <span>Operational conflicts</span>
                      <strong>{impact.baselineConflicts.length} <i>→</i> {impact.conflicts.length}</strong>
                      <small>{hardBlockCount} new hard block(s)</small>
                    </article>
                    <article>
                      <span>Passengers affected</span>
                      <strong>{impact.passengersAffected.toLocaleString("en-GB")}</strong>
                      <small>{impact.passengerDelayMinutes.toLocaleString("en-GB")} passenger-minutes</small>
                    </article>
                    <article>
                      <span>Context exposure</span>
                      <strong>{impact.incidentExposure.serviceCount + impact.powerExposure.serviceCount}</strong>
                      <small>{impact.incidentExposure.incidentIds.length} incident(s) · {impact.powerExposure.isolatedServiceIds.length} power-isolated</small>
                    </article>
                  </div>
                  <p>{impact.summary}</p>
                </section>

                {hardBlockCount > 0 && (
                  <div className="schedule-issues schedule-issues--hard" role="alert">
                    <strong><Icon name="alert" size={15} /> {hardBlockCount} hard block{hardBlockCount === 1 ? "" : "s"}</strong>
                    {impact.hardBlocks.map((block, index) => <p key={index}>{issueMessage(block)}</p>)}
                  </div>
                )}
                {impact.warnings.length > 0 && (
                  <div className="schedule-issues schedule-issues--warning">
                    <strong><Icon name="clock" size={15} /> {impact.warnings.length} warning{impact.warnings.length === 1 ? "" : "s"}</strong>
                    {impact.warnings.map((warning, index) => <p key={index}>{issueMessage(warning)}</p>)}
                  </div>
                )}

                {!contextCurrent && (
                  <div className="schedule-issues schedule-issues--hard" role="alert">
                    <strong><Icon name="alert" size={15} /> Operational context changed</strong>
                    <p>Discard this draft, then create and evaluate a fresh preview before authorization or application.</p>
                  </div>
                )}

                <div className="schedule-approval-zone" id="text-text-schedules-approval-actions">
                  {isAuthorized ? (
                    <div className="schedule-authorized"><i /> One-use agent application authorized</div>
                  ) : (
                    <button
                      type="button"
                      className="button schedule-agent-button"
                      disabled={busy || hardBlockCount > 0 || !contextCurrent}
                      onClick={(event) => requireTrusted(
                        event,
                        () => scheduleWorkspace.authorizePreview(preview.id, impact.id, snapshot),
                        "This exact preview and impact report are authorized for one agent application.",
                      )}
                    >
                      <Icon name="shield" size={15} /> Authorize agent application
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy || hardBlockCount > 0 || !contextCurrent}
                    onClick={(event) => requireTrusted(
                      event,
                      () => scheduleWorkspace.commitPreview(preview.id, impact.id, "human", snapshot),
                      "Reviewed schedule decision applied to the current operational state.",
                    )}
                  >
                    Apply myself now
                  </button>
                </div>
              </>
            )}

            <button
              type="button"
              className="schedule-discard"
              disabled={busy}
              onClick={() => run(() => scheduleWorkspace.discardPreview(), "Draft discarded. No schedule was changed.")}
            >
              Discard draft
            </button>
            <p className="schedule-policy-note">
              Evaluation is bound to the preview, timetable hash, and current rail context. Any change invalidates it.
            </p>
          </div>
        </section>
      )}

      <section className="panel schedule-history" id="text-text-schedules-decision-receipt" aria-labelledby="schedule-history-heading">
        <header className="panel__header">
          <div>
            <span className="panel__eyebrow">VERSION CONTROL</span>
            <h2 id="schedule-history-heading">Decision receipt</h2>
          </div>
          <StatusPill tone="info">v{state.cursor + 1}/{state.versions.length}</StatusPill>
        </header>
        <div className="schedule-history__body">
          <div>
            <span>Current hash</span>
            <code title={scheduleWorkspace.currentHash()}>{scheduleWorkspace.currentHash().slice(0, 18)}…</code>
          </div>
          {state.lastReceipt && (
            <div>
              <span>Last receipt</span>
              <code title={state.lastReceipt.id}>{state.lastReceipt.id}</code>
              <small>{state.lastReceipt.assessment} · score {state.lastReceipt.score}</small>
            </div>
          )}
          <div className="schedule-activity">
            <span>Latest activity</span>
            <p>{state.lastEvent}</p>
          </div>
          <button
            type="button"
            className="button button--secondary button--block"
            disabled={busy || state.cursor <= 0 || Boolean(preview)}
            onClick={(event) => requireTrusted(
              event,
              () => scheduleWorkspace.undo("human"),
              "Last schedule change undone. The prior version hash is active again.",
            )}
          >
            <Icon name="reset" size={15} /> Undo last application
          </button>
        </div>
      </section>
    </aside>
  );
}
