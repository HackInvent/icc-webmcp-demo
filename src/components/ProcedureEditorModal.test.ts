import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OPERATIONAL_PROCEDURE_CATALOGUE } from "../procedures";
import {
  buildPublishProcedureStepInput,
  buildProcedureStepPatch,
  ProcedureEditorModal,
  procedureEditorNavigationIndex,
  procedureStepEditorValues,
  validateProcedureStepEditor,
} from "./ProcedureEditorModal";

const procedure = OPERATIONAL_PROCEDURE_CATALOGUE[0];
const step = procedure.steps[0];

describe("procedure editor workspace", () => {
  it("opens an exact step in one accessible workspace with mutable fields and visible invariants", () => {
    const selectedStep = procedure.steps[1];
    const html = renderToStaticMarkup(createElement(ProcedureEditorModal, {
      procedure,
      initialStepId: selectedStep.stepId,
      onClose: vi.fn(),
      onPublishStep: vi.fn(async () => undefined),
      onRequestAgentFeedback: vi.fn(async () => { throw new Error("not invoked during static rendering"); }),
    }));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-testid="procedure-editor"');
    expect(html).toContain('data-testid="procedure-editor-step-list"');
    expect(html).toContain(`data-testid="procedure-editor-step-${selectedStep.stepId}"`);
    expect(html).toContain(`value="${selectedStep.title.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`);
    expect(html).toContain("Execution invariants");
    expect(html).toContain(selectedStep.stepId);
    expect(html).toContain("Operator confirmation");
    expect(html).toContain('data-testid="procedure-editor-previous"');
    expect(html).toContain('data-testid="procedure-editor-next"');
    expect(html).toContain('data-testid="procedure-editor-publish"');
    expect(html).toContain('data-testid="procedure-editor-agent-feedback"');
    expect(html).toContain("Ask agent for feedback");
    expect(html).toContain("Procedure edit feedback");
    expect(html).toContain("previous edits, linked operational REX and current public sources");
    expect(html).not.toContain("NOT AN OFFICIAL");
  });

  it("builds a minimal concurrency-safe publication payload", () => {
    const values = {
      ...procedureStepEditorValues(step),
      title: "  Revised protection instruction  ",
      evidenceRequired: "Signal state\nOperator authority reference\n",
      minSeconds: "30",
      nominalSeconds: "90",
      maxSeconds: "240",
    };

    expect(buildPublishProcedureStepInput(procedure, step, values)).toEqual({
      procedureId: procedure.procedureId,
      expectedProcedureRevision: procedure.revision,
      expectedProcedureContentHash: procedure.contentHash,
      stepId: step.stepId,
      patch: {
        title: "Revised protection instruction",
        evidenceRequired: ["Signal state", "Operator authority reference"],
        durationRangeSeconds: {
          minSeconds: 30,
          nominalSeconds: 90,
          maxSeconds: 240,
        },
      },
    });
  });

  it("keeps unchanged fields out of a step patch", () => {
    expect(buildProcedureStepPatch(step, procedureStepEditorValues(step))).toEqual({});
  });

  it("rejects incomplete content and inconsistent duration ranges", () => {
    const errors = validateProcedureStepEditor({
      ...procedureStepEditorValues(step),
      title: " ",
      evidenceRequired: "\n",
      completionCriteria: "",
      minSeconds: "120",
      nominalSeconds: "60",
      maxSeconds: "59",
    });

    expect(errors.title).toMatch(/title/i);
    expect(errors.evidenceRequired).toMatch(/at least one/i);
    expect(errors.completionCriteria).toMatch(/at least one/i);
    expect(errors.nominalSeconds).toMatch(/minimum/i);
    expect(errors.maxSeconds).toMatch(/nominal/i);
  });

  it("validates the same bounded content contract as the server", () => {
    const errors = validateProcedureStepEditor({
      ...procedureStepEditorValues(step),
      instruction: "I".repeat(1_401),
      rationale: "R".repeat(901),
      preconditions: "Duplicate\nDuplicate",
      maxSeconds: "604801",
    });

    expect(errors.instruction).toMatch(/1400/);
    expect(errors.rationale).toMatch(/900/);
    expect(errors.preconditions).toMatch(/duplicate/i);
    expect(errors.maxSeconds).toMatch(/604800/);
  });

  it("clamps previous and next navigation to the procedure boundaries", () => {
    expect(procedureEditorNavigationIndex(0, -1, 4)).toBe(0);
    expect(procedureEditorNavigationIndex(0, 1, 4)).toBe(1);
    expect(procedureEditorNavigationIndex(3, 1, 4)).toBe(3);
  });
});
