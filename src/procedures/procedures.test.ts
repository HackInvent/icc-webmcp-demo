import { describe, expect, it } from "vitest";
import {
  DEMO_NOTICE,
  OPERATIONAL_PROCEDURE_CATALOGUE,
  OPERATIONAL_PROCEDURE_CATALOGUE_METADATA,
  PROCEDURE_CATALOG_REVISION,
  UNKNOWN_INCIDENT_CODE,
  classifyIncidentCode,
  getOperationalProcedure,
  searchOperationalProcedures,
  type ProcedureCapability,
  type ProcedureIncidentEffect,
  type ProcedureIncidentType,
  type ProcedureTargetType,
} from ".";

const FORM_TYPES: Readonly<Record<ProcedureTargetType, readonly ProcedureIncidentType[]>> = {
  train: ["rolling-stock", "passenger", "external"],
  station: ["passenger", "infrastructure", "works", "external"],
  interstation: ["infrastructure", "works", "external"],
  power: ["power", "infrastructure", "works", "external"],
  line: [],
};

const FORM_EFFECTS: Readonly<Record<ProcedureTargetType, readonly ProcedureIncidentEffect[]>> = {
  train: ["stop-train"],
  station: ["station-closure", "station-dwell"],
  interstation: ["block-interstation", "reduce-speed"],
  power: ["degrade-power", "isolate-power"],
  line: [],
};

const FORM_COMBINATIONS = (Object.keys(FORM_TYPES) as ProcedureTargetType[]).flatMap(
  (targetType) => FORM_TYPES[targetType].flatMap((type) =>
    FORM_EFFECTS[targetType].map((effect) => ({ type, targetType, effect }))
  ),
);

describe("synthetic operational-procedure catalogue", () => {
  it("is explicitly non-official, versioned, immutable, and content-addressed", () => {
    expect(OPERATIONAL_PROCEDURE_CATALOGUE).toHaveLength(14);
    expect(Object.isFrozen(OPERATIONAL_PROCEDURE_CATALOGUE)).toBe(true);
    expect(PROCEDURE_CATALOG_REVISION).toBe("2026.08.30.4");
    expect(OPERATIONAL_PROCEDURE_CATALOGUE_METADATA).toMatchObject({
      catalogueId: "paris-icc-operational-procedures",
      revision: PROCEDURE_CATALOG_REVISION,
      sourceKind: "demo-authored",
      official: false,
      procedureCount: 14,
      hashAlgorithm: "sha256",
    });
    expect(DEMO_NOTICE).toContain("not an official RATP");
    expect(OPERATIONAL_PROCEDURE_CATALOGUE_METADATA.contentHash)
      .toMatch(/^sha256:[0-9a-f]{64}$/);

    const documentHashes = new Set<string>();
    for (const procedure of OPERATIONAL_PROCEDURE_CATALOGUE) {
      expect(procedure.source).toMatchObject({
        kind: "demo-authored",
        official: false,
        issuer: "Hackinvent / Paris ICC demo",
      });
      expect(procedure.source.notice).toBe(DEMO_NOTICE);
      expect(procedure.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Object.isFrozen(procedure)).toBe(true);
      documentHashes.add(procedure.contentHash);
    }
    expect(documentHashes.size).toBe(OPERATIONAL_PROCEDURE_CATALOGUE.length);
  });

  it("classifies every type, target, and effect combination exposed by the form", () => {
    expect(FORM_COMBINATIONS).toHaveLength(25);
    const codes = FORM_COMBINATIONS.map(classifyIncidentCode);
    expect(codes).not.toContain(UNKNOWN_INCIDENT_CODE);
    expect(new Set(codes)).toHaveLength(FORM_COMBINATIONS.length);
    expect(classifyIncidentCode({
      type: "rolling-stock",
      targetType: "train",
      effect: "stop-train",
    })).toBe("ICC-INC-RST-TRN-IMM-001");
    expect(classifyIncidentCode({
      type: "power",
      targetType: "power",
      effect: "isolate-power",
    })).toBe("ICC-INC-PWR-PWR-ISO-001");
  });

  it("does not guess a code for a semantically invalid combination", () => {
    expect(classifyIncidentCode({
      type: "rolling-stock",
      targetType: "station",
      effect: "station-closure",
    })).toBe(UNKNOWN_INCIDENT_CODE);
    expect(classifyIncidentCode({
      type: "power",
      targetType: "train",
      effect: "stop-train",
    })).toBe(UNKNOWN_INCIDENT_CODE);
  });

  it("maps every form combination to exactly one effective procedure", () => {
    const atTime = Date.UTC(2026, 7, 29, 12, 0, 0);
    for (const combination of FORM_COMBINATIONS) {
      const incidentCode = classifyIncidentCode(combination);
      const matches = searchOperationalProcedures({
        incidentCode,
        targetType: combination.targetType,
        effect: combination.effect,
        atTime,
      });
      expect(matches, `${incidentCode} must have exactly one procedure`).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        matchedIncidentCode: incidentCode,
        matchedTargetType: combination.targetType,
        matchedEffect: combination.effect,
        sourceKind: "demo-authored",
        official: false,
      });
      const document = getOperationalProcedure(matches[0].procedureId, matches[0].revision);
      expect(document?.contentHash).toBe(matches[0].contentHash);
      expect(document?.applicability.incidentCodes).toContain(incidentCode);
    }
  });

  it("retrieves exact revisions without silently falling back", () => {
    const procedure = getOperationalProcedure("ICC-PROC-INTERSTATION-BLOCK-001");
    expect(procedure?.revision).toBe("1.0");
    expect(getOperationalProcedure("ICC-PROC-INTERSTATION-BLOCK-001", "1.0"))
      .toBe(procedure);
    expect(getOperationalProcedure("ICC-PROC-INTERSTATION-BLOCK-001", "UNKNOWN"))
      .toBeNull();
    expect(getOperationalProcedure("ICC-PROC-NOT-FOUND-999")).toBeNull();
  });

  it("enforces temporal, target, effect, unknown-code, and limit filters", () => {
    const incidentCode = classifyIncidentCode({
      type: "infrastructure",
      targetType: "interstation",
      effect: "block-interstation",
    });
    expect(searchOperationalProcedures({
      incidentCode,
      targetType: "interstation",
      effect: "block-interstation",
      atTime: Date.UTC(2025, 11, 31),
    })).toEqual([]);
    expect(searchOperationalProcedures({
      incidentCode,
      targetType: "interstation",
      effect: "reduce-speed",
    })).toEqual([]);
    expect(searchOperationalProcedures({
      incidentCode: UNKNOWN_INCIDENT_CODE,
      targetType: "interstation",
      effect: "block-interstation",
    })).toEqual([]);
    expect(() => searchOperationalProcedures({
      incidentCode,
      targetType: "interstation",
      effect: "block-interstation",
      atTime: Number.NaN,
    })).toThrow(RangeError);
    expect(() => searchOperationalProcedures({
      incidentCode,
      targetType: "interstation",
      effect: "block-interstation",
      limit: 0,
    })).toThrow(RangeError);
  });

  it("publishes dedicated communication, baggage, and towing procedures with explicit planning durations", () => {
    expect(classifyIncidentCode({ type: "communications", targetType: "line", effect: "communication-loss" }))
      .toBe("ICC-INC-COM-LIN-LOS-001");
    expect(classifyIncidentCode({ type: "security", targetType: "station", effect: "abandoned-baggage" }))
      .toBe("ICC-INC-SEC-STA-BAG-001");
    expect(classifyIncidentCode({ type: "rolling-stock", targetType: "train", effect: "tow-train" }))
      .toBe("ICC-INC-RST-TRN-TOW-001");
    const baggage = getOperationalProcedure("ICC-PROC-ABANDONED-BAGGAGE-001")!;
    expect(baggage.steps.find((step) => step.phase === "coordinate")?.durationRangeSeconds.nominalSeconds)
      .toBe(3_600);
    expect(baggage.steps.find((step) => step.phase === "coordinate")?.instruction).toContain("police");
    const towing = getOperationalProcedure("ICC-PROC-ROLLING-STOCK-TOWING-001")!;
    expect(towing.steps.find((step) => step.capability === "start-towing")?.durationRangeSeconds.nominalSeconds)
      .toBe(10_800);
  });

  it("requires flanking turnbacks and a split provisional service for works closures and abandoned baggage", () => {
    const atTime = Date.UTC(2026, 7, 30, 12, 0, 0);
    const worksCode = classifyIncidentCode({
      type: "works",
      targetType: "station",
      effect: "station-closure",
    });
    expect(worksCode).toBe("ICC-INC-WRK-STA-CLS-001");
    expect(searchOperationalProcedures({
      incidentCode: worksCode,
      targetType: "station",
      effect: "station-closure",
      atTime,
    })).toEqual([
      expect.objectContaining({
        procedureId: "ICC-PROC-STATION-WORKS-CLOSURE-001",
        revision: "1.0",
      }),
    ]);
    expect(getOperationalProcedure("ICC-PROC-STATION-CLOSURE-001")?.applicability.incidentCodes)
      .not.toContain(worksCode);

    const cases = [
      {
        procedureId: "ICC-PROC-STATION-WORKS-CLOSURE-001",
        clearance: /engineering.*handback/i,
        exclusion: /no train may enter, traverse, or call/i,
      },
      {
        procedureId: "ICC-PROC-ABANDONED-BAGGAGE-001",
        clearance: /police\/security authority/i,
        exclusion: /no train may enter, pass through, or stop/i,
      },
    ] as const;

    for (const expected of cases) {
      const procedure = getOperationalProcedure(expected.procedureId)!;
      const turnbacks = procedure.steps.filter((step) => step.capability === "activate-turnbacks");
      const provisionalServices = procedure.steps.filter(
        (step) => step.capability === "activate-provisional-service",
      );
      expect(turnbacks, expected.procedureId).toHaveLength(1);
      expect(provisionalServices, expected.procedureId).toHaveLength(1);
      expect(turnbacks[0]).toMatchObject({
        stepId: `${expected.procedureId}-S32`,
        order: 32,
        phase: "mitigate",
        mandatory: true,
        operatorConfirmationRequired: true,
        durationRangeSeconds: { minSeconds: 300, nominalSeconds: 600, maxSeconds: 1_200 },
      });
      expect(turnbacks[0].instruction).toMatch(expected.exclusion);
      expect(turnbacks[0].evidenceRequired).toEqual(expect.arrayContaining([
        "Upstream and downstream graph-grounded flanking station IDs",
        "Operator approval and turnback receipt",
      ]));
      expect(turnbacks[0].completionCriteria.join(" ")).toMatch(/persistent operator-approved receipt/i);
      expect(provisionalServices[0]).toMatchObject({
        stepId: `${expected.procedureId}-S33`,
        order: 33,
        phase: "mitigate",
        mandatory: true,
        operatorConfirmationRequired: true,
        durationRangeSeconds: { minSeconds: 300, nominalSeconds: 600, maxSeconds: 1_800 },
      });
      expect(provisionalServices[0].preconditions).toContain(
        "The graph-grounded flanking turnbacks have an operator-approved receipt.",
      );
      expect(provisionalServices[0].evidenceRequired).toEqual(expect.arrayContaining([
        "Operator-approved turnback receipt",
        "Operator approval and provisional-service receipt",
      ]));
      expect(provisionalServices[0].completionCriteria.join(" ")).toMatch(/persistent operator-approved receipt/i);

      const clearance = procedure.steps.find((step) => step.title === "Record the applicable clearance")!;
      const recovery = procedure.steps.find((step) => step.phase === "recover")!;
      const closure = procedure.steps.find((step) => step.phase === "close")!;
      expect(clearance.instruction).toMatch(expected.clearance);
      expect(recovery.instruction).toMatch(/turnbacks.*provisional service|provisional service.*turnbacks/i);
      expect(procedure.returnToNormal.criteria.find((criterion) => criterion.criterionId === "service-observed")?.evidence)
        .toMatch(/traversal.*service|service.*traversal/i);
      expect(procedure.steps.filter((step) => step.mandatory && step.order < closure.order)
        .map((step) => step.stepId)).toEqual(expect.arrayContaining([
          turnbacks[0].stepId,
          provisionalServices[0].stepId,
        ]));
    }
  });

  it("documents executable maintenance dispatches for infrastructure, traction, and rolling stock", () => {
    const expected = [
      ["ICC-PROC-RST-TRAIN-001", 300, 900, 3_600],
      ["ICC-PROC-STATION-CLOSURE-001", 300, 900, 2_400],
      ["ICC-PROC-STATION-DWELL-001", 300, 600, 1_800],
      ["ICC-PROC-INTERSTATION-BLOCK-001", 600, 1_200, 3_600],
      ["ICC-PROC-INTERSTATION-SPEED-001", 600, 1_800, 5_400],
      ["ICC-PROC-POWER-DEGRADED-001", 300, 900, 3_600],
      ["ICC-PROC-POWER-ISOLATION-001", 300, 1_200, 3_600],
      ["ICC-PROC-POWER-WORKS-001", 600, 1_800, 5_400],
      ["ICC-PROC-ROLLING-STOCK-TOWING-001", 600, 1_800, 3_600],
    ] as const;
    for (const [procedureId, minSeconds, nominalSeconds, maxSeconds] of expected) {
      const procedure = getOperationalProcedure(procedureId)!;
      const dispatchSteps = procedure.steps.filter((step) => step.capability === "dispatch-maintenance");
      expect(dispatchSteps, procedureId).toHaveLength(1);
      const dispatch = dispatchSteps[0];
      expect(dispatch).toMatchObject({
        order: 35,
        phase: "coordinate",
        mandatory: false,
        operatorConfirmationRequired: true,
        durationRangeSeconds: { minSeconds, nominalSeconds, maxSeconds },
      });
      expect(dispatch.instruction).toMatch(/dispatch/i);
      expect(dispatch.evidenceRequired).toEqual(expect.arrayContaining([
        "Named maintenance team or discipline",
        "Operator approval",
      ]));
      expect(procedure.steps.filter((step) => step.mandatory && step.order < dispatch.order)
        .map((step) => step.phase)).toEqual(["acknowledge", "protect", "diagnose"]);
      expect(dispatch.order).toBeLessThan(
        procedure.steps.find((step) => step.title === "Record the applicable clearance")!.order,
      );
    }
  });

  it("publishes ordered, auditable steps and guarded return-to-normal gates", () => {
    const allowedCapabilities = new Set<ProcedureCapability>([
      "acknowledge",
      "protect-and-hold",
      "degraded-operation",
      "resolve-simulation",
      "publish-passenger-information",
      "protect-connections",
      "dispatch-maintenance",
      "activate-provisional-service",
      "activate-turnbacks",
      "activate-shuttle-bus",
      "insert-train",
      "start-towing",
    ]);
    for (const procedure of OPERATIONAL_PROCEDURE_CATALOGUE) {
      expect(procedure.steps.length).toBeGreaterThanOrEqual(6);
      const orders = procedure.steps.map((step) => step.order);
      expect(orders).toEqual([...orders].sort((left, right) => left - right));
      expect(new Set(procedure.steps.map((step) => step.stepId)).size)
        .toBe(procedure.steps.length);
      expect(procedure.steps[0].capability).toBe("acknowledge");
      expect(procedure.steps.at(-1)?.capability).toBe("resolve-simulation");
      for (const step of procedure.steps) {
        expect(step.instruction.length).toBeGreaterThan(30);
        expect(step.evidenceRequired.length).toBeGreaterThan(0);
        expect(step.durationRangeSeconds.minSeconds).toBeLessThanOrEqual(step.durationRangeSeconds.nominalSeconds);
        expect(step.durationRangeSeconds.nominalSeconds).toBeLessThanOrEqual(step.durationRangeSeconds.maxSeconds);
        if (step.capability) {
          expect(allowedCapabilities.has(step.capability)).toBe(true);
          expect(step.operatorConfirmationRequired).toBe(true);
        }
      }
      expect(procedure.returnToNormal.operatorSignoffRequired).toBe(true);
      expect(procedure.returnToNormal.observationWindowSeconds).toBeGreaterThanOrEqual(30);
      expect(procedure.returnToNormal.criteria.map((criterion) => criterion.criterionId))
        .toEqual([
          "incident-condition-cleared",
          "restrictions-cleared",
          "service-observed",
          "operator-signoff",
        ]);
      expect(procedure.returnToNormal.criteria.every((criterion) => criterion.required))
        .toBe(true);
    }
  });
});
