import { describe, expect, it } from "vitest";
import {
  OPERATIONAL_PROCEDURE_CATALOGUE,
  getOperationalProcedure,
  operatorEvidenceReferenceRequirement,
} from ".";
import { procedureContentHash } from "./integrity";
import {
  ProcedureWorkspaceError,
  createProcedureWorkspace,
  getProcedureRevision,
  listActiveProcedures,
  migrateProcedureWorkspace,
  projectProcedureWorkspace,
  publishProcedureStepPatch,
  resolveActiveProcedure,
  searchProcedureWorkspace,
  type ProcedureWorkspaceState,
} from "./registry";

const PROCEDURE_ID = "ICC-PROC-STATION-WORKS-CLOSURE-001";

function baseline() {
  return getOperationalProcedure(PROCEDURE_ID)!;
}

function publish(
  state: ProcedureWorkspaceState,
  patch: Record<string, unknown>,
  stepId = baseline().steps[0].stepId,
) {
  const active = resolveActiveProcedure(state, PROCEDURE_ID)!;
  return publishProcedureStepPatch(state, {
    procedureId: PROCEDURE_ID,
    stepId,
    expectedProcedureRevision: active.revision,
    expectedProcedureContentHash: active.contentHash,
    patch,
  });
}

function expectCode(action: () => unknown, code: ProcedureWorkspaceError["code"]) {
  try {
    action();
    throw new Error("Expected ProcedureWorkspaceError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcedureWorkspaceError);
    expect((error as ProcedureWorkspaceError).code).toBe(code);
  }
}

describe("editable procedure workspace", () => {
  it("starts as a lightweight immutable view over the unchanged static baseline", () => {
    const before = OPERATIONAL_PROCEDURE_CATALOGUE[0];
    const state = createProcedureWorkspace();
    expect(state).toMatchObject({
      schemaVersion: "paris-icc.procedure-workspace.v1",
      sequence: 0,
      revision: "ws.000000",
      activeOverrides: {},
      versions: [],
    });
    expect(state.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(state)).toBe(true);
    expect(listActiveProcedures(state)).toEqual(OPERATIONAL_PROCEDURE_CATALOGUE);
    expect(OPERATIONAL_PROCEDURE_CATALOGUE[0]).toBe(before);
  });

  it("publishes exactly one edited step as an append-only content-addressed revision", () => {
    const base = baseline();
    const result = publish(createProcedureWorkspace(), {
      title: "  Acknowledge the engineering closure  ",
      rationale: "Use explicit closure evidence before any operational response.",
    });
    expect(result.procedure.revision).toBe(`${base.revision}-ws.000001`);
    expect(result.procedure.contentHash).toBe(procedureContentHash(result.procedure));
    expect(result.procedure.steps[0]).toMatchObject({
      title: "Acknowledge the engineering closure",
      rationale: "Use explicit closure evidence before any operational response.",
      stepId: base.steps[0].stepId,
      order: base.steps[0].order,
      phase: base.steps[0].phase,
      capability: base.steps[0].capability,
    });
    expect(result.procedure.steps.slice(1)).toEqual(base.steps.slice(1));
    expect(result.changedFields).toEqual(["title", "rationale"]);
    expect(result.state).toMatchObject({
      sequence: 1,
      revision: "ws.000001",
      activeOverrides: { [PROCEDURE_ID]: `${base.revision}-ws.000001` },
    });
    expect(result.state.versions).toHaveLength(1);
    expect(getOperationalProcedure(PROCEDURE_ID)).toBe(base);
  });

  it("keeps old edited revisions exactly retrievable while resolving the newest active merge", () => {
    const first = publish(createProcedureWorkspace(), {
      instruction: "Confirm the first reviewed closure instruction before continuing.",
    });
    const second = publish(first.state, {
      instruction: "Confirm the second reviewed closure instruction before continuing.",
    });
    expect(second.procedure.revision).toBe(`${baseline().revision}-ws.000002`);
    expect(second.state.versions).toHaveLength(2);
    expect(getProcedureRevision(
      second.state,
      PROCEDURE_ID,
      first.procedure.revision,
    )).toBe(first.procedure);
    expect(resolveActiveProcedure(second.state, PROCEDURE_ID)).toBe(second.procedure);
    expect(getProcedureRevision(second.state, PROCEDURE_ID, baseline().revision))
      .toBe(baseline());
    expect(getProcedureRevision(second.state, PROCEDURE_ID, "missing")).toBeNull();
  });

  it("searches the active merged catalogue and returns the edited revision/hash", () => {
    const edited = publish(createProcedureWorkspace(), {
      responsibleRole: "Senior ICC engineering coordinator",
    });
    const matches = searchProcedureWorkspace(edited.state, {
      incidentCode: "ICC-INC-WRK-STA-CLS-001",
      targetType: "station",
      effect: "station-closure",
      atTime: Date.UTC(2026, 7, 30),
    });
    expect(matches).toEqual([
      expect.objectContaining({
        procedureId: PROCEDURE_ID,
        revision: edited.procedure.revision,
        contentHash: edited.procedure.contentHash,
      }),
    ]);
  });

  it("rejects locked fields, unknown fields, no-ops, and stale optimistic locks", () => {
    const state = createProcedureWorkspace();
    const base = baseline();
    expectCode(() => publish(state, { order: 999 }), "invalid_input");
    expectCode(() => publish(state, { surprise: "field" }), "invalid_input");
    expectCode(() => publish(state, { title: `  ${base.steps[0].title}  ` }), "no_change");
    expectCode(() => publishProcedureStepPatch(state, {
      procedureId: PROCEDURE_ID,
      stepId: base.steps[0].stepId,
      expectedProcedureRevision: "stale",
      expectedProcedureContentHash: base.contentHash,
      patch: { title: "A valid changed title" },
    }), "revision_conflict");
    expectCode(() => publishProcedureStepPatch(state, {
      procedureId: PROCEDURE_ID,
      stepId: base.steps[0].stepId,
      expectedProcedureRevision: base.revision,
      expectedProcedureContentHash: "sha256:" + "0".repeat(64),
      patch: { title: "A valid changed title" },
    }), "hash_conflict");
  });

  it("normalizes NFC and trim, and rejects controls, duplicate lists, and invalid durations", () => {
    const normalized = publish(createProcedureWorkspace(), {
      title: "  Cafe\u0301 engineering response  ",
    });
    expect(normalized.procedure.steps[0].title).toBe("Café engineering response");
    expectCode(() => publish(createProcedureWorkspace(), {
      instruction: "Unsafe\nmultiline instruction",
    }), "invalid_input");
    expectCode(() => publish(createProcedureWorkspace(), {
      evidenceRequired: ["Café", "Cafe\u0301"],
    }), "invalid_input");
    expectCode(() => publish(createProcedureWorkspace(), {
      durationRangeSeconds: { minSeconds: 20, nominalSeconds: 10, maxSeconds: 30 },
    }), "invalid_input");
    expectCode(() => publish(createProcedureWorkspace(), {
      durationRangeSeconds: { minSeconds: 10, nominalSeconds: 20, maxSeconds: 30, extra: 1 },
    }), "invalid_input");
    expectCode(() => publish(createProcedureWorkspace(), {
      instruction: "I".repeat(1_401),
    }), "invalid_input");
    expectCode(() => publish(createProcedureWorkspace(), {
      rationale: "R".repeat(901),
    }), "invalid_input");
  });

  it("projects active and explicitly referenced edited versions and migrates without baseline copies", () => {
    const first = publish(createProcedureWorkspace(), {
      title: "First controlled procedure title",
    });
    const second = publish(first.state, {
      title: "Second controlled procedure title",
    });
    const light = projectProcedureWorkspace(second.state);
    expect(light).toMatchObject({
      sequence: 2,
      revision: "ws.000002",
      activeOverrides: { [PROCEDURE_ID]: second.procedure.revision },
    });
    expect(light.referencedVersions).toEqual([second.procedure]);
    expect(light).not.toHaveProperty("versions");
    const migratedLight = migrateProcedureWorkspace(JSON.parse(JSON.stringify(light)));
    expect(migratedLight.sequence).toBe(2);
    expect(migratedLight.versions).toEqual([second.procedure]);
    expect(resolveActiveProcedure(migratedLight, PROCEDURE_ID)?.contentHash)
      .toBe(second.procedure.contentHash);

    const auditProjection = projectProcedureWorkspace(second.state, [{
      procedureId: PROCEDURE_ID,
      revision: first.procedure.revision,
    }]);
    expect(auditProjection.referencedVersions).toEqual([
      first.procedure,
      second.procedure,
    ]);
    const migrated = migrateProcedureWorkspace(JSON.parse(JSON.stringify(auditProjection)));
    expect(migrated.sequence).toBe(2);
    expect(migrated.versions).toHaveLength(2);
    expect(resolveActiveProcedure(migrated, PROCEDURE_ID)?.contentHash)
      .toBe(second.procedure.contentHash);
  });

  it("migrates absent legacy state and rejects tampered edited documents", () => {
    expect(migrateProcedureWorkspace(undefined)).toEqual(createProcedureWorkspace());
    expect(migrateProcedureWorkspace({ activeOverrides: {}, versions: [] }))
      .toEqual(createProcedureWorkspace());
    const edited = publish(createProcedureWorkspace(), {
      title: "Integrity protected procedure title",
    });
    const tampered = JSON.parse(JSON.stringify(edited.state));
    tampered.versions[0].steps[0].mandatory = false;
    expectCode(() => migrateProcedureWorkspace(tampered), "integrity_error");
    const hashTampered = JSON.parse(JSON.stringify(edited.state));
    hashTampered.versions[0].steps[0].title = "Undetected?";
    expectCode(() => migrateProcedureWorkspace(hashTampered), "integrity_error");
    const unknownField = JSON.parse(JSON.stringify(edited.state));
    unknownField.versions[0].steps[0].lockedSurprise = true;
    expectCode(() => migrateProcedureWorkspace(unknownField), "integrity_error");
  });

  it("keeps the machine evidence gate immutable when all editable prose changes", () => {
    const base = baseline();
    const clearance = base.steps.find((step) =>
      step.requiredEvidenceReferenceKind === "works-handback"
    )!;
    const edited = publish(createProcedureWorkspace(), {
      title: "Record the reviewed authority decision",
      instruction: "Record the externally supplied reference for the exact protected scope.",
      rationale: "The external authority controls release.",
      evidenceRequired: ["External reference"],
      completionCriteria: ["The exact reference is attached."],
    }, clearance.stepId);
    const editedClearance = edited.procedure.steps.find((step) =>
      step.stepId === clearance.stepId
    )!;
    expect(editedClearance.requiredEvidenceReferenceKind).toBe("works-handback");
    expect(operatorEvidenceReferenceRequirement(editedClearance))
      .toMatchObject({ kind: "works-handback" });
    expectCode(() => publish(createProcedureWorkspace(), {
      requiredEvidenceReferenceKind: "police-clearance",
    }, clearance.stepId), "invalid_input");
  });
});
