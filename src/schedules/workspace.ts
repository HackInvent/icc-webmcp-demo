import type { RailSnapshot } from "../rail/domain";
import {
  OperationsClientError,
  OperationsConflictError,
  operationsClient,
  type OperationsClientStore,
} from "../runtime/operationsClient";
import type { OperationsCommandResult } from "../runtime/types";
import { cloneSchedulePlan } from "./csv";
import { hashSchedulePlan } from "./quality";
import { createSampleSchedulePlan } from "./sample";
import { ScheduleWorkspaceStore } from "./store";
import {
  ScheduleWorkspaceError,
  type Actor,
  type ImpactEvaluation,
  type ScheduleChangeRequest,
  type SchedulePlan,
  type SchedulePreview,
  type ScheduleReceipt,
  type ScheduleVersion,
  type ScheduleWorkspace,
  type ScheduleWorkspaceErrorCode,
  type ScheduleWorkspaceState,
} from "./types";

type OperationsPort = Pick<
  OperationsClientStore,
  "getServerSnapshot" | "subscribe" | "command"
>;

const SCHEDULE_ERROR_CODES = new Set<ScheduleWorkspaceErrorCode>([
  "PLAN_NOT_LOADED",
  "PREVIEW_STALE",
  "IMPACT_REQUIRED",
  "IMPACT_STALE",
  "CONTEXT_STALE",
  "AUTHORIZATION_REQUIRED",
  "HARD_BLOCK",
  "LIVE_FORBIDDEN",
  "NO_CHANGES",
  "INVALID_REQUEST",
  "NOTHING_TO_UNDO",
]);

function normalizeScheduleError(error: unknown): Error {
  if (error instanceof ScheduleWorkspaceError) return error;
  if (error instanceof OperationsConflictError) {
    return new ScheduleWorkspaceError(
      "CONTEXT_STALE",
      "The operational state changed while this schedule action was being applied. Review the refreshed state and try again.",
    );
  }
  if (
    error instanceof OperationsClientError &&
    SCHEDULE_ERROR_CODES.has(error.code as ScheduleWorkspaceErrorCode)
  ) {
    return new ScheduleWorkspaceError(
      error.code as ScheduleWorkspaceErrorCode,
      error.message,
    );
  }
  return error instanceof Error
    ? error
    : new Error("The schedule command could not be completed.");
}

/**
 * Server-authoritative schedule facade.
 *
 * Reads always project the schedule state already carried by the operations
 * snapshot. A mutation is sent as one revision-checked command and becomes
 * visible only from the returned/SSE snapshot; no optimistic local state can
 * be overwritten while the command is in flight. The local store remains a
 * deterministic development/test fallback when no operations runtime exists.
 */
export class RuntimeScheduleWorkspace implements ScheduleWorkspace {
  constructor(
    private readonly client: OperationsPort = operationsClient,
    private readonly local: ScheduleWorkspaceStore = new ScheduleWorkspaceStore(
      createSampleSchedulePlan(),
    ),
  ) {}

  private usesServer(): boolean {
    return this.client.getServerSnapshot() !== null;
  }

  private serverStateFrom(
    result?: OperationsCommandResult<unknown>,
  ): ScheduleWorkspaceState | null {
    return result?.snapshot?.schedules ??
      this.client.getServerSnapshot()?.schedules ??
      null;
  }

  private async send<
    TPayload extends Record<string, unknown>,
    TResult = unknown,
  >(
    type: string,
    payload: TPayload,
  ): Promise<OperationsCommandResult<TResult>> {
    try {
      return await this.client.command<TPayload, TResult>(type, payload);
    } catch (error) {
      throw normalizeScheduleError(error);
    }
  }

  getSnapshot = (): ScheduleWorkspaceState =>
    this.client.getServerSnapshot()?.schedules ?? this.local.getSnapshot();

  subscribe = (listener: () => void): (() => void) => {
    const unsubscribeServer = this.client.subscribe(listener);
    const unsubscribeLocal = this.local.subscribe(listener);
    return () => {
      unsubscribeServer();
      unsubscribeLocal();
    };
  };

  currentPlan(): SchedulePlan {
    const state = this.getSnapshot();
    const version = state.versions[state.cursor];
    if (!version) {
      throw new ScheduleWorkspaceError(
        "PLAN_NOT_LOADED",
        "Load a schedule plan first.",
      );
    }
    return cloneSchedulePlan(version.plan);
  }

  currentHash(): string {
    return hashSchedulePlan(this.currentPlan());
  }

  loadPlan(plan: SchedulePlan): ScheduleVersion | Promise<ScheduleVersion> {
    if (!this.usesServer()) return this.local.loadPlan(plan);
    return this.send<Record<string, unknown>, { version: ScheduleVersion }>(
      "load_schedule_plan",
      { plan },
    ).then((response) => {
      const version = response.result?.version ??
        this.serverStateFrom(response)?.versions.at(-1);
      if (!version) throw new Error("The server did not return the imported schedule version.");
      return version;
    });
  }

  preview(
    request: ScheduleChangeRequest,
    snapshot: RailSnapshot,
    actor: Actor = "human",
  ): SchedulePreview | Promise<SchedulePreview> {
    if (!this.usesServer()) return this.local.preview(request, snapshot, actor);
    return this.send<Record<string, unknown>, { preview: SchedulePreview }>(
      "schedule_preview",
      { request, actor },
    ).then((response) => {
      const preview = response.result?.preview ??
        this.serverStateFrom(response)?.pendingPreview;
      if (!preview) throw new Error("The server did not return the schedule preview.");
      return preview;
    });
  }

  evaluatePreview(
    previewId: string,
    snapshot: RailSnapshot,
  ): ImpactEvaluation | Promise<ImpactEvaluation> {
    if (!this.usesServer()) return this.local.evaluatePreview(previewId, snapshot);
    return this.send<Record<string, unknown>, { impact: ImpactEvaluation }>(
      "schedule_evaluate",
      { previewId },
    ).then((response) => {
      const impact = response.result?.impact ??
        this.serverStateFrom(response)?.pendingImpact;
      if (!impact) throw new Error("The server did not return the schedule impact evaluation.");
      return impact;
    });
  }

  authorizePreview(
    previewId: string,
    impactId: string,
    snapshot: RailSnapshot,
  ): void | Promise<void> {
    if (!this.usesServer()) {
      this.local.authorizePreview(previewId, impactId, snapshot);
      return;
    }
    return this.send("schedule_authorize", { previewId, impactId }).then(() => undefined);
  }

  commitPreview(
    previewId: string,
    impactId: string,
    actor: Actor,
    snapshot: RailSnapshot,
  ): ScheduleReceipt | Promise<ScheduleReceipt> {
    if (!this.usesServer()) {
      return this.local.commitPreview(previewId, impactId, actor, snapshot);
    }
    return this.send<Record<string, unknown>, { receipt: ScheduleReceipt }>(
      "schedule_commit",
      { previewId, impactId, actor },
    ).then((response) => {
      const receipt = response.result?.receipt ??
        this.serverStateFrom(response)?.lastReceipt;
      if (!receipt) throw new Error("The server did not return the schedule decision receipt.");
      return receipt;
    });
  }

  discardPreview(): void | Promise<void> {
    if (!this.usesServer()) return this.local.discardPreview();
    return this.send("schedule_discard", {}).then(() => undefined);
  }

  undo(actor: Actor = "human"): ScheduleVersion | Promise<ScheduleVersion> {
    if (!this.usesServer()) return this.local.undo(actor);
    return this.send<Record<string, unknown>, { version: ScheduleVersion }>(
      "schedule_undo",
      { actor },
    ).then((response) => {
      const state = this.serverStateFrom(response);
      const version = response.result?.version ??
        (state ? state.versions[state.cursor] : undefined);
      if (!version) throw new Error("The server did not return the restored schedule version.");
      return version;
    });
  }
}

export const scheduleWorkspace = new RuntimeScheduleWorkspace();

export const scheduleStore = scheduleWorkspace;
export default scheduleWorkspace;
