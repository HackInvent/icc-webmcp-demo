/**
 * Version cursor, pending preview and one-shot authorization flow adapted
 * from ProofSheet's WorkspaceStore.
 * Copyright (c) 2026 Alexandre EL — used under the MIT License.
 * See the repository LICENSE for the complete license text.
 */

import type { RailSnapshot } from "../rail/domain";
import { assertValidSchedulePlan, cloneSchedulePlan } from "./csv";
import {
  evaluateSchedulePreview,
  hashOperationalContext,
  hashSchedulePlan,
} from "./quality";
import { buildSchedulePreview } from "./preview";
import type {
  Actor,
  ImpactEvaluation,
  ScheduleChangeRequest,
  SchedulePlan,
  SchedulePreview,
  ScheduleReceipt,
  ScheduleVersion,
  ScheduleWorkspace,
  ScheduleWorkspaceState,
} from "./types";
import { ScheduleWorkspaceError } from "./types";

type Listener = () => void;
let idCounter = 0;

function makeId(prefix: "version" | "receipt"): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

export class ScheduleWorkspaceStore implements ScheduleWorkspace {
  private state: ScheduleWorkspaceState = {
    versions: [],
    cursor: -1,
    pendingPreview: null,
    pendingImpact: null,
    authorizedPreviewId: null,
    authorizedImpactId: null,
    lastReceipt: null,
    lastEvent: "Waiting for a bounded schedule plan.",
    simulationOnly: true,
  };

  private readonly listeners = new Set<Listener>();

  constructor(initialPlan?: SchedulePlan) {
    this.state = deepFreeze(this.state);
    if (initialPlan) this.loadPlan(initialPlan);
  }

  getSnapshot = (): ScheduleWorkspaceState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: ScheduleWorkspaceState): void {
    this.state = deepFreeze(next);
    this.listeners.forEach((listener) => listener());
  }

  private currentPlanInternal(): SchedulePlan {
    const version = this.state.versions[this.state.cursor];
    if (!version) {
      throw new ScheduleWorkspaceError("PLAN_NOT_LOADED", "Load a schedule plan first.");
    }
    return version.plan;
  }

  currentPlan(): SchedulePlan {
    return cloneSchedulePlan(this.currentPlanInternal());
  }

  currentHash(): string {
    return hashSchedulePlan(this.currentPlanInternal());
  }

  loadPlan(plan: SchedulePlan): ScheduleVersion {
    assertValidSchedulePlan(plan);
    const copy = cloneSchedulePlan(plan);
    const version: ScheduleVersion = {
      id: makeId("version"),
      label: `Imported ${copy.name}`,
      createdAt: new Date().toISOString(),
      plan: copy,
    };
    this.publish({
      versions: [version],
      cursor: 0,
      pendingPreview: null,
      pendingImpact: null,
      authorizedPreviewId: null,
      authorizedImpactId: null,
      lastReceipt: null,
      lastEvent: `Loaded ${copy.services.length} bounded schedule service(s) from ${copy.name}.`,
      simulationOnly: true,
    });
    return version;
  }

  preview(
    request: ScheduleChangeRequest,
    snapshot: RailSnapshot,
    actor: Actor = "human",
  ): SchedulePreview {
    const preview = buildSchedulePreview(this.currentPlanInternal(), request, snapshot, actor);
    this.publish({
      ...this.state,
      pendingPreview: preview,
      pendingImpact: null,
      authorizedPreviewId: null,
      authorizedImpactId: null,
      lastEvent:
        `${actor === "agent" ? "Agent" : "Human"} prepared a non-destructive simulation preview: ` +
        `${preview.summary}. Impact evaluation is required before commit.`,
    });
    return preview;
  }

  evaluatePreview(previewId: string, snapshot: RailSnapshot): ImpactEvaluation {
    const preview = this.requirePreview(previewId);
    if (preview.beforeHash !== this.currentHash()) {
      throw new ScheduleWorkspaceError(
        "PREVIEW_STALE",
        "The schedule changed after this preview. Create a fresh preview.",
      );
    }
    const currentContextHash = hashOperationalContext(snapshot);
    if (preview.contextHash !== currentContextHash) {
      throw new ScheduleWorkspaceError(
        "CONTEXT_STALE",
        "Operational resources, incidents, or power changed after the preview. Create a fresh preview.",
      );
    }
    const impact = evaluateSchedulePreview(this.currentPlanInternal(), preview, snapshot);
    this.publish({
      ...this.state,
      pendingImpact: impact,
      authorizedPreviewId: null,
      authorizedImpactId: null,
      lastEvent:
        `Evaluated ${preview.id} against ${impact.contextHash}: score ${impact.score}, ` +
        `${impact.hardBlocks.length} new hard block(s).`,
    });
    return impact;
  }

  authorizePreview(previewId: string, impactId: string, snapshot: RailSnapshot): void {
    const preview = this.requirePreview(previewId);
    const impact = this.requireImpact(preview, impactId);
    if (preview.beforeHash !== this.currentHash()) {
      throw new ScheduleWorkspaceError(
        "PREVIEW_STALE",
        "The schedule changed after this preview. Create a fresh preview.",
      );
    }
    const currentContextHash = hashOperationalContext(snapshot);
    if (preview.contextHash !== currentContextHash || impact.contextHash !== currentContextHash) {
      throw new ScheduleWorkspaceError(
        "CONTEXT_STALE",
        "Operational resources, incidents, or power changed after evaluation. Re-preview and re-evaluate before authorization.",
      );
    }
    if (impact.hardBlocks.length > 0) {
      throw new ScheduleWorkspaceError(
        "HARD_BLOCK",
        "The evaluated candidate introduces hard blocks and cannot be authorized.",
      );
    }
    this.publish({
      ...this.state,
      authorizedPreviewId: preview.id,
      authorizedImpactId: impact.id,
      lastEvent: "Human authorized this exact preview and impact once for an agent commit.",
    });
  }

  commitPreview(
    previewId: string,
    impactId: string,
    actor: Actor,
    snapshot: RailSnapshot,
  ): ScheduleReceipt {
    if (snapshot.source !== "simulation") {
      throw new ScheduleWorkspaceError(
        "LIVE_FORBIDDEN",
        "Schedule commits are simulation-only; live railway commands are forbidden.",
      );
    }
    const preview = this.requirePreview(previewId);
    const impact = this.requireImpact(preview, impactId);
    if (preview.beforeHash !== this.currentHash()) {
      throw new ScheduleWorkspaceError(
        "PREVIEW_STALE",
        "The schedule changed after this preview. Create a fresh preview.",
      );
    }
    const currentContextHash = hashOperationalContext(snapshot);
    if (preview.contextHash !== currentContextHash || impact.contextHash !== currentContextHash) {
      throw new ScheduleWorkspaceError(
        "CONTEXT_STALE",
        "Operational resources, incidents, or power changed after evaluation. Re-preview and re-evaluate.",
      );
    }
    if (impact.afterHash !== preview.afterHash || impact.beforeHash !== preview.beforeHash) {
      throw new ScheduleWorkspaceError(
        "IMPACT_STALE",
        "The impact evaluation does not match the exact visible preview.",
      );
    }
    if (preview.changes.length === 0 || preview.beforeHash === preview.afterHash) {
      throw new ScheduleWorkspaceError("NO_CHANGES", "The preview has no changes to commit.");
    }
    if (impact.hardBlocks.length > 0) {
      throw new ScheduleWorkspaceError(
        "HARD_BLOCK",
        "The candidate introduces hard operational blocks and cannot be committed.",
      );
    }
    if (
      actor === "agent" &&
      (this.state.authorizedPreviewId !== preview.id ||
        this.state.authorizedImpactId !== impact.id)
    ) {
      throw new ScheduleWorkspaceError(
        "AUTHORIZATION_REQUIRED",
        "Human authorization is required for this exact preview and impact before one agent commit.",
      );
    }

    const createdAt = new Date().toISOString();
    const receipt: ScheduleReceipt = {
      id: makeId("receipt"),
      previewId: preview.id,
      impactId: impact.id,
      request: preview.request,
      beforeHash: preview.beforeHash,
      afterHash: preview.afterHash,
      contextHash: impact.contextHash,
      changedServiceIds: [...preview.affectedServiceIds],
      summary: preview.summary,
      score: impact.score,
      assessment: impact.assessment,
      createdAt,
      actor,
      simulationOnly: true,
    };
    const version: ScheduleVersion = {
      id: makeId("version"),
      label: preview.summary,
      createdAt,
      plan: cloneSchedulePlan(preview.result),
      receipt,
    };
    const retained = this.state.versions.slice(0, this.state.cursor + 1);
    const versions = [...retained, version];
    this.publish({
      ...this.state,
      versions,
      cursor: versions.length - 1,
      pendingPreview: null,
      pendingImpact: null,
      authorizedPreviewId: null,
      authorizedImpactId: null,
      lastReceipt: receipt,
      lastEvent: actor === "agent"
        ? `Agent committed ${receipt.changedServiceIds.length} schedule service(s) to the local simulation ` +
          `with receipt ${receipt.id}. The one-use human authorization was consumed.`
        : `Human committed ${receipt.changedServiceIds.length} schedule service(s) directly to the local simulation ` +
          `with receipt ${receipt.id}. No agent authorization was required.`,
    });
    return receipt;
  }

  discardPreview(): void {
    if (!this.state.pendingPreview && !this.state.pendingImpact) return;
    this.publish({
      ...this.state,
      pendingPreview: null,
      pendingImpact: null,
      authorizedPreviewId: null,
      authorizedImpactId: null,
      lastEvent: "Discarded the pending preview and impact; the schedule was not changed.",
    });
  }

  undo(actor: Actor = "human"): ScheduleVersion {
    if (this.state.cursor <= 0) {
      throw new ScheduleWorkspaceError(
        "NOTHING_TO_UNDO",
        "There is no committed schedule change to undo.",
      );
    }
    const cursor = this.state.cursor - 1;
    const version = this.state.versions[cursor];
    this.publish({
      ...this.state,
      cursor,
      pendingPreview: null,
      pendingImpact: null,
      authorizedPreviewId: null,
      authorizedImpactId: null,
      lastReceipt: version.receipt ?? null,
      lastEvent:
        `${actor === "agent" ? "Agent" : "Human"} restored the exact prior schedule version ` +
        `${version.id}.`,
    });
    return version;
  }

  restoreSnapshot(state: ScheduleWorkspaceState): void {
    if (!state || !Array.isArray(state.versions) || state.versions.length === 0) {
      throw new ScheduleWorkspaceError("PLAN_NOT_LOADED", "A persisted schedule workspace needs at least one version.");
    }
    if (!Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor >= state.versions.length) {
      throw new ScheduleWorkspaceError("PLAN_NOT_LOADED", "The persisted schedule cursor is invalid.");
    }
    for (const version of state.versions) assertValidSchedulePlan(version.plan);
    const restored = JSON.parse(JSON.stringify(state)) as ScheduleWorkspaceState;
    this.publish(restored);
  }

  private requirePreview(previewId: string): SchedulePreview {
    const preview = this.state.pendingPreview;
    if (!preview || preview.id !== previewId) {
      throw new ScheduleWorkspaceError(
        "PREVIEW_STALE",
        "Preview not found or stale. Create a new preview before continuing.",
      );
    }
    return preview;
  }

  private requireImpact(preview: SchedulePreview, impactId: string): ImpactEvaluation {
    const impact = this.state.pendingImpact;
    if (!impact) {
      throw new ScheduleWorkspaceError(
        "IMPACT_REQUIRED",
        "Evaluate the visible preview before authorization or commit.",
      );
    }
    if (impact.id !== impactId || impact.previewId !== preview.id) {
      throw new ScheduleWorkspaceError(
        "IMPACT_STALE",
        "Impact evaluation not found or stale. Re-evaluate the visible preview.",
      );
    }
    return impact;
  }
}
