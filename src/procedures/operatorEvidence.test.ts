import { describe, expect, it } from "vitest";
import { getOperationalProcedure } from "./index";
import { operatorEvidenceReferenceRequirement } from "./operatorEvidence";

function clearanceStep(procedureId: string) {
  const procedure = getOperationalProcedure(procedureId);
  const step = procedure?.steps.find((candidate) =>
    candidate.title === "Record the applicable clearance"
  );
  expect(step, procedureId).toBeDefined();
  return step!;
}

describe("operator authority evidence requirements", () => {
  it.each([
    ["ICC-PROC-STATION-WORKS-CLOSURE-001", "works-handback"],
    ["ICC-PROC-WORKS-HANDBACK-001", "works-handback"],
    ["ICC-PROC-POWER-WORKS-001", "works-handback"],
    ["ICC-PROC-ABANDONED-BAGGAGE-001", "police-clearance"],
  ] as const)("requires an explicit reference for %s", (procedureId, kind) => {
    expect(operatorEvidenceReferenceRequirement(clearanceStep(procedureId)))
      .toMatchObject({ kind, maxLength: 160 });
  });

  it("does not add the authority-reference gate to unrelated clearance steps", () => {
    expect(operatorEvidenceReferenceRequirement(clearanceStep("ICC-PROC-RST-TRAIN-001")))
      .toBeNull();
  });
});
