import type {
  CircuitClosureReason,
  CircuitClosureRejectionReason,
  LineId,
  RailSnapshot,
} from "../rail/domain";
import { MAX_CIRCUIT_CLOSURE_NOTE_LENGTH } from "../rail/simulation";
import { routeFor } from "../rail/topology";
import type { Awaitable, NativeNetworkControllerFacade } from "../rail/useNativeNetworkSimulation";
import { createNativeSimulationTools } from "./nativeTools";
import {
  ScheduleWorkspaceError,
  type ImpactEvaluation,
  type ScheduleChangeRequest,
  type ScheduleWorkspace,
} from "../schedules/types";

const LINE_IDS = ["RER_A", "RER_B", "M13", "M14"] as const;
const REGULATION_ACTIONS = ["priority", "hold", "turnback"] as const;
const CIRCUIT_CLOSURE_ACTIONS = ["close", "reopen"] as const;
const TRACK_TOKEN_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$";
const TRACK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$/;
const CIRCUIT_CLOSURE_REASONS = ["works", "incident"] as const;
const CIRCUIT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$";
const CIRCUIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SCHEDULE_CHANGE_KINDS = ["shift_service", "reassign_driver", "change_track", "cancel_service"] as const;
const SCHEDULE_HASH_PATTERN = "^schedule-[a-f0-9]{64}$";
const SCHEDULE_HASH = /^schedule-[a-f0-9]{64}$/;
const PREVIEW_ID_PATTERN = "^preview-[a-z0-9]+-[a-z0-9]+$";
const PREVIEW_ID = /^preview-[a-z0-9]+-[a-z0-9]+$/;
const IMPACT_ID_PATTERN = "^impact-[a-f0-9]{64}$";
const IMPACT_ID = /^impact-[a-f0-9]{64}$/;
const MAX_SCHEDULE_PAGE = 12;
const MAX_SCHEDULE_OFFSET = 10_000;
const MAX_RESULT_ITEMS = 12;
const MAX_RESULT_TEXT = 240;

export type CircuitClosureCommand =
  | { kind: "close"; reason: CircuitClosureReason; note: string }
  | { kind: "reopen" };

export type CircuitClosureFailureReason = CircuitClosureRejectionReason;

export type CircuitClosureDependencyResult =
  | {
      ok: true;
      outcome: "closed" | "reopened";
      message: string;
      circuitId: string;
    }
  | {
      ok: false;
      reason: CircuitClosureFailureReason;
      message: string;
      circuitId: string;
    };

export interface IccToolDependencies {
  regulate: (
    trainId: string,
    action: "priority" | "hold" | "turnback",
  ) => Awaitable<void | { ok: boolean; message: string }>;
  schedules: ScheduleWorkspace;
  setCircuitClosure: (
    circuitId: string,
    action: CircuitClosureCommand,
  ) => Awaitable<CircuitClosureDependencyResult>;
  nativeNetwork?: NativeNetworkControllerFacade;
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object.");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Tool input has an unsupported prototype.");
  return input as Record<string, unknown>;
}

function allowOnly(input: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(input).find((key) => !keys.includes(key));
  if (extra) throw new Error(`Unexpected input property "${extra}".`);
}

function requiredString(input: Record<string, unknown>, key: string, maxLength = 80): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${key} must be a short non-empty string.`);
  return value;
}

function requiredPatternString(
  input: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  description: string,
): string {
  const value = requiredString(input, key, 96);
  if (!pattern.test(value)) throw new Error(`${key} must be ${description}.`);
  return value;
}

function optionalLine(input: Record<string, unknown>): LineId | undefined {
  const value = input.line;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !LINE_IDS.includes(value as LineId)) throw new Error(`line must be one of ${LINE_IDS.join(", ")}.`);
  return value as LineId;
}

function boundedText(value: string, secrets: readonly string[] = []): string {
  const redacted = secrets.reduce(
    (text, secret) => secret.length > 0 ? text.split(secret).join("[redacted]") : text,
    value,
  );
  return redacted.slice(0, MAX_RESULT_TEXT);
}

function boundedStrings(values: readonly string[], secrets: readonly string[] = []): string[] {
  return values.slice(0, MAX_RESULT_ITEMS).map((value) => boundedText(value, secrets));
}

function blocked(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return { status: "blocked", reason, message: boundedText(message), ...details };
}

function scheduleErrorResult(
  error: unknown,
  fallbackReason = "invalid_request",
  fallbackMessage = "The schedule request could not be completed.",
): Record<string, unknown> {
  if (!(error instanceof ScheduleWorkspaceError)) return blocked(fallbackReason, fallbackMessage);
  const reasons: Record<string, string> = {
    PLAN_NOT_LOADED: "plan_not_loaded",
    PREVIEW_STALE: "preview_stale",
    IMPACT_REQUIRED: "impact_required",
    IMPACT_STALE: "impact_stale",
    CONTEXT_STALE: "context_stale",
    AUTHORIZATION_REQUIRED: "human_approval_required",
    HARD_BLOCK: "impact_hard_block",
    LIVE_FORBIDDEN: "live_forbidden",
    NO_CHANGES: "no_changes",
    INVALID_REQUEST: "invalid_request",
    NOTHING_TO_UNDO: "nothing_to_undo",
  };
  return blocked(reasons[error.code] ?? fallbackReason, error.message);
}

function staleScheduleHash(
  schedules: ScheduleWorkspace,
  expectedHash: string,
): Record<string, unknown> | null {
  let currentHash: string;
  try {
    currentHash = schedules.currentHash();
  } catch (error) {
    return scheduleErrorResult(error, "plan_not_loaded", "Load a schedule plan before continuing.");
  }
  if (expectedHash === currentHash) return null;
  return blocked(
    "stale_schedule",
    "The visible schedule plan changed. Inspect it again before continuing.",
    { expectedHash, currentHash },
  );
}

function scheduleChangeRequest(input: Record<string, unknown>): ScheduleChangeRequest {
  const rawKind = requiredString(input, "kind");
  if (!SCHEDULE_CHANGE_KINDS.includes(rawKind as typeof SCHEDULE_CHANGE_KINDS[number])) {
    throw new Error(`kind must be one of ${SCHEDULE_CHANGE_KINDS.join(", ")}.`);
  }
  const kind = rawKind as typeof SCHEDULE_CHANGE_KINDS[number];
  const serviceId = requiredString(input, "serviceId");
  if (kind === "shift_service") {
    allowOnly(input, ["expectedHash", "kind", "serviceId", "deltaMinutes"]);
    const deltaMinutes = input.deltaMinutes;
    if (!Number.isInteger(deltaMinutes) || Number(deltaMinutes) < -15 || Number(deltaMinutes) > 15 || Number(deltaMinutes) === 0) {
      throw new Error("deltaMinutes must be a non-zero integer from -15 to 15.");
    }
    return { kind, serviceId, deltaMinutes: Number(deltaMinutes) };
  }
  if (kind === "reassign_driver") {
    allowOnly(input, ["expectedHash", "kind", "serviceId", "driverToken"]);
    if (!Object.prototype.hasOwnProperty.call(input, "driverToken")) throw new Error("driverToken is required and may be null.");
    const driverToken = input.driverToken;
    if (driverToken !== null && (typeof driverToken !== "string" || !driverToken.trim() || driverToken.length > 80)) {
      throw new Error("driverToken must be null or a short non-empty string.");
    }
    return { kind, serviceId, driverToken };
  }
  if (kind === "change_track") {
    allowOnly(input, ["expectedHash", "kind", "serviceId", "track"]);
    return { kind, serviceId, track: requiredPatternString(input, "track", TRACK_TOKEN, "a 1–20 character track token") };
  }
  allowOnly(input, ["expectedHash", "kind", "serviceId"]);
  return { kind, serviceId };
}

function impactSecrets(impact: ImpactEvaluation): string[] {
  return impact.conflicts.flatMap((conflict) => conflict.resourceId ? [conflict.resourceId] : []);
}

export function createIccTools(
  getSnapshot: () => RailSnapshot,
  dependencies: IccToolDependencies,
): WebMcpToolDefinition[] {
  return [
    {
      name: "inspect_prim_feed",
      description: "Read the provenance, freshness, official line references, coverage and bounded passenger estimated-call evidence from the current IDFM PRIM SIRI Lite live feed or contract replay. Explicitly separates observed passenger information from simulated ICC telemetry.",
      inputSchema: {
        type: "object",
        properties: { line: { type: "string", enum: LINE_IDS } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput) => {
        const input = inputRecord(rawInput);
        allowOnly(input, ["line"]);
        const line = optionalLine(input);
        const snapshot = getSnapshot();
        const feed = snapshot.passengerFeed;
        if (!feed) {
          return blocked(
            "feed_unavailable",
            "No passenger-feed state is attached to the current page snapshot.",
            { revision: snapshot.revision },
          );
        }
        const lines = line
          ? feed.lines.filter((item) => item.lineId === line)
          : feed.lines;
        const observations = feed.observations.filter(
          (observation) => !line || observation.lineId === line,
        );
        const freshnessSeconds = feed.receivedAt
          ? Math.max(0, Math.round((Date.now() - Date.parse(feed.receivedAt)) / 1_000))
          : null;
        const upstreamAges = lines
          .map((item) => item.responseTimestamp
            ? Math.max(0, Math.round((Date.now() - Date.parse(item.responseTimestamp)) / 1_000))
            : null)
          .filter((age): age is number => age !== null);
        const maximumUpstreamAgeSeconds = feed.mode === "prim-live" && upstreamAges.length > 0
          ? Math.max(...upstreamAges)
          : null;
        const provenance = feed.mode === "prim-live"
          ? "observed_primitives_from_idfm_prim"
          : feed.mode === "prim-replay"
            ? "synthetic_values_in_authentic_siri_lite_contract"
            : "passenger_feed_disabled";

        return {
          status: feed.status,
          revision: snapshot.revision,
          scopeLine: line ?? "ALL",
          mode: feed.mode,
          provenance,
          provider: feed.provider,
          contract: feed.contract,
          requestedAt: feed.requestedAt,
          receivedAt: feed.receivedAt,
          connectorFreshnessSeconds: freshnessSeconds,
          maximumUpstreamAgeSeconds,
          freshnessAssessment: feed.mode !== "prim-live"
            ? "not_applicable_to_contract_replay"
            : maximumUpstreamAgeSeconds === null
              ? "unknown"
              : maximumUpstreamAgeSeconds <= 180
                ? "fresh"
                : "stale",
          coverage: lines.map((item) => ({
            lineId: item.lineId,
            lineRef: item.lineRef,
            status: item.status,
            observationCount: item.observationCount,
            responseTimestamp: item.responseTimestamp,
            upstreamAgeSeconds: feed.mode === "prim-live" && item.responseTimestamp
              ? Math.max(0, Math.round((Date.now() - Date.parse(item.responseTimestamp)) / 1_000))
              : null,
            error: item.error ? boundedText(item.error) : null,
          })),
          estimatedCalls: observations.slice(0, MAX_RESULT_ITEMS).map((observation) => ({
            lineId: observation.lineId,
            lineRef: observation.lineRef,
            journeyRef: boundedText(observation.journeyRef),
            vehicleJourneyName: boundedText(observation.vehicleJourneyName),
            destinationName: boundedText(observation.destinationName),
            stopPointRef: boundedText(observation.stopPointRef),
            stopPointName: boundedText(observation.stopPointName),
            expectedArrivalTime: observation.expectedArrivalTime,
            expectedDepartureTime: observation.expectedDepartureTime,
            delaySeconds: observation.delaySeconds,
            vehicleAtStop: observation.vehicleAtStop,
            quality: observation.quality,
          })),
          resultTruncated: observations.length > MAX_RESULT_ITEMS,
          limitations: boundedStrings(feed.limitations),
          safety: "Read-only passenger information. It is not a train-position, signalling, CDV, traction-power or crew command feed.",
        };
      },
    },
    {
      name: "prepare_shift_brief",
      description: "Read a bounded, ranked cross-domain handover from the exact visible Paris ICC revision. Correlates separately sourced passenger evidence, simulated traffic, incidents, D-1 crews, schedule review state, track circuits and power without changing any system.",
      inputSchema: {
        type: "object",
        properties: { line: { type: "string", enum: LINE_IDS } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput) => {
        const input = inputRecord(rawInput);
        allowOnly(input, ["line"]);
        const line = optionalLine(input);
        const snapshot = getSnapshot();
        const trains = line
          ? snapshot.trains.filter((train) => train.lineId === line)
          : snapshot.trains;
        const circuits = line
          ? snapshot.circuits.filter((circuit) => circuit.lineId === line)
          : snapshot.circuits;
        const drivers = line
          ? snapshot.drivers.filter((driver) => driver.qualifications.includes(line))
          : snapshot.drivers;
        const powerSections = line
          ? snapshot.powerSections.filter((section) => section.lineIds.includes(line))
          : snapshot.powerSections;
        const incidents = line
          ? snapshot.incidents.filter((incident) => incident.lineIds.includes(line))
          : snapshot.incidents;
        const operationalIncidents = incidents.filter(
          (incident) => incident.status === "active" || incident.status === "acknowledged",
        );
        const plannedIncidents = incidents.filter((incident) => incident.status === "planned");
        const impactedTrainIds = new Set(
          operationalIncidents.flatMap((incident) => incident.impactedTrainIds),
        );
        const passengersOnAffectedTrains = trains
          .filter((train) => impactedTrainIds.has(train.id))
          .reduce((total, train) => total + train.passengers, 0);
        const delayedTrains = [...trains]
          .filter((train) => train.delaySeconds >= 300)
          .sort((left, right) => right.delaySeconds - left.delaySeconds);
        const degradedPower = powerSections.filter(
          (section) => section.status !== "energized",
        );
        const reliefRisks = drivers.filter((driver) => driver.status === "relief-risk");
        const passengerObservations = (snapshot.passengerFeed?.observations ?? []).filter(
          (observation) => !line || observation.lineId === line,
        );
        const delayedPassengerCalls = passengerObservations
          .filter((observation) => (observation.delaySeconds ?? 0) >= 300)
          .sort((left, right) => (right.delaySeconds ?? 0) - (left.delaySeconds ?? 0));

        type BriefPriority = {
          score: number;
          category: "passenger-information" | "incident" | "traffic" | "crew" | "power" | "planned-work";
          severity: "low" | "medium" | "high" | "critical";
          title: string;
          reference: string;
          lineIds: LineId[];
          evidence: string;
          suggestedTool: string;
          suggestedInput: Record<string, string>;
        };

        const severityScore = {
          low: 100,
          medium: 200,
          high: 300,
          critical: 400,
        } as const;
        const priorities: BriefPriority[] = [];

        if (delayedPassengerCalls.length > 0) {
          const focusCall = delayedPassengerCalls[0];
          priorities.push({
            score: delayedPassengerCalls.length > 1 ? 275 : 185,
            category: "passenger-information",
            severity: delayedPassengerCalls.length > 1 ? "high" : "medium",
            title: "Passenger estimated-call delay signal",
            reference: focusCall.journeyRef,
            lineIds: [...new Set(delayedPassengerCalls.map((observation) => observation.lineId))],
            evidence: boundedText(
              `${delayedPassengerCalls.length} delayed estimated call${delayedPassengerCalls.length === 1 ? "" : "s"} · maximum ${focusCall.delaySeconds ?? 0}s · ${snapshot.passengerFeed?.mode ?? "unknown source"}`,
            ),
            suggestedTool: "inspect_prim_feed",
            suggestedInput: { line: focusCall.lineId },
          });
        }

        for (const incident of operationalIncidents) {
          const affectedTrains = trains.filter((train) =>
            incident.impactedTrainIds.includes(train.id)
          );
          const affectedPassengers = affectedTrains.reduce(
            (total, train) => total + train.passengers,
            0,
          );
          priorities.push({
            score: severityScore[incident.severity] + Math.min(affectedPassengers / 10_000, 0.9),
            category: "incident",
            severity: incident.severity,
            title: boundedText(incident.title),
            reference: incident.id,
            lineIds: incident.lineIds,
            evidence: boundedText(
              `${affectedTrains.length} affected train${affectedTrains.length === 1 ? "" : "s"} · ${affectedPassengers} passengers on those trains · ${incident.location}`,
            ),
            suggestedTool: "list_operational_incidents",
            suggestedInput: { status: incident.status },
          });
        }

        if (delayedTrains.length > 0) {
          const focusTrain = delayedTrains[0];
          priorities.push({
            score: delayedTrains.length > 1 ? 290 : 190,
            category: "traffic",
            severity: delayedTrains.length > 1 ? "high" : "medium",
            title: "Delay propagation risk",
            reference: focusTrain.circulationId,
            lineIds: [...new Set(delayedTrains.map((train) => train.lineId))],
            evidence: boundedText(
              `${delayedTrains.length} train${delayedTrains.length === 1 ? "" : "s"} above 5 minutes · worst delay ${Math.floor(focusTrain.delaySeconds / 60)}m ${focusTrain.delaySeconds % 60}s`,
            ),
            suggestedTool: "get_circulation",
            suggestedInput: { trainId: focusTrain.circulationId },
          });
        }

        if (degradedPower.length > 0) {
          priorities.push({
            score: degradedPower.some((section) => section.status === "isolated") ? 310 : 230,
            category: "power",
            severity: degradedPower.some((section) => section.status === "isolated")
              ? "high"
              : "medium",
            title: "Traction power constraint",
            reference: degradedPower[0].id,
            lineIds: [...new Set(degradedPower.flatMap((section) => section.lineIds))],
            evidence: boundedText(
              `${degradedPower.length} degraded or isolated section${degradedPower.length === 1 ? "" : "s"} · peak load ${Math.max(...degradedPower.map((section) => section.loadPercent))}%`,
            ),
            suggestedTool: "inspect_network_state",
            suggestedInput: degradedPower[0].lineIds[0]
              ? { line: degradedPower[0].lineIds[0] }
              : {},
          });
        }

        if (reliefRisks.length > 0) {
          priorities.push({
            score: 220,
            category: "crew",
            severity: "medium",
            title: "Driver relief continuity risk",
            reference: `${reliefRisks.length}-relief-risks`,
            lineIds: [...new Set(reliefRisks.flatMap((driver) => driver.qualifications))],
            evidence: `${reliefRisks.length} pseudonymous driver capacity token${reliefRisks.length === 1 ? "" : "s"} require relief review`,
            suggestedTool: "inspect_j1_capacity",
            suggestedInput: reliefRisks[0].qualifications[0]
              ? { line: reliefRisks[0].qualifications[0] }
              : {},
          });
        }

        for (const incident of plannedIncidents) {
          priorities.push({
            score: 110,
            category: "planned-work",
            severity: incident.severity,
            title: boundedText(incident.title),
            reference: incident.id,
            lineIds: incident.lineIds,
            evidence: boundedText(
              `${incident.location} · starts ${new Date(incident.startedAt).toISOString()}`,
            ),
            suggestedTool: "inspect_schedule_plan",
            suggestedInput: {},
          });
        }

        priorities.sort(
          (left, right) => right.score - left.score || left.reference.localeCompare(right.reference),
        );

        let scheduleContext: Record<string, unknown>;
        try {
          const plan = dependencies.schedules.currentPlan();
          const scopedServices = line
            ? plan.services.filter((service) => service.lineId === line)
            : plan.services;
          const workspace = dependencies.schedules.getSnapshot();
          scheduleContext = {
            status: "loaded",
            name: boundedText(plan.name),
            serviceDate: plan.serviceDate,
            planHash: dependencies.schedules.currentHash(),
            serviceCount: scopedServices.length,
            reviewState: workspace.pendingImpact
              ? "impact_evaluated"
              : workspace.pendingPreview
                ? "preview_ready"
                : "no_pending_change",
            humanAuthorizationActive: Boolean(
              workspace.authorizedPreviewId && workspace.authorizedImpactId,
            ),
          };
        } catch {
          scheduleContext = { status: "not_loaded" };
        }

        const topLine = line
          ?? priorities.flatMap((priority) => priority.lineIds)[0]
          ?? delayedTrains[0]?.lineId
          ?? trains[0]?.lineId
          ?? "RER_B";
        const focusTrain = delayedTrains[0] ?? trains[0];

        return {
          status: "brief_ready",
          evidence: {
            source: snapshot.source,
            scenario: snapshot.scenarioName,
            revision: snapshot.revision,
            decisionRevision: snapshot.decisionRevision,
            timestamp: snapshot.timestamp,
            scopeLine: line ?? "ALL",
            passengerFeed: snapshot.passengerFeed ? {
              mode: snapshot.passengerFeed.mode,
              status: snapshot.passengerFeed.status,
              provider: snapshot.passengerFeed.provider,
              contract: snapshot.passengerFeed.contract,
              receivedAt: snapshot.passengerFeed.receivedAt,
              observations: snapshot.passengerFeed.observations.filter(
                (observation) => !line || observation.lineId === line,
              ).length,
              lineCoverage: snapshot.passengerFeed.lines
                .filter((item) => !line || item.lineId === line)
                .map((item) => ({
                  lineId: item.lineId,
                  lineRef: item.lineRef,
                  status: item.status,
                  responseTimestamp: item.responseTimestamp,
                })),
            } : null,
            freshness: "Exact current browser revision. Passenger evidence carries its own connector and upstream timestamps; simulated layers use the scenario clock.",
          },
          operationalPicture: {
            trainsInScope: trains.length,
            delayedOverFiveMinutes: delayedTrains.length,
            operationalIncidents: operationalIncidents.length,
            plannedWorksOrEvents: plannedIncidents.length,
            passengersOnAffectedTrains,
            passengerFeedEstimatedCalls: passengerObservations.length,
            passengerFeedDelayedCalls: delayedPassengerCalls.length,
            blockedTrackCircuits: circuits.filter((circuit) => circuit.state === "blocked").length,
            degradedOrIsolatedPowerSections: degradedPower.length,
            driverReliefRisks: reliefRisks.length,
          },
          priorities: priorities.slice(0, 6).map(({ score: _score, ...priority }, index) => ({
            rank: index + 1,
            ...priority,
          })),
          schedule: scheduleContext,
          recommendedWorkflow: [
            {
              order: 1,
              phase: "observe",
              tool: "inspect_prim_feed",
              input: { line: topLine },
              purpose: "Establish passenger-feed provenance, freshness, coverage and limitations first.",
            },
            {
              order: 2,
              phase: "observe",
              tool: "inspect_network_state",
              input: { line: topLine },
              purpose: "Confirm the highest-risk line in the separate ICC simulation snapshot.",
            },
            ...(focusTrain
              ? [{
                  order: 3,
                  phase: "observe",
                  tool: "get_circulation",
                  input: { trainId: focusTrain.circulationId },
                  purpose: "Inspect the most delayed circulation and its occupied circuit.",
                }]
              : []),
            {
              order: 4,
              phase: "observe",
              tool: "inspect_j1_capacity",
              input: { line: topLine },
              purpose: "Check aggregate driver coverage without exposing personal data.",
            },
            {
              order: 5,
              phase: "simulate",
              tool: "preview_schedule_change",
              purpose: "Prepare one bounded versioned change without committing it.",
            },
            {
              order: 6,
              phase: "simulate",
              tool: "evaluate_schedule_impact",
              purpose: "Compare passenger, crew, incident, track and power effects.",
            },
            {
              order: 7,
              phase: "approve-and-verify",
              tool: "apply_reviewed_schedule_change",
              purpose: "Use only after visible one-use human authorization; verify the receipt.",
            },
          ],
          guardrails: {
            simulationOnly: snapshot.source === "simulation",
            readOnly: true,
            humanApprovalRequiredForWrites: true,
            liveSignallingAvailable: false,
            passengerEvidenceReadOnly: true,
            statement: "Decision support only. No signalling, interlocking, traction or staff command is exposed.",
          },
        };
      },
    },
    {
      name: "inspect_network_state",
      description: "Read a bounded operational summary of the simulated Paris metro and RER network, including telemetry revision and the stable decision revision required by guarded writes. Does not command railway systems.",
      inputSchema: { type: "object", properties: { line: { type: "string", enum: LINE_IDS } }, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput) => {
        const input = inputRecord(rawInput); allowOnly(input, ["line"]); const line = optionalLine(input);
        const snapshot = getSnapshot();
        const trains = line ? snapshot.trains.filter((train) => train.lineId === line) : snapshot.trains;
        const circuits = line ? snapshot.circuits.filter((circuit) => circuit.lineId === line) : snapshot.circuits;
        const powerSections = line
          ? snapshot.powerSections.filter((section) => section.lineIds.includes(line))
          : snapshot.powerSections;
        return {
          status: "ok",
          source: snapshot.source,
          scenario: snapshot.scenarioName,
          revision: snapshot.revision,
          decisionRevision: snapshot.decisionRevision,
          writeGuard: {
            expectedRevision: snapshot.decisionRevision,
            basis: "decision_revision",
            stableAcrossTelemetryTicks: true,
          },
          timestamp: snapshot.timestamp,
          line: line ?? "ALL",
          trains: trains.length,
          moving: trains.filter((train) => train.status === "running").length,
          delayedOverFiveMinutes: trains.filter((train) => train.delaySeconds >= 300).length,
          occupiedTrackCircuits: circuits.filter((circuit) => circuit.state === "occupied").length,
          blockedTrackCircuits: circuits.filter((circuit) => circuit.state === "blocked").length,
          powerSections: powerSections.length,
          degradedPowerSections: powerSections.filter((section) => section.status === "degraded").length,
          isolatedPowerSections: powerSections.filter((section) => section.status === "isolated").length,
          activeIncidents: snapshot.incidents.filter((incident) => incident.status === "active" && (!line || incident.lineIds.includes(line))).map((incident) => ({ id: incident.id, title: incident.title, severity: incident.severity, location: incident.location })),
          safety: "Synthetic read-only operational data. No signalling or traction command is available.",
        };
      },
    },
    {
      name: "get_circulation",
      description: "Read one simulated train circulation, its current track circuit, delay, next stop and pseudonymous driver token.",
      inputSchema: { type: "object", properties: { trainId: { type: "string", maxLength: 80 } }, required: ["trainId"], additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: (rawInput) => {
        const input = inputRecord(rawInput); allowOnly(input, ["trainId"]); const trainId = requiredString(input, "trainId");
        const snapshot = getSnapshot(); const train = snapshot.trains.find((candidate) => candidate.id === trainId || candidate.circulationId === trainId);
        if (!train) return { status: "not_found", trainId };
        const circuit = snapshot.circuits.find((candidate) => candidate.id === train.circuitId);
        return {
          status: "ok",
          revision: snapshot.revision,
          decisionRevision: snapshot.decisionRevision,
          train: { ...train, circuitState: circuit?.state ?? "unknown" },
          privacy: "driverId is a synthetic pseudonymous resource token.",
        };
      },
    },
    {
      name: "inspect_j1_capacity",
      description: "Read aggregate D-1 driver capacity by line and status. Individual employee identities, absence reasons and strike declarations are never returned.",
      inputSchema: { type: "object", properties: { line: { type: "string", enum: LINE_IDS } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: (rawInput) => {
        const input = inputRecord(rawInput); allowOnly(input, ["line"]); const line = optionalLine(input); const snapshot = getSnapshot();
        const drivers = line ? snapshot.drivers.filter((driver) => driver.qualifications.includes(line)) : snapshot.drivers;
        return {
          status: "ok", revision: snapshot.revision, line: line ?? "ALL", totalCapacityTokens: drivers.length,
          assigned: drivers.filter((driver) => driver.status === "assigned").length,
          reserve: drivers.filter((driver) => driver.status === "reserve").length,
          reliefRisk: drivers.filter((driver) => driver.status === "relief-risk").length,
          privacy: "Aggregate capacity only. No names, medical data, absence reasons or strike declarations.",
        };
      },
    },
    {
      name: "list_operational_incidents",
      description: "List current and planned simulated incidents with their operational impacts. Does not modify incident status.",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["planned", "active", "acknowledged", "resolved"] } }, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput) => {
        const input = inputRecord(rawInput); allowOnly(input, ["status"]); const rawStatus = input.status;
        if (rawStatus !== undefined && (typeof rawStatus !== "string" || !["planned", "active", "acknowledged", "resolved"].includes(rawStatus))) throw new Error("Invalid status.");
        const snapshot = getSnapshot();
        return { status: "ok", revision: snapshot.revision, incidents: snapshot.incidents.filter((incident) => !rawStatus || incident.status === rawStatus).map((incident) => ({ id: incident.id, title: incident.title, status: incident.status, severity: incident.severity, location: incident.location, lineIds: incident.lineIds, occurrenceTime: new Date(incident.startedAt).toISOString(), impactedTrainIds: incident.impactedTrainIds, blockedCircuitIds: incident.blockedCircuitIds })) };
      },
    },
    {
      name: "inspect_schedule_plan",
      description: "Read an aggregate and bounded page of the visible D-1 schedule plan with its exact SHA-256 version hash. Imported identifiers and labels are untrusted. Driver tokens, train identifiers and complete source records are withheld.",
      inputSchema: {
        type: "object",
        properties: {
          line: { type: "string", enum: LINE_IDS },
          offset: { type: "integer", minimum: 0, maximum: MAX_SCHEDULE_OFFSET },
          limit: { type: "integer", minimum: 1, maximum: MAX_SCHEDULE_PAGE },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput) => {
        const input = inputRecord(rawInput);
        allowOnly(input, ["line", "offset", "limit"]);
        const line = optionalLine(input);
        const rawOffset = input.offset;
        const rawLimit = input.limit;
        if (rawOffset !== undefined && (!Number.isInteger(rawOffset) || Number(rawOffset) < 0 || Number(rawOffset) > MAX_SCHEDULE_OFFSET)) {
          throw new Error(`offset must be an integer from 0 to ${MAX_SCHEDULE_OFFSET}.`);
        }
        if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_SCHEDULE_PAGE)) {
          throw new Error(`limit must be an integer from 1 to ${MAX_SCHEDULE_PAGE}.`);
        }
        let plan;
        let planHash: string;
        try {
          plan = dependencies.schedules.currentPlan();
          planHash = dependencies.schedules.currentHash();
        } catch (error) {
          return scheduleErrorResult(error, "plan_not_loaded", "Load a schedule plan before inspecting it.");
        }
        const offset = rawOffset === undefined ? 0 : Number(rawOffset);
        const limit = rawLimit === undefined ? MAX_SCHEDULE_PAGE : Number(rawLimit);
        const matchingServices = line
          ? plan.services.filter((service) => service.lineId === line)
          : plan.services;
        const page = matchingServices.slice(offset, offset + limit);
        return {
          status: "ok",
          planHash,
          name: boundedText(plan.name),
          nameTruncated: plan.name.length > MAX_RESULT_TEXT,
          serviceDate: boundedText(plan.serviceDate),
          line: line ?? "ALL",
          totalServices: plan.services.length,
          operatingServices: plan.services.filter((service) => service.status === "scheduled").length,
          cancelledServices: plan.services.filter((service) => service.status === "cancelled").length,
          servicesWithDriver: plan.services.filter((service) => service.status === "scheduled" && service.driverToken !== null).length,
          matchingServices: matchingServices.length,
          offset,
          returned: page.length,
          nextOffset: offset + page.length < matchingServices.length ? offset + page.length : null,
          services: page.map((service) => ({
            serviceId: boundedText(service.serviceId),
            lineId: service.lineId,
            departureMinutes: service.departureMinutes,
            arrivalMinutes: service.arrivalMinutes,
            track: boundedText(service.track),
            status: service.status,
            driverAssigned: service.driverToken !== null,
          })),
          resourceTokensRedacted: true,
          privacy: "Driver tokens, train identifiers, origins, destinations and complete source rows are omitted from this bounded response.",
        };
      },
    },
    {
      name: "preview_schedule_change",
      description: "STAGE: Prepare one deterministic, non-committed schedule change against the exact visible plan hash. The result contains redacted change locations only; impact evaluation and trusted human approval are still required.",
      inputSchema: {
        type: "object",
        properties: {
          expectedHash: { type: "string", pattern: SCHEDULE_HASH_PATTERN },
          kind: { type: "string", enum: SCHEDULE_CHANGE_KINDS },
          serviceId: { type: "string", maxLength: 80 },
          deltaMinutes: { type: "integer", minimum: -15, maximum: 15 },
          driverToken: { type: ["string", "null"], maxLength: 80 },
          track: { type: "string", maxLength: 20, pattern: TRACK_TOKEN_PATTERN },
        },
        required: ["expectedHash", "kind", "serviceId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, options) => {
        const input = inputRecord(rawInput);
        if (options?.signal?.aborted) throw new Error("Schedule preview was cancelled.");
        const expectedHash = requiredPatternString(input, "expectedHash", SCHEDULE_HASH, "an exact schedule SHA-256 hash");
        const stale = staleScheduleHash(dependencies.schedules, expectedHash);
        if (stale) return stale;
        let request: ScheduleChangeRequest;
        try {
          request = scheduleChangeRequest(input);
        } catch (error) {
          return blocked("invalid_request", error instanceof Error ? error.message : "The schedule change is invalid.");
        }
        let preview;
        try {
          preview = await dependencies.schedules.preview(request, getSnapshot(), "agent");
        } catch (error) {
          return scheduleErrorResult(error);
        }
        const secrets = request.kind === "reassign_driver" && request.driverToken
          ? [request.driverToken]
          : [];
        return {
          status: "preview_ready",
          previewId: preview.id,
          expectedHash: preview.beforeHash,
          projectedHash: preview.afterHash,
          contextHash: preview.contextHash,
          operation: preview.request.kind,
          summary: boundedText(preview.summary, secrets),
          changeCount: preview.changes.length,
          affectedServiceCount: preview.affectedServiceIds.length,
          affectedServiceIds: boundedStrings(preview.affectedServiceIds, secrets),
          affectedServiceIdsTruncated: preview.affectedServiceIds.length > MAX_RESULT_ITEMS,
          warnings: boundedStrings(preview.warnings, secrets),
          warningsTruncated: preview.warnings.length > MAX_RESULT_ITEMS,
          sampleChangeLocations: preview.changes.slice(0, MAX_RESULT_ITEMS).map((change) => ({
            serviceId: boundedText(change.serviceId, secrets),
            field: change.field,
          })),
          sampleTruncated: preview.changes.length > MAX_RESULT_ITEMS,
          valuesRedacted: true,
          impactEvaluationRequired: true,
          humanApprovalRequired: true,
          simulationOnly: true,
          nextStep: "Evaluate this exact preview, then ask the user to inspect the visible impact and authorize the exact preview and impact. Do not claim that the plan changed.",
        };
      },
    },
    {
      name: "evaluate_schedule_impact",
      description: "STAGE: Evaluate passenger, coverage, resource, incident, track and power impacts for the exact pending schedule preview. Stores no committed plan change and returns bounded, resource-redacted evidence.",
      inputSchema: {
        type: "object",
        properties: {
          expectedHash: { type: "string", pattern: SCHEDULE_HASH_PATTERN },
          previewId: { type: "string", pattern: PREVIEW_ID_PATTERN },
        },
        required: ["expectedHash", "previewId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, options) => {
        const input = inputRecord(rawInput);
        allowOnly(input, ["expectedHash", "previewId"]);
        if (options?.signal?.aborted) throw new Error("Schedule impact evaluation was cancelled.");
        const expectedHash = requiredPatternString(input, "expectedHash", SCHEDULE_HASH, "an exact schedule SHA-256 hash");
        const previewId = requiredPatternString(input, "previewId", PREVIEW_ID, "a valid preview identifier");
        const stale = staleScheduleHash(dependencies.schedules, expectedHash);
        if (stale) return stale;
        let impact: ImpactEvaluation;
        try {
          impact = await dependencies.schedules.evaluatePreview(previewId, getSnapshot());
        } catch (error) {
          return scheduleErrorResult(error);
        }
        const secrets = impactSecrets(impact);
        const hardConflicts = impact.conflicts.filter((conflict) => conflict.severity === "hard");
        const warningConflicts = impact.conflicts.filter((conflict) => conflict.severity === "warning");
        const conflictKinds = [...new Set(impact.conflicts.map((conflict) => conflict.kind))];
        return {
          status: "impact_evaluated",
          impactId: impact.id,
          previewId: impact.previewId,
          expectedHash: impact.beforeHash,
          projectedHash: impact.afterHash,
          contextHash: impact.contextHash,
          score: impact.score,
          assessment: impact.assessment,
          summary: boundedText(impact.summary, secrets),
          baseline: {
            coveragePercent: impact.baselineCoverage.percent,
            conflictCount: impact.baselineConflicts.length,
          },
          projected: {
            coveragePercent: impact.coverage.percent,
            totalServices: impact.coverage.totalServices,
            operatingServices: impact.coverage.operatingServices,
            coveredServices: impact.coverage.coveredServices,
            uncoveredServiceCount: impact.coverage.uncoveredServiceIds.length,
            uncoveredServiceIds: boundedStrings(impact.coverage.uncoveredServiceIds, secrets),
            uncoveredServiceIdsTruncated: impact.coverage.uncoveredServiceIds.length > MAX_RESULT_ITEMS,
          },
          conflicts: {
            total: impact.conflicts.length,
            hard: hardConflicts.length,
            warnings: warningConflicts.length,
            kinds: conflictKinds,
            sample: impact.conflicts.slice(0, MAX_RESULT_ITEMS).map((conflict) => ({
              id: boundedText(conflict.id, secrets),
              kind: conflict.kind,
              severity: conflict.severity,
              serviceIds: boundedStrings(conflict.serviceIds, secrets).slice(0, 4),
              detailsRedacted: conflict.resourceId !== undefined,
            })),
            sampleTruncated: impact.conflicts.length > MAX_RESULT_ITEMS,
          },
          passengersAffected: impact.passengersAffected,
          passengerDelayMinutes: impact.passengerDelayMinutes,
          incidentExposure: {
            serviceCount: impact.incidentExposure.serviceCount,
            incidentCount: impact.incidentExposure.incidentIds.length,
            serviceIds: boundedStrings(impact.incidentExposure.serviceIds, secrets),
            serviceIdsTruncated: impact.incidentExposure.serviceIds.length > MAX_RESULT_ITEMS,
          },
          powerExposure: {
            serviceCount: impact.powerExposure.serviceCount,
            isolatedServiceCount: impact.powerExposure.isolatedServiceIds.length,
            serviceIds: boundedStrings(impact.powerExposure.serviceIds, secrets),
            serviceIdsTruncated: impact.powerExposure.serviceIds.length > MAX_RESULT_ITEMS,
          },
          hardBlockCount: impact.hardBlocks.length,
          hardBlocks: boundedStrings(impact.hardBlocks, secrets),
          hardBlocksTruncated: impact.hardBlocks.length > MAX_RESULT_ITEMS,
          warnings: boundedStrings(impact.warnings, secrets),
          warningsTruncated: impact.warnings.length > MAX_RESULT_ITEMS,
          canAuthorize: impact.hardBlocks.length === 0,
          humanApprovalRequired: true,
          resourceTokensRedacted: true,
          simulationOnly: true,
          nextStep: impact.hardBlocks.length > 0
            ? "This preview introduces hard policy violations and cannot be applied. Prepare a different preview."
            : "Ask the user to inspect this visible impact and authorize the exact preview and impact pair before applying.",
        };
      },
    },
    {
      name: "apply_reviewed_schedule_change",
      description: "WRITE: Commit exactly the pending, impact-evaluated schedule preview to local simulation memory. It accepts no new operation, requires the exact plan hash plus preview and impact IDs, and consumes one trusted human authorization from the visible UI.",
      inputSchema: {
        type: "object",
        properties: {
          expectedHash: { type: "string", pattern: SCHEDULE_HASH_PATTERN },
          previewId: { type: "string", pattern: PREVIEW_ID_PATTERN },
          impactId: { type: "string", pattern: IMPACT_ID_PATTERN },
        },
        required: ["expectedHash", "previewId", "impactId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: (rawInput, options) => {
        const input = inputRecord(rawInput);
        allowOnly(input, ["expectedHash", "previewId", "impactId"]);
        if (options?.signal?.aborted) throw new Error("Schedule commit was cancelled.");
        const expectedHash = requiredPatternString(input, "expectedHash", SCHEDULE_HASH, "an exact schedule SHA-256 hash");
        const previewId = requiredPatternString(input, "previewId", PREVIEW_ID, "a valid preview identifier");
        const impactId = requiredPatternString(input, "impactId", IMPACT_ID, "a valid impact identifier");
        const stale = staleScheduleHash(dependencies.schedules, expectedHash);
        if (stale) return stale;
        const railSnapshot = getSnapshot();
        if (railSnapshot.source !== "simulation") {
          return blocked("live_forbidden", "Agent schedule commits are available in the local simulation only.");
        }
        const workspace = dependencies.schedules.getSnapshot();
        if (!workspace.pendingPreview || workspace.pendingPreview.id !== previewId) {
          return blocked("preview_stale", "The reviewed schedule preview is missing or stale. Create a new preview.");
        }
        if (!workspace.pendingImpact) {
          return blocked("impact_required", "Evaluate the pending preview before requesting a schedule commit.");
        }
        if (workspace.pendingImpact.id !== impactId || workspace.pendingImpact.previewId !== previewId) {
          return blocked("impact_stale", "The reviewed impact does not match the pending preview. Evaluate it again.");
        }
        const requestedDriverToken = workspace.pendingPreview.request.kind === "reassign_driver"
          ? workspace.pendingPreview.request.driverToken
          : null;
        const secrets = [
          ...impactSecrets(workspace.pendingImpact),
          ...(requestedDriverToken ? [requestedDriverToken] : []),
        ];
        if (workspace.pendingImpact.hardBlocks.length > 0) {
          return blocked(
            "impact_hard_block",
            "The evaluated change introduces hard policy violations and cannot be committed.",
            {
              hardBlockCount: workspace.pendingImpact.hardBlocks.length,
              hardBlocks: boundedStrings(workspace.pendingImpact.hardBlocks, secrets),
              hardBlocksTruncated: workspace.pendingImpact.hardBlocks.length > MAX_RESULT_ITEMS,
            },
          );
        }
        if (workspace.authorizedPreviewId !== previewId || workspace.authorizedImpactId !== impactId) {
          return blocked(
            "human_approval_required",
            "Ask the user to inspect the visible preview and impact, then activate the one-use authorization.",
          );
        }
        if (options?.signal?.aborted) throw new Error("Schedule commit was cancelled.");
        return Promise.resolve()
          .then(() => dependencies.schedules.commitPreview(
            previewId,
            impactId,
            "agent",
            railSnapshot,
          ))
          .then((receipt) => ({
          status: "committed_to_simulation",
          receiptId: receipt.id,
          previewId: receipt.previewId,
          impactId: receipt.impactId,
          previousHash: receipt.beforeHash,
          planHash: receipt.afterHash,
          summary: boundedText(receipt.summary, secrets),
          score: receipt.score,
          assessment: receipt.assessment,
          affectedServiceCount: receipt.changedServiceIds.length,
          affectedServiceIds: boundedStrings(receipt.changedServiceIds, secrets),
          affectedServiceIdsTruncated: receipt.changedServiceIds.length > MAX_RESULT_ITEMS,
          resourceTokensRedacted: true,
          authorizationConsumed: true,
          simulationOnly: true,
          safety: "Only the local versioned simulation plan changed. No live railway, publication or staff system was contacted.",
        }))
          .catch((error: unknown) => scheduleErrorResult(error));
      },
    },
    {
      name: "simulate_track_circuit_closure",
      description: "SIMULATION WRITE: Close or reopen one track circuit in the local deterministic simulation. Requires the stable decisionRevision returned by a current read as expectedRevision, plus explicit simulation confirmation. Telemetry ticks do not invalidate this guard; operator decisions do. Closing an occupied circuit and every live railway command are forbidden.",
      inputSchema: {
        type: "object",
        properties: {
          circuitId: {
            type: "string",
            pattern: CIRCUIT_ID_PATTERN,
            maxLength: 80,
          },
          action: { type: "string", enum: CIRCUIT_CLOSURE_ACTIONS },
          reason: { type: "string", enum: CIRCUIT_CLOSURE_REASONS },
          note: { type: "string", maxLength: MAX_CIRCUIT_CLOSURE_NOTE_LENGTH },
          expectedRevision: {
            type: "integer",
            minimum: 1,
            description: "Exact decisionRevision returned by the current read context.",
          },
          confirmSimulation: { type: "boolean", const: true },
        },
        required: ["circuitId", "action", "expectedRevision", "confirmSimulation"],
        additionalProperties: false,
        oneOf: [
          {
            properties: { action: { const: "close" } },
            required: ["reason"],
          },
          {
            properties: { action: { const: "reopen" } },
            not: {
              anyOf: [
                { required: ["reason"] },
                { required: ["note"] },
              ],
            },
          },
        ],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (rawInput, options) => {
        const input = inputRecord(rawInput);
        if (options?.signal?.aborted) throw new Error("Track-circuit action was cancelled.");
        const circuitId = requiredPatternString(
          input,
          "circuitId",
          CIRCUIT_ID,
          "a valid track-circuit identifier",
        );
        const rawAction = requiredString(input, "action");
        if (!CIRCUIT_CLOSURE_ACTIONS.includes(rawAction as typeof CIRCUIT_CLOSURE_ACTIONS[number])) {
          throw new Error(`action must be one of ${CIRCUIT_CLOSURE_ACTIONS.join(", ")}.`);
        }
        const action = rawAction as typeof CIRCUIT_CLOSURE_ACTIONS[number];
        let command: CircuitClosureCommand;
        if (action === "close") {
          allowOnly(input, ["circuitId", "action", "reason", "note", "expectedRevision", "confirmSimulation"]);
          const rawReason = requiredString(input, "reason");
          if (!CIRCUIT_CLOSURE_REASONS.includes(rawReason as typeof CIRCUIT_CLOSURE_REASONS[number])) {
            throw new Error(`reason must be one of ${CIRCUIT_CLOSURE_REASONS.join(", ")}.`);
          }
          const note = input.note;
          if (
            note !== undefined &&
            (typeof note !== "string" || note.length > MAX_CIRCUIT_CLOSURE_NOTE_LENGTH)
          ) {
            throw new Error(
              `note must be a string of at most ${MAX_CIRCUIT_CLOSURE_NOTE_LENGTH} characters.`,
            );
          }
          command = {
            kind: "close",
            reason: rawReason as typeof CIRCUIT_CLOSURE_REASONS[number],
            note: typeof note === "string" ? note.trim() : "",
          };
        } else {
          allowOnly(input, ["circuitId", "action", "expectedRevision", "confirmSimulation"]);
          command = { kind: "reopen" };
        }
        if (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
          throw new Error("expectedRevision must be a positive integer.");
        }
        if (input.confirmSimulation !== true) {
          return blocked(
            "simulation_confirmation_required",
            "Explicitly confirm that this action targets the local simulation only.",
          );
        }
        const snapshot = getSnapshot();
        if (snapshot.source !== "simulation") {
          return blocked(
            "live_forbidden",
            "Track-circuit commands are forbidden when the current data source is live.",
            { circuitId, action, simulationOnly: true },
          );
        }
        if (snapshot.decisionRevision !== input.expectedRevision) {
          return blocked(
            "stale_snapshot",
            "The operator decision context changed. Inspect it again before continuing.",
            {
              circuitId,
              action,
              expectedRevision: input.expectedRevision,
              currentRevision: snapshot.decisionRevision,
              currentDecisionRevision: snapshot.decisionRevision,
              telemetryRevision: snapshot.revision,
              simulationOnly: true,
            },
          );
        }
        const circuit = snapshot.circuits.find((candidate) => candidate.id === circuitId);
        if (!circuit) {
          return {
            status: "not_found",
            reason: "not_found",
            circuitId,
            action,
            basedOnRevision: snapshot.decisionRevision,
            basedOnDecisionRevision: snapshot.decisionRevision,
            telemetryRevision: snapshot.revision,
            simulationOnly: true,
            message: "The requested track circuit does not exist in this simulation.",
          };
        }
        if (action === "close" && circuit.state === "occupied") {
          return blocked(
            "occupied",
            "An occupied track circuit cannot be closed.",
            {
              circuitId,
              action,
              currentState: circuit.state,
              basedOnRevision: snapshot.decisionRevision,
              basedOnDecisionRevision: snapshot.decisionRevision,
              telemetryRevision: snapshot.revision,
              simulationOnly: true,
            },
          );
        }
        if (action === "reopen" && circuit.state !== "blocked") {
          return blocked(
            "already_open",
            "This track circuit is not closed.",
            {
              circuitId,
              action,
              currentState: circuit.state,
              basedOnRevision: snapshot.decisionRevision,
              basedOnDecisionRevision: snapshot.decisionRevision,
              telemetryRevision: snapshot.revision,
              simulationOnly: true,
            },
          );
        }
        if (options?.signal?.aborted) throw new Error("Track-circuit action was cancelled.");
        return Promise.resolve(dependencies.setCircuitClosure(circuitId, command)).then((result) => {
        if (!result.ok) {
          return {
            status: result.reason === "not_found" ? "not_found" : "blocked",
            reason: result.reason,
            circuitId,
            action,
            currentState: circuit.state,
            basedOnRevision: snapshot.decisionRevision,
            basedOnDecisionRevision: snapshot.decisionRevision,
            telemetryRevision: snapshot.revision,
            simulationOnly: true,
            message: boundedText(result.message),
          };
        }
        return {
          status: "applied_to_simulation",
          circuitId,
          action,
          outcome: result.outcome,
          basedOnRevision: snapshot.decisionRevision,
          basedOnDecisionRevision: snapshot.decisionRevision,
          telemetryRevision: snapshot.revision,
          ...(command.kind === "close"
            ? {
                closureReason: command.reason,
                noteAccepted: command.note.length > 0,
              }
            : {}),
          message: boundedText(result.message),
          simulationOnly: true,
          safety: "Only the local deterministic simulation changed. No signalling, interlocking or live railway system was contacted.",
        };
        });
      },
    },
    {
      name: "simulate_regulation_action",
      description: "Apply a guarded regulation action to the local simulation only. Requires the stable decisionRevision returned by a current read as expectedRevision, plus explicit simulation confirmation. Telemetry ticks do not invalidate this guard; operator decisions do. Actions are logged; no live railway system is commanded.",
      inputSchema: {
        type: "object",
        properties: {
          trainId: { type: "string", maxLength: 80 },
          action: { type: "string", enum: REGULATION_ACTIONS },
          expectedRevision: {
            type: "integer",
            minimum: 1,
            description: "Exact decisionRevision returned by the current read context.",
          },
          confirmSimulation: { type: "boolean", const: true },
        },
        required: ["trainId", "action", "expectedRevision", "confirmSimulation"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (rawInput, options) => {
        if (options?.signal?.aborted) return blocked("request_aborted", "The request was cancelled before any simulation change.");
        const input = inputRecord(rawInput); allowOnly(input, ["trainId", "action", "expectedRevision", "confirmSimulation"]);
        const trainId = requiredString(input, "trainId"); const action = requiredString(input, "action");
        if (!REGULATION_ACTIONS.includes(action as typeof REGULATION_ACTIONS[number])) throw new Error("Invalid regulation action.");
        if (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw new Error("expectedRevision must be a positive integer.");
        if (input.confirmSimulation !== true) return { status: "blocked", reason: "simulation_confirmation_required" };
        const snapshot = getSnapshot();
        if (snapshot.source !== "simulation") return { status: "blocked", reason: "live_commands_forbidden" };
        if (snapshot.decisionRevision !== input.expectedRevision) {
          return {
            status: "blocked",
            reason: "stale_snapshot",
            expectedRevision: input.expectedRevision,
            currentRevision: snapshot.decisionRevision,
            currentDecisionRevision: snapshot.decisionRevision,
            telemetryRevision: snapshot.revision,
          };
        }
        const train = snapshot.trains.find((candidate) => candidate.id === trainId);
        if (!train) return { status: "not_found", trainId };
        if (action === "turnback") {
          const route = routeFor(train.lineId, train.direction);
          if (train.routeIndex !== route.length - 1 || train.progress < 0.9) {
            return blocked("not_at_turnback_point", "The train is not at a modelled corridor turnback point.", { trainId, action, simulationOnly: true });
          }
          const reverseDirection: 1 | -1 = train.direction === 1 ? -1 : 1;
          const target = routeFor(train.lineId, reverseDirection)[0];
          const targetView = target && snapshot.circuits.find((circuit) => circuit.id === target.id);
          if (!target || !targetView || targetView.state !== "free" || targetView.closure !== null) {
            return blocked("turnback_target_unavailable", "The opposite-direction turnback CDV is unavailable.", { trainId, action, simulationOnly: true });
          }
        }
        if (options?.signal?.aborted) return blocked("request_aborted", "The request was cancelled before any simulation change.");
        const result = await dependencies.regulate(trainId, action as typeof REGULATION_ACTIONS[number]);
        if (result && !result.ok) {
          return blocked("action_rejected", result.message, { trainId, action, simulationOnly: true });
        }
        return {
          status: "applied_to_simulation",
          trainId,
          action,
          basedOnRevision: snapshot.decisionRevision,
          basedOnDecisionRevision: snapshot.decisionRevision,
          telemetryRevision: snapshot.revision,
          safety: "No live system was contacted.",
        };
      },
    },
    ...(dependencies.nativeNetwork
      ? createNativeSimulationTools(dependencies.nativeNetwork)
      : []),
  ];
}
