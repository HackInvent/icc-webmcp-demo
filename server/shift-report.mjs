import { randomUUID } from "node:crypto";

const MAX_LOG_ENTRIES = 1_000;
const MAX_REPORT_HTML_CHARACTERS = 80_000;
const ALLOWED_REPORT_TAGS = new Set([
  "p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li",
  "h1", "h2", "h3", "blockquote", "hr", "table", "thead", "tbody", "tr",
  "th", "td",
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function boundedText(value, maximum = 500) {
  const normalized = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
  return normalized.slice(0, maximum);
}

function serviceDate(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(timestamp);
}

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function durationLabel(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return "—";
  const seconds = Math.round(durationSeconds);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
  return `${remaining}s`;
}

export function sanitizeShiftReportHtml(value) {
  if (typeof value !== "string" || value.length > MAX_REPORT_HTML_CHARACTERS) {
    throw new TypeError(
      `Report content must be HTML text of at most ${MAX_REPORT_HTML_CHARACTERS} characters.`,
    );
  }
  const withoutDangerousBlocks = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|template|svg|math)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|template|svg|math)[^>]*\/?>/gi, "");
  return withoutDangerousBlocks.replace(
    /<\s*(\/?)\s*([a-z0-9-]+)(?:\s[^>]*)?>/gi,
    (_match, closing, rawTag) => {
      const tag = String(rawTag).toLowerCase();
      if (!ALLOWED_REPORT_TAGS.has(tag)) return "";
      if (tag === "br" || tag === "hr") return `<${tag}>`;
      return `<${closing ? "/" : ""}${tag}>`;
    },
  ).trim();
}

function logIdentifier(shift, sequence) {
  const prefix = shift.shiftId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  return `LOG-${prefix}-${String(sequence).padStart(5, "0")}`;
}

export function appendShiftLog(shift, input) {
  const sequence = shift.nextLogSequence;
  const entry = {
    id: logIdentifier(shift, sequence),
    sequence,
    category: input.category,
    eventType: boundedText(input.eventType, 80),
    actor: input.actor,
    recordedAt: input.recordedAt,
    operationalTime: input.operationalTime,
    title: boundedText(input.title, 180),
    summary: boundedText(input.summary, 1_200),
    incidentId: boundedText(input.incidentId, 96) || null,
    entityIds: [...new Set((input.entityIds ?? [])
      .map((item) => boundedText(item, 96))
      .filter(Boolean))].slice(0, 16),
    durationSeconds: Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0
      ? Math.round(input.durationSeconds)
      : null,
  };
  shift.nextLogSequence += 1;
  shift.logs = [...shift.logs, entry].slice(-MAX_LOG_ENTRIES);
  return entry;
}

function incidentLogInput(incident, source, recordedAt, operationalTime) {
  const occurrence = Number.isFinite(incident.startedAt)
    ? incident.startedAt
    : operationalTime;
  const status = boundedText(incident.status, 32) || "active";
  const code = boundedText(incident.incidentCode, 96);
  const location = boundedText(incident.location, 160);
  return {
    category: "incident",
    eventType: status === "planned" ? "incident-planned" : "incident-present",
    actor: "system",
    recordedAt,
    operationalTime: occurrence,
    title: boundedText(incident.title, 180) || `Incident ${incident.id}`,
    summary: [code, source, status, location].filter(Boolean).join(" · "),
    incidentId: incident.id,
    entityIds: [incident.id],
    durationSeconds: status === "active" || status === "acknowledged"
      ? Math.max(0, (operationalTime - occurrence) / 1_000)
      : null,
  };
}

function initialReportHtml(startedAt, startedOperationalTime) {
  return [
    "<h1>End-of-shift operational report</h1>",
    `<p><strong>Service date:</strong> ${escapeHtml(serviceDate(startedOperationalTime))}</p>`,
    `<p><strong>Shift opened:</strong> ${escapeHtml(timeLabel(startedOperationalTime))}</p>`,
    "<h2>Executive summary</h2>",
    "<p>Complete this section or ask the agent to prepare a log-grounded draft.</p>",
    "<h2>Incidents and operational impact</h2>",
    "<p>Incident chronology will be prepared from the persisted operations log.</p>",
    "<h2>Actions taken</h2>",
    "<p>Record decisions, procedure steps, coordination and restoration actions.</p>",
    "<h2>Outstanding items and handover</h2>",
    "<p>Record any unresolved risks, monitoring requirements or follow-up investigation.</p>",
    "<h2>Operator sign-off</h2>",
    `<p>Draft created ${escapeHtml(new Date(startedAt).toISOString())}.</p>`,
  ].join("");
}

export function createShiftWorkspace(options) {
  const shiftId = randomUUID();
  const shift = {
    shiftId,
    startedAt: options.recordedAt,
    startedOperationalTime: options.operationalTime,
    nextLogSequence: 1,
    logs: [],
    report: {
      reportId: randomUUID(),
      status: "draft",
      title: `End-of-shift report · ${serviceDate(options.operationalTime)}`,
      contentHtml: initialReportHtml(options.recordedAt, options.operationalTime),
      createdAt: options.recordedAt,
      updatedAt: options.recordedAt,
      frozenAt: null,
      generatedAt: null,
      sourceLogSequence: 0,
    },
  };
  appendShiftLog(shift, {
    category: "system",
    eventType: "shift-started",
    actor: "system",
    recordedAt: options.recordedAt,
    operationalTime: options.operationalTime,
    title: "Operational shift opened",
    summary: `A new persisted shift workspace started at ${timeLabel(options.operationalTime)}.`,
    incidentId: null,
    entityIds: [],
    durationSeconds: 0,
  });
  const seen = new Set();
  for (const [source, incidents] of [
    ["network", options.nativeIncidents ?? []],
    ["corridor", options.detailedIncidents ?? []],
  ]) {
    for (const incident of incidents) {
      if (!incident?.id || seen.has(incident.id)) continue;
      seen.add(incident.id);
      appendShiftLog(
        shift,
        incidentLogInput(incident, source, options.recordedAt, options.operationalTime),
      );
    }
  }
  shift.report.sourceLogSequence = shift.nextLogSequence - 1;
  return shift;
}

function incidentStart(shift, incidentId) {
  const events = shift.logs.filter((entry) => entry.incidentId === incidentId);
  if (events.length === 0) return null;
  return Math.min(...events.map((entry) => entry.operationalTime));
}

export function recordCommandInShift(shift, input) {
  const { type, payload, result, recordedAt, operationalTime } = input;
  if (type === "update_shift_report" && payload.source !== "agent") return [];
  const entries = [];
  const append = (entry) => entries.push(appendShiftLog(shift, {
    actor: "operator",
    recordedAt,
    operationalTime,
    incidentId: null,
    entityIds: [],
    durationSeconds: null,
    ...entry,
  }));
  const incidentFromResult = result?.incident ?? result?.applied?.incident ?? null;
  if (["create_native_incident", "add_detailed_incident", "schedule_power_incident"].includes(type)) {
    const incident = incidentFromResult;
    if (incident?.id) {
      append({
        category: "incident",
        eventType: incident.status === "planned" ? "incident-planned" : "incident-created",
        title: incident.title ?? `Incident ${incident.id}`,
        summary: [incident.incidentCode, incident.status, incident.location, incident.summary]
          .filter(Boolean).join(" · "),
        incidentId: incident.id,
        entityIds: [incident.id, incident.target?.id].filter(Boolean),
        durationSeconds: 0,
      });
    }
    return entries;
  }
  if (type === "set_detailed_incident_status") {
    const start = incidentStart(shift, payload.id);
    append({
      category: "incident",
      eventType: "incident-status-changed",
      title: `${payload.id} · status ${payload.status}`,
      summary: `The operator recorded incident status ${payload.status}.`,
      incidentId: payload.id,
      entityIds: [payload.id],
      durationSeconds: start === null ? null : Math.max(0, (operationalTime - start) / 1_000),
    });
    return entries;
  }
  if (type === "apply_procedure_step") {
    const start = incidentStart(shift, payload.incidentId);
    const evidenceReference = boundedText(
      result?.stepRecord?.operatorEvidenceReference ?? payload.operatorEvidenceReference,
      160,
    );
    append({
      category: "operator-action",
      eventType: "procedure-step-recorded",
      title: `Procedure step ${payload.stepId} recorded`,
      summary: `${payload.procedureId} rev. ${payload.procedureRevision} · ${result.capability ?? "operator check"}` +
        (evidenceReference ? ` · authority reference ${evidenceReference}` : ""),
      incidentId: payload.incidentId,
      entityIds: [payload.incidentId, payload.procedureId, payload.stepId],
      durationSeconds: start === null ? null : Math.max(0, (operationalTime - start) / 1_000),
    });
    if (result.normalStateVerification?.incidentResolved) {
      append({
        category: "incident",
        eventType: "incident-resolved",
        title: `${payload.incidentId} returned to normal`,
        summary: "The procedure closure gate recorded the incident as resolved.",
        incidentId: payload.incidentId,
        entityIds: [payload.incidentId],
        durationSeconds: start === null ? null : Math.max(0, (operationalTime - start) / 1_000),
      });
    }
    return entries;
  }
  if (type === "update_procedure_step") {
    const changedFields = Array.isArray(result?.changedFields)
      ? result.changedFields.map((field) => boundedText(field, 64)).filter(Boolean)
      : [];
    append({
      category: "operator-action",
      eventType: "procedure-step-revision-published",
      title: `Procedure step ${payload.stepId} revised`,
      summary: `${payload.procedureId} · ${result?.previousRevision ?? payload.expectedProcedureRevision} → ${result?.procedure?.revision ?? "new revision"}` +
        (changedFields.length > 0 ? ` · changed ${changedFields.join(", ")}` : ""),
      entityIds: [payload.procedureId, payload.stepId],
    });
    return entries;
  }
  if (type === "update_shift_report" && payload.source === "agent") {
    append({
      category: "decision-support",
      eventType: "report-agent-draft-applied",
      actor: "agent",
      title: "Agent-assisted report draft applied",
      summary: `The report was prepared from ${shift.logs.length} persisted shift log entries for operator review.`,
      entityIds: [shift.report.reportId],
    });
    return entries;
  }
  const descriptors = {
    reset_all: ["system", "workspace-reset", "Operational workspace reset", "A new shift baseline and report were opened."],
    set_speed: ["operator-action", "clock-rate-changed", "Operational clock rate changed", `Clock rate set to ×${payload.speed}.`],
    activate_native_scenario: ["system", "operational-context-activated", "Operational context activated", `Context ${payload.scenarioId} activated.`],
    import_configuration: ["system", "baseline-imported", "Operational baseline imported", `Baseline ${payload.name ?? "imported configuration"} installed.`],
    insert_native_train: [
      "operator-action",
      "train-inserted",
      `Train ${result?.insertion?.train?.id ?? "reinforcement"} inserted`,
      `${payload.lineCode} · ${payload.stationId} · direction ${payload.direction === 1 ? "outbound" : "inbound"}.`,
    ],
    insert_native_shuttle: [
      "operator-action",
      "shuttle-ordered",
      `Shuttle ${result?.insertion?.shuttle?.id ?? "service"} ordered`,
      `${payload.lineCode} · ${payload.departureStationId} → ${payload.arrivalStationId} · 15 km/h · 100 passengers.`,
    ],
    evaluate_native_response: ["decision-support", "response-evaluated", "Incident response options evaluated", `Evaluation ${result?.evaluation?.id ?? "recorded"}.`],
    apply_native_response: ["operator-action", "reviewed-response-applied", "Reviewed incident response applied", result?.applied?.message ?? result?.applied?.receipt?.summary ?? "The reviewed response was applied."],
    set_power_status: ["operator-action", "power-status-changed", `Power section ${payload.id} · ${payload.status}`, "The operator changed the traction-power state."],
    regulate_train: ["operator-action", "train-regulated", `Train ${payload.trainId} · ${payload.action}`, result?.message ?? "The regulation action was applied."],
    close_circuit: ["operator-action", "track-circuit-closed", `Track circuit ${payload.circuitId} closed`, result?.message ?? payload.note ?? "The closure was recorded."],
    reopen_circuit: ["operator-action", "track-circuit-reopened", `Track circuit ${payload.circuitId} reopened`, result?.message ?? "The reopening was recorded."],
    load_schedule_plan: ["operator-action", "schedule-loaded", "D-1 schedule plan loaded", `Schedule version ${result?.version ?? "updated"}.`],
    schedule_preview: ["decision-support", "schedule-previewed", "Schedule change preview created", `Preview ${result?.preview?.id ?? "recorded"}.`],
    schedule_evaluate: ["decision-support", "schedule-impact-evaluated", "Schedule impact evaluated", `Impact ${result?.impact?.id ?? "recorded"}.`],
    schedule_authorize: ["operator-action", "schedule-authorized", "Schedule change authorized", `Preview ${payload.previewId} authorized.`],
    schedule_commit: ["operator-action", "schedule-committed", "Schedule change committed", `Receipt ${result?.receipt?.id ?? "recorded"}.`],
    schedule_discard: ["operator-action", "schedule-preview-discarded", "Schedule preview discarded", "The pending schedule proposal was discarded."],
    schedule_undo: ["operator-action", "schedule-change-undone", "Last schedule application undone", `Schedule version ${result?.version ?? "restored"}.`],
    freeze_shift_report: ["operator-action", "shift-report-frozen", "End-of-shift report frozen", "Editing was locked before printing and archival."],
  };
  const descriptor = descriptors[type] ?? [
    "operator-action",
    type,
    type.replaceAll("_", " "),
    "The operation was recorded by the server.",
  ];
  append({
    category: descriptor[0],
    eventType: descriptor[1],
    title: descriptor[2],
    summary: descriptor[3],
    incidentId: result?.applied?.incidentId ?? null,
    entityIds: [
      payload.id,
      payload.incidentId,
      payload.trainId,
      payload.circuitId,
      result?.applied?.incidentId,
      result?.insertion?.train?.id,
      result?.insertion?.stationId,
    ].filter(Boolean),
  });
  return entries;
}

export function recordIncidentTransitions(shift, input) {
  const entries = [];
  const beforeById = new Map((input.beforeIncidents ?? []).map((incident) => [incident.id, incident]));
  for (const incident of input.afterIncidents ?? []) {
    const before = beforeById.get(incident.id);
    if (!before && incident.status === "active") {
      entries.push(appendShiftLog(shift, incidentLogInput(
        incident,
        input.source,
        input.recordedAt,
        input.operationalTime,
      )));
      continue;
    }
    if (before?.status === incident.status) continue;
    const start = incidentStart(shift, incident.id) ?? incident.startedAt;
    entries.push(appendShiftLog(shift, {
      category: "incident",
      eventType: `incident-${incident.status}`,
      actor: "system",
      recordedAt: input.recordedAt,
      operationalTime: input.operationalTime,
      title: `${incident.title} · ${incident.status}`,
      summary: `${incident.id} changed from ${before?.status ?? "new"} to ${incident.status}.`,
      incidentId: incident.id,
      entityIds: [incident.id],
      durationSeconds: Number.isFinite(start)
        ? Math.max(0, (input.operationalTime - start) / 1_000)
        : null,
    }));
  }
  return entries;
}

function reportIncidentNarratives(shift) {
  const ordered = [...shift.logs].sort((left, right) => left.sequence - right.sequence);
  const incidentIds = [...new Set(ordered
    .filter((entry) => entry.incidentId)
    .map((entry) => entry.incidentId))];
  const incidents = incidentIds.map((incidentId) => {
    const entries = ordered.filter((entry) => entry.incidentId === incidentId);
    const firstIncident = entries.find((entry) => entry.category === "incident") ?? entries[0];
    const actions = entries.filter((entry) => entry !== firstIncident);
    const actionList = actions.length > 0
      ? `<ol>${actions.map((entry) => `<li><strong>${escapeHtml(timeLabel(entry.operationalTime))}</strong> — ${escapeHtml(entry.title)}. ${escapeHtml(entry.summary)} <em>[${escapeHtml(entry.id)}]</em></li>`).join("")}</ol>`
      : "<p>No operator action was recorded for this incident.</p>";
    const duration = entries.reduce((latest, entry) =>
      Number.isFinite(entry.durationSeconds) ? Math.max(latest, entry.durationSeconds) : latest,
    -1);
    return [
      `<h3>${escapeHtml(timeLabel(firstIncident.operationalTime))} · ${escapeHtml(firstIncident.title)} (${escapeHtml(incidentId)})</h3>`,
      `<p>${escapeHtml(firstIncident.summary)}${duration >= 0 ? ` Duration recorded: ${escapeHtml(durationLabel(duration))}.` : ""}</p>`,
      actionList,
    ].join("");
  }).join("");
  return incidents || "<p>No incident was recorded during this shift.</p>";
}

export function buildShiftReportHtml(shift, assistedDraft = null) {
  const incidentEntries = shift.logs.filter((entry) => entry.category === "incident");
  const actionEntries = shift.logs.filter((entry) => entry.category === "operator-action");
  const latestOperationalTime = shift.logs.reduce(
    (latest, entry) => Math.max(latest, entry.operationalTime),
    shift.startedOperationalTime,
  );
  const summary = assistedDraft?.executiveSummary ??
    `${incidentEntries.length} incident events and ${actionEntries.length} operator actions were recorded during the current shift.`;
  const notable = assistedDraft?.notableEvents ?? [];
  const investigationPoints = assistedDraft?.investigationPoints ?? [];
  const handoverItems = assistedDraft?.handoverItems ?? [];
  const list = (items, empty) => items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(empty)}</p>`;
  return sanitizeShiftReportHtml([
    "<h1>End-of-shift operational report</h1>",
    `<p><strong>Service date:</strong> ${escapeHtml(serviceDate(shift.startedOperationalTime))}<br>`,
    `<strong>Shift:</strong> ${escapeHtml(timeLabel(shift.startedOperationalTime))}–${escapeHtml(timeLabel(latestOperationalTime))}<br>`,
    `<strong>Shift ID:</strong> ${escapeHtml(shift.shiftId)}</p>`,
    "<h2>Executive summary</h2>",
    `<p>${escapeHtml(summary)}</p>`,
    "<h2>Key incidents and actions</h2>",
    list(notable.map((item) => `${item.narrative} [${item.logEntryId}]`), "No notable event was selected."),
    "<h2>Incident narratives and actions</h2>",
    reportIncidentNarratives(shift),
    "<h2>Investigation focus</h2>",
    list(investigationPoints.map((item) => `${item.title}: ${item.narrative} [${item.logEntryIds.join(", ")}]`), "No additional investigation point was identified from the available logs."),
    "<h2>Outstanding items and handover</h2>",
    list(handoverItems.map((item) => `${item.text} [${item.logEntryIds.join(", ")}]`), "No outstanding item was recorded. Verify before freezing."),
    "<h2>Operator sign-off</h2>",
    "<p>Name: ____________________ &nbsp;&nbsp; Time: ____________________</p>",
  ].join(""));
}

export function shiftReportEvidence(shift) {
  return {
    shiftId: shift.shiftId,
    startedAt: shift.startedAt,
    startedOperationalTime: shift.startedOperationalTime,
    latestLogSequence: shift.nextLogSequence - 1,
    logs: shift.logs.map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      category: entry.category,
      eventType: entry.eventType,
      actor: entry.actor,
      recordedAt: entry.recordedAt,
      operationalTime: entry.operationalTime,
      title: entry.title,
      summary: entry.summary,
      incidentId: entry.incidentId,
      entityIds: entry.entityIds,
      durationSeconds: entry.durationSeconds,
    })),
  };
}
