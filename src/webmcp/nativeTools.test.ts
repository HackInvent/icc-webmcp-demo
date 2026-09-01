import { describe, expect, it } from "vitest";
import { NATIVE_INTERSTATION_BY_ID, NATIVE_STATIONS } from "../rail/nativeNetwork";
import {
  NATIVE_SIMULATION_STEP_MS,
  createNativeNetworkController,
} from "../rail/nativeSimulation";
import { advanceOperationalResponse, createOperationalResponseState } from "../operations/operationalResponse";
import {
  createProcedureWorkspace,
  OPERATIONAL_PROCEDURE_CATALOGUE,
  projectProcedureWorkspace,
  publishProcedureStepPatch,
} from "../procedures";
import { createNativeSimulationTools } from "./nativeTools";

const TOOL_NAMES = [
  "inspect_network_digital_twin",
  "inspect_incident_decision_context",
  "search_operational_procedures",
  "get_operational_procedure",
  "apply_reviewed_procedure_step",
  "create_simulated_network_incident",
  "control_network_simulation",
];

function tool(tools: WebMcpToolDefinition[], name: string): WebMcpToolDefinition {
  const result = tools.find((candidate) => candidate.name === name);
  expect(result, `Missing tool ${name}`).toBeDefined();
  return result!;
}

function expectCommonContext(value: unknown): asserts value is Record<string, unknown> {
  expect(value).toEqual(expect.objectContaining({
    topology: expect.objectContaining({
      schema: "paris-icc-native-ratp-network-v1",
      lineCount: 21,
      stationCount: 390,
      interstationCount: 467,
    }),
    provenance: expect.objectContaining({
      topology: expect.stringContaining("RATP"),
      operations: expect.stringContaining("simulation"),
    }),
    limitations: expect.arrayContaining([
      expect.stringContaining("Decision-support simulation only"),
    ]),
    simulationOnly: true,
  }));
}

const FORBIDDEN_OPERATIONAL_READ_PROVENANCE =
  /\b(?:simulation|simulated|simulator|synthetic|demo|demonstration|deterministic|scenario)\b|local[- ]simulation|sourceKind|safetyNotice|simulationOnly/i;

function expectOperationalReadContext(value: unknown): asserts value is Record<string, unknown> {
  expect(value).toEqual(expect.objectContaining({
    topology: expect.objectContaining({
      schema: "paris-icc-native-ratp-network-v1",
      lineCount: 21,
    }),
    operationalBoundary: {
      state: "current versioned operational state",
      readOnly: true,
      decisionSupportOnly: true,
    },
    limitations: expect.any(Array),
  }));
  expect(value).not.toHaveProperty("provenance");
  expect(value).not.toHaveProperty("simulationOnly");
  const record = value as Record<string, unknown>;
  expect(JSON.stringify({
    operationalBoundary: record.operationalBoundary,
    limitations: record.limitations,
  })).not.toMatch(FORBIDDEN_OPERATIONAL_READ_PROVENANCE);
}

describe("native-network WebMCP tools", () => {
  it("publishes the exact seven-tool catalog with strict schemas and the full native line set", () => {
    const tools = createNativeSimulationTools(createNativeNetworkController());
    expect(tools.map((candidate) => candidate.name)).toEqual(TOOL_NAMES);

    const inspect = tool(tools, "inspect_network_digital_twin");
    expect(inspect.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    const inspectSchema = inspect.inputSchema as {
      properties: { line: { enum: string[] } };
      additionalProperties: boolean;
    };
    expect(inspectSchema.additionalProperties).toBe(false);
    expect(inspectSchema.properties.line.enum).toHaveLength(21);
    expect(inspectSchema.properties.line.enum).toContain("RER_D");

    for (const name of [
      "inspect_incident_decision_context",
      "search_operational_procedures",
      "get_operational_procedure",
    ]) {
      expect(tool(tools, name).description).not.toMatch(FORBIDDEN_OPERATIONAL_READ_PROVENANCE);
    }

    for (const name of [
      "apply_reviewed_procedure_step",
      "create_simulated_network_incident",
      "control_network_simulation",
    ]) {
      const definition = tool(tools, name);
      expect(definition.annotations?.readOnlyHint).toBe(false);
      const schema = definition.inputSchema as {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain("expectedDecisionRevision");
      expect(schema.required).toContain("confirmSimulation");
    }
    const applySchema = tool(tools, "apply_reviewed_procedure_step").inputSchema as {
      properties: {
        operatorEvidenceReference: { type: string; minLength: number; maxLength: number };
      };
      required: string[];
    };
    expect(applySchema.properties.operatorEvidenceReference).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 160,
    });
    expect(applySchema.required).not.toContain("operatorEvidenceReference");
    expect((tool(tools, "get_operational_procedure").inputSchema as { required: string[] }).required)
      .toEqual(["procedureId", "procedureRevision", "procedureContentHash"]);
  });

  it("reads a bounded 21-line digital twin and preserves source boundaries", async () => {
    const controller = createNativeNetworkController({ scenarioId: "multi-event" });
    const tools = createNativeSimulationTools(controller);
    const result = await tool(tools, "inspect_network_digital_twin").execute({
      line: "RER_A",
      incidentStatus: "active",
      limit: 1,
    }) as Record<string, unknown>;

    expect(result).toEqual(expect.objectContaining({
      status: "ok",
      operational: expect.objectContaining({
        scenarioId: "multi-event",
        decisionRevision: 0,
      }),
      scope: { line: "RER_A", incidentStatus: "active" },
      indicators: expect.objectContaining({ trainsInScope: 2 }),
      resultTruncated: expect.any(Boolean),
    }));
    expect((result.incidents as unknown[]).length).toBeLessThanOrEqual(1);
    expect((result.delayedTrains as unknown[]).length).toBeLessThanOrEqual(1);
    const fullNetwork = await tool(tools, "inspect_network_digital_twin").execute({ limit: 12 }) as Record<string, unknown>;
    const delayedTrains = fullNetwork.delayedTrains as Array<Record<string, unknown>>;
    expect(delayedTrains.length).toBeGreaterThan(0);
    expect(delayedTrains[0].operationalLocation).toEqual(expect.objectContaining({
      type: expect.stringMatching(/^(station|interstation)$/),
      id: expect.any(String),
    }));
    expect(delayedTrains[0]).toEqual(expect.objectContaining({
      capacity: expect.any(Number),
      loadPercent: expect.any(Number),
    }));
    expect(fullNetwork.indicators).toEqual(expect.objectContaining({
      passengersOnboard: expect.any(Number),
      passengersWaitingAtStations: expect.any(Number),
      stationPassengerArrivalRatePerSecond: expect.any(Number),
    }));
    const passengerController = createNativeNetworkController({ scenarioId: "multi-event" });
    for (let second = 0; second < 10; second += 1) passengerController.tick();
    const passengerTwin = await tool(
      createNativeSimulationTools(passengerController),
      "inspect_network_digital_twin",
    ).execute({ limit: 12 }) as Record<string, unknown>;
    expect((passengerTwin.indicators as Record<string, number>).passengersWaitingAtStations).toBeGreaterThan(0);
    expect(passengerTwin.busiestStationQueues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stationId: expect.any(String),
        waitingPassengers: expect.any(Number),
        arrivalsPerSecond: expect.any(Number),
        lastExchange: expect.any(Object),
      }),
    ]));
    expectCommonContext(result);
    expect(JSON.stringify(result)).toContain("deterministic");
    expect(JSON.stringify(result)).not.toContain("live signalling");
  });

  it("returns an entity-bound incident context and safe unknown result", async () => {
    const nativeController = createNativeNetworkController({ scenarioId: "m13-works" });
    const nativeSnapshot = nativeController.getSnapshot();
    const operationalResponse = advanceOperationalResponse(
      createOperationalResponseState(nativeSnapshot.timestamp),
      nativeSnapshot.incidents,
      nativeSnapshot.trains,
      nativeSnapshot.timestamp + 16 * 60_000,
    ).state;
    const controller = {
      ...nativeController,
      getOperationalResponse: () => operationalResponse,
    };
    const tools = createNativeSimulationTools(controller);
    const inspect = tool(tools, "inspect_incident_decision_context");

    const result = await inspect.execute({ incidentId: "INC-M13-WORKS" }) as Record<string, unknown>;
    expect(result).toEqual(expect.objectContaining({
      status: "context_ready",
      incident: expect.objectContaining({
        id: "INC-M13-WORKS",
        incidentCode: "ICC-INC-WRK-INT-BLK-001",
        occurrenceTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        lineCodes: ["M13"],
        target: {
          type: "interstation",
          id: "interstation-M13-71435--71474",
        },
      }),
      impact: expect.objectContaining({ activeRestrictionCount: 1 }),
      operationalResponse: expect.objectContaining({
        operatorApprovalRequired: true,
        incidentCase: expect.objectContaining({
          incidentId: "INC-M13-WORKS",
          predictedDuration: expect.objectContaining({
            basis: "mandatory-procedure-steps",
            procedureId: "ICC-PROC-WORKS-HANDBACK-001",
          }),
          milestones: expect.arrayContaining([
            expect.objectContaining({
              code: "passenger-information",
              status: "due",
              dueBasis: "elapsed-duration",
            }),
          ]),
        }),
        continuityMeasures: expect.arrayContaining([
          expect.objectContaining({ kind: "passenger-information", status: "proposed" }),
          expect.objectContaining({
            kind: "train-insertion",
            status: "proposed",
            operatorApprovalRequired: true,
            plan: expect.objectContaining({
              kind: "train-insertion",
              stationId: expect.any(String),
              direction: expect.any(Number),
              capacityDeltaPassengers: 700,
            }),
          }),
        ]),
      }),
    }));
    expectOperationalReadContext(result);

    const digitalTwin = await tool(tools, "inspect_network_digital_twin").execute({
      line: "M13",
      limit: 12,
    }) as Record<string, unknown>;
    expect(digitalTwin).toEqual(expect.objectContaining({
      continuityPlans: expect.arrayContaining([
        expect.objectContaining({
          incidentId: "INC-M13-WORKS",
          kind: "train-insertion",
          status: "proposed",
          operatorApprovalRequired: true,
          plan: expect.objectContaining({ kind: "train-insertion" }),
        }),
      ]),
    }));

    const missing = await inspect.execute({ incidentId: "INC-UNKNOWN" });
    expect(missing).toEqual(expect.objectContaining({
      status: "not_found",
      reason: "unknown_incident",
    }));
    expectOperationalReadContext(missing);
    expect(controller.getSnapshot().decisionRevision).toBe(0);
  });

  it("searches an incident code, retrieves immutable procedure evidence, and applies only an exact step", async () => {
    const controller = createNativeNetworkController({ scenarioId: "rer-a-signal" });
    const tools = createNativeSimulationTools(controller);
    const search = tool(tools, "search_operational_procedures");
    const getProcedure = tool(tools, "get_operational_procedure");
    const apply = tool(tools, "apply_reviewed_procedure_step");
    const incident = controller.getSnapshot().incidents[0];
    const beforeReads = controller.getSnapshot();

    const found = await search.execute({ incidentCode: incident.incidentCode }) as {
      status: string;
      incidentCode: string;
      catalogRevision: string;
      matches: Array<{
        procedureId: string;
        revision: string;
        contentHash: string;
      }>;
    };
    expect(found).toEqual(expect.objectContaining({
      status: "procedures_found",
      incidentCode: "ICC-INC-INF-INT-BLK-001",
      catalogRevision: expect.any(String),
      matches: [expect.objectContaining({
        procedureId: "ICC-PROC-INTERSTATION-BLOCK-001",
      })],
    }));
    expect(found.matches[0]).not.toHaveProperty("sourceKind");
    expect(found.matches[0]).not.toHaveProperty("official");
    expect(controller.getSnapshot()).toBe(beforeReads);
    expectOperationalReadContext(found);

    const match = found.matches[0];
    const retrieved = await getProcedure.execute({
      procedureId: match.procedureId,
      procedureRevision: match.revision,
      procedureContentHash: match.contentHash,
    }) as {
      status: string;
      procedure: {
        procedureId: string;
        revision: string;
        contentHash: string;
        steps: Array<{
          stepId: string;
          phase: string;
          rationale: string;
          durationRangeSeconds: { minSeconds: number; nominalSeconds: number; maxSeconds: number };
          capability: null | { command: string; requiresOperatorConfirmation: boolean };
        }>;
        normalStateCriteria: string[];
        returnToNormal: { observationWindowSeconds: number; operatorSignoffRequired: boolean };
      };
    };
    expect(retrieved).toEqual(expect.objectContaining({
      status: "procedure_ready",
      procedure: expect.objectContaining({
        procedureId: match.procedureId,
        revision: match.revision,
        contentHash: match.contentHash,
        normalStateCriteria: expect.arrayContaining([
          expect.stringContaining("Incident condition cleared"),
        ]),
        returnToNormal: {
          observationWindowSeconds: 30,
          operatorSignoffRequired: true,
        },
      }),
    }));
    expect(retrieved.procedure.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: "acknowledge",
        rationale: expect.any(String),
        durationRangeSeconds: { minSeconds: 15, nominalSeconds: 60, maxSeconds: 300 },
        capability: expect.objectContaining({
          command: "acknowledge",
          requiresOperatorConfirmation: true,
        }),
      }),
      expect.objectContaining({
        phase: "protect",
        capability: expect.objectContaining({ command: "protect-and-hold" }),
      }),
      expect.objectContaining({
        phase: "diagnose",
        capability: null,
      }),
      expect.objectContaining({
        phase: "close",
        capability: expect.objectContaining({ command: "close-incident" }),
      }),
    ]));
    expect(retrieved.procedure).not.toHaveProperty("sourceKind");
    expect(retrieved.procedure).not.toHaveProperty("official");
    expect(retrieved.procedure).not.toHaveProperty("safetyNotice");
    expectOperationalReadContext(retrieved);
    expect(JSON.stringify(retrieved)).not.toMatch(FORBIDDEN_OPERATIONAL_READ_PROVENANCE);
    expect(controller.getSnapshot()).toBe(beforeReads);

    const base = {
      incidentId: incident.id,
      procedureId: retrieved.procedure.procedureId,
      procedureRevision: retrieved.procedure.revision,
      procedureContentHash: retrieved.procedure.contentHash,
      expectedDecisionRevision: 0,
      confirmSimulation: true,
    };
    const acknowledgeStep = retrieved.procedure.steps.find(
      (step) => step.capability?.command === "acknowledge",
    )!;
    const protectedStep = retrieved.procedure.steps.find(
      (step) => step.capability?.command === "protect-and-hold",
    )!;
    const documentaryStep = retrieved.procedure.steps.find(
      (step) => step.capability === null,
    )!;

    const stale = await apply.execute({
      ...base,
      stepId: acknowledgeStep.stepId,
      expectedDecisionRevision: 1,
    });
    expect(stale).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "stale_decision_context",
    }));

    const wrongHash = await apply.execute({
      ...base,
      procedureContentHash: "sha256:00000000",
      stepId: acknowledgeStep.stepId,
    });
    expect(wrongHash).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "stale_procedure",
    }));

    const documentary = await apply.execute({ ...base, stepId: documentaryStep.stepId });
    expect(documentary).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "procedure_step_out_of_sequence",
    }));

    const unconfirmed = await apply.execute({
      ...base,
      stepId: acknowledgeStep.stepId,
      confirmSimulation: false,
    });
    expect(unconfirmed).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "simulation_confirmation_required",
    }));

    const acknowledged = await apply.execute({ ...base, stepId: acknowledgeStep.stepId });
    expect(acknowledged).toEqual(expect.objectContaining({
      status: "procedure_step_acknowledged",
      incidentCode: incident.incidentCode,
      procedureId: retrieved.procedure.procedureId,
      procedureRevision: retrieved.procedure.revision,
      procedureContentHash: retrieved.procedure.contentHash,
      stepId: acknowledgeStep.stepId,
      capability: "acknowledge",
      decisionRevision: 0,
      mutationApplied: false,
      simulationConfirmationRecorded: true,
    }));
    expect(controller.getSnapshot()).toBe(beforeReads);

    const duplicateAcknowledgement = await apply.execute({ ...base, stepId: acknowledgeStep.stepId });
    expect(duplicateAcknowledgement).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "no_op",
    }));

    const applied = await apply.execute({ ...base, stepId: protectedStep.stepId }) as Record<string, unknown>;
    expect(applied).toEqual(expect.objectContaining({
      status: "applied_to_simulation",
      incidentCode: incident.incidentCode,
      procedureId: retrieved.procedure.procedureId,
      stepId: protectedStep.stepId,
      capability: "protect-and-hold",
      previousDecisionRevision: 0,
      decisionRevision: 1,
      mutationApplied: true,
      receiptId: expect.stringMatching(/^DEC-/),
    }));
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({ decisionRevision: 1 }));
    expectCommonContext(applied);

    const documented = await apply.execute({
      ...base,
      stepId: documentaryStep.stepId,
      expectedDecisionRevision: 1,
    });
    expect(documented).toEqual(expect.objectContaining({
      status: "procedure_step_acknowledged",
      stepId: documentaryStep.stepId,
      capability: "operator-check",
      decisionRevision: 1,
      mutationApplied: false,
    }));

    const replay = await apply.execute({
      ...base,
      stepId: protectedStep.stepId,
      expectedDecisionRevision: 1,
    });
    expect(replay).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "no_op",
    }));
  });

  it("publishes the active workspace revision to WebMCP while keeping exact identity binding", async () => {
    const controller = createNativeNetworkController({ scenarioId: "rer-a-signal" });
    const incident = controller.getSnapshot().incidents[0];
    const baseline = OPERATIONAL_PROCEDURE_CATALOGUE.find((procedure) =>
      procedure.applicability.incidentCodes.includes(incident.incidentCode as never)
    )!;
    const firstStep = baseline.steps[0];
    const published = publishProcedureStepPatch(createProcedureWorkspace(), {
      procedureId: baseline.procedureId,
      stepId: firstStep.stepId,
      expectedProcedureRevision: baseline.revision,
      expectedProcedureContentHash: baseline.contentHash,
      patch: { title: `${firstStep.title} · workspace revision` },
    });
    const tools = createNativeSimulationTools(Object.assign(controller, {
      getProcedureCatalogue: () => projectProcedureWorkspace(published.state),
    }));
    const found = await tool(tools, "search_operational_procedures").execute({
      incidentCode: incident.incidentCode,
    }) as {
      catalogRevision: string;
      matches: Array<{
        procedureId: string;
        revision: string;
        contentHash: string;
        title: string;
      }>;
    };
    const match = found.matches.find((candidate) => candidate.procedureId === baseline.procedureId)!;

    expect(found.catalogRevision).toContain("ws.000001");
    expect(match).toEqual({
      procedureId: baseline.procedureId,
      revision: published.procedure.revision,
      contentHash: published.procedure.contentHash,
      title: published.procedure.title,
    });
    const retrieved = await tool(tools, "get_operational_procedure").execute({
      procedureId: match.procedureId,
      procedureRevision: match.revision,
      procedureContentHash: match.contentHash,
    }) as { status: string; procedure: { steps: Array<{ title: string }> } };
    expect(retrieved.status).toBe("procedure_ready");
    expect(retrieved.procedure.steps[0].title).toBe(`${firstStep.title} · workspace revision`);

    const staleHash = await tool(tools, "get_operational_procedure").execute({
      procedureId: match.procedureId,
      procedureRevision: match.revision,
      procedureContentHash: baseline.contentHash,
    });
    expect(staleHash).toEqual(expect.objectContaining({
      status: "not_found",
      reason: "procedure_hash_mismatch",
    }));
  });

  it("requires, records, and exposes the operator clearance reference", async () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const tools = createNativeSimulationTools(controller);
    const create = tool(tools, "create_simulated_network_incident");
    const apply = tool(tools, "apply_reviewed_procedure_step");
    const inspect = tool(tools, "inspect_incident_decision_context");
    const targetId = "interstation-M13-71435--71474";

    const created = await create.execute({
      targetType: "interstation",
      targetId,
      lineCode: "M13",
      type: "works",
      effect: "closure",
      severity: "high",
      expectedDecisionRevision: 0,
      confirmSimulation: true,
    }) as {
      incident: { id: string; incidentCode: string };
    };
    const found = await tool(tools, "search_operational_procedures").execute({
      incidentCode: created.incident.incidentCode,
    }) as {
      matches: Array<{ procedureId: string; revision: string; contentHash: string }>;
    };
    const procedureEvidence = found.matches[0];
    const retrieved = await tool(tools, "get_operational_procedure").execute({
      procedureId: procedureEvidence.procedureId,
      procedureRevision: procedureEvidence.revision,
      procedureContentHash: procedureEvidence.contentHash,
    }) as {
      procedure: {
        procedureId: string;
        revision: string;
        contentHash: string;
        steps: Array<{
          stepId: string;
          order: number;
          title: string;
          mandatory: boolean;
        }>;
      };
    };
    const clearanceStep = retrieved.procedure.steps.find(
      (step) => step.title === "Record the applicable clearance",
    )!;
    const applyStep = (stepId: string, operatorEvidenceReference?: string) =>
      apply.execute({
        incidentId: created.incident.id,
        procedureId: retrieved.procedure.procedureId,
        procedureRevision: retrieved.procedure.revision,
        procedureContentHash: retrieved.procedure.contentHash,
        stepId,
        expectedDecisionRevision: controller.getSnapshot().decisionRevision,
        confirmSimulation: true,
        ...(operatorEvidenceReference ? { operatorEvidenceReference } : {}),
      });

    for (const step of retrieved.procedure.steps.filter(
      (candidate) => candidate.mandatory && candidate.order < clearanceStep.order,
    )) {
      expect(await applyStep(step.stepId)).toEqual(expect.objectContaining({
        status: expect.stringMatching(/^(?:procedure_step_acknowledged|applied_to_simulation)$/),
      }));
    }

    expect(await applyStep(clearanceStep.stepId)).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "operator_evidence_reference_required",
      evidenceKind: "works-handback",
      stepId: clearanceStep.stepId,
    }));

    const reference = "HAND-2026-08-30-042";
    expect(await applyStep(clearanceStep.stepId, reference)).toEqual(expect.objectContaining({
      status: "procedure_step_acknowledged",
      stepRecord: expect.objectContaining({
        stepId: clearanceStep.stepId,
        operatorEvidenceReference: reference,
        evidenceKind: "works-handback",
      }),
    }));

    const context = await inspect.execute({
      incidentId: created.incident.id,
    });
    expect(context).toEqual(expect.objectContaining({
      incident: expect.objectContaining({
        procedureExecution: expect.objectContaining({
          stepRecords: expect.arrayContaining([
            expect.objectContaining({
              stepId: clearanceStep.stepId,
              operatorEvidenceReference: reference,
              evidenceKind: "works-handback",
            }),
          ]),
        }),
      }),
    }));
  });

  it("creates only known native-target incidents and rejects stale, duplicate, and aborted writes", async () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const tools = createNativeSimulationTools(controller);
    const create = tool(tools, "create_simulated_network_incident");
    const base = {
      targetType: "interstation",
      targetId: "interstation-M13-71435--71474",
      lineCode: "M13",
      type: "works",
      effect: "closure",
      severity: "high",
      title: "Late worksite handback",
      confirmSimulation: true,
    };
    expect(NATIVE_INTERSTATION_BY_ID.has(base.targetId)).toBe(true);

    const unknown = await create.execute({
      ...base,
      targetId: "interstation-M13-UNKNOWN--TARGET",
      expectedDecisionRevision: 0,
    });
    expect(unknown).toEqual(expect.objectContaining({
      status: "not_found",
      reason: "unknown_network_entity",
    }));
    expectCommonContext(unknown);

    const stale = await create.execute({ ...base, expectedDecisionRevision: 2 });
    expect(stale).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "stale_decision_context",
    }));

    const controllerSignal = new AbortController();
    controllerSignal.abort();
    const aborted = await create.execute(
      { ...base, expectedDecisionRevision: 0 },
      { signal: controllerSignal.signal },
    );
    expect(aborted).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "request_aborted",
    }));
    expect(controller.getSnapshot().decisionRevision).toBe(0);

    const created = await create.execute({ ...base, expectedDecisionRevision: 0 }) as Record<string, unknown>;
    expect(created).toEqual(expect.objectContaining({
      status: "created_in_simulation",
      decisionRevision: 1,
      incident: expect.objectContaining({
        lineCodes: ["M13"],
        incidentCode: "ICC-INC-WRK-INT-BLK-001",
        target: { type: "interstation", id: base.targetId },
        effect: "closure",
      }),
    }));
    expectCommonContext(created);

    const duplicate = await create.execute({ ...base, expectedDecisionRevision: 1 });
    expect(duplicate).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "no_op",
    }));
    expect(controller.getSnapshot().decisionRevision).toBe(1);

    const communication = await create.execute({
      targetType: "line",
      targetId: "RER_A",
      lineCode: "RER_A",
      type: "communications",
      effect: "communication_loss",
      severity: "critical",
      title: "SCADA communication loss",
      expectedDecisionRevision: 1,
      confirmSimulation: true,
    });
    expect(communication).toEqual(expect.objectContaining({
      status: "created_in_simulation",
      decisionRevision: 2,
      incident: expect.objectContaining({
        incidentCode: "ICC-INC-COM-LIN-LOS-001",
        target: { type: "line", id: "RER_A" },
        effect: "communication_loss",
      }),
    }));
  });

  it("rejects procedureless type/effect combinations and accepts both station safety presets", async () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal" });
    const create = tool(createNativeSimulationTools(controller), "create_simulated_network_incident");
    const [worksStation, baggageStation] = NATIVE_STATIONS
      .filter((station) => station.lines.includes("RER_A"))
      .slice(0, 2);
    expect(worksStation).toBeDefined();
    expect(baggageStation).toBeDefined();

    const common = {
      targetType: "station",
      lineCode: "RER_A",
      severity: "high",
      expectedDecisionRevision: 0,
      confirmSimulation: true,
    };
    const securityClosure = await create.execute({
      ...common,
      targetId: worksStation.code,
      type: "security",
      effect: "closure",
    });
    expect(securityClosure).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "unsupported_incident_combination",
      targetType: "station",
      type: "security",
      effect: "closure",
    }));

    const worksBaggage = await create.execute({
      ...common,
      targetId: baggageStation.code,
      type: "works",
      effect: "abandoned_baggage",
    });
    expect(worksBaggage).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "unsupported_incident_combination",
      targetType: "station",
      type: "works",
      effect: "abandoned_baggage",
    }));

    const procedurelessLineType = await create.execute({
      targetType: "line",
      targetId: "RER_A",
      lineCode: "RER_A",
      type: "external",
      effect: "communication_loss",
      severity: "critical",
      expectedDecisionRevision: 0,
      confirmSimulation: true,
    });
    expect(procedurelessLineType).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "unsupported_incident_combination",
      targetType: "line",
      type: "external",
      effect: "communication_loss",
    }));
    expect(controller.getSnapshot().decisionRevision).toBe(0);

    const worksClosure = await create.execute({
      ...common,
      targetId: worksStation.code,
      type: "works",
      effect: "closure",
      title: "Station closed for engineering works",
    });
    expect(worksClosure).toEqual(expect.objectContaining({
      status: "created_in_simulation",
      decisionRevision: 1,
      incident: expect.objectContaining({
        incidentCode: "ICC-INC-WRK-STA-CLS-001",
        target: { type: "station", id: worksStation.code },
        effect: "closure",
      }),
    }));

    const abandonedBaggage = await create.execute({
      ...common,
      targetId: baggageStation.code,
      type: "security",
      effect: "abandoned_baggage",
      severity: "critical",
      expectedDecisionRevision: 1,
      title: "Abandoned baggage",
    });
    expect(abandonedBaggage).toEqual(expect.objectContaining({
      status: "created_in_simulation",
      decisionRevision: 2,
      incident: expect.objectContaining({
        incidentCode: "ICC-INC-SEC-STA-BAG-001",
        target: { type: "station", id: baggageStation.code },
        effect: "abandoned_baggage",
      }),
    }));
  });

  it("enforces the complete procedure sequence and observation window before returning to normal", async () => {
    const controller = createNativeNetworkController({
      scenarioId: "rer-a-signal",
      speed: 1,
    });
    const tools = createNativeSimulationTools(controller);
    const search = tool(tools, "search_operational_procedures");
    const getProcedure = tool(tools, "get_operational_procedure");
    const apply = tool(tools, "apply_reviewed_procedure_step");
    const inspect = tool(tools, "inspect_incident_decision_context");
    const incident = controller.getSnapshot().incidents[0];
    const found = await search.execute({ incidentCode: incident.incidentCode }) as {
      matches: Array<{
        procedureId: string;
        revision: string;
        contentHash: string;
      }>;
    };
    const match = found.matches[0];
    const retrieved = await getProcedure.execute({
      procedureId: match.procedureId,
      procedureRevision: match.revision,
      procedureContentHash: match.contentHash,
    }) as {
      procedure: {
        procedureId: string;
        revision: string;
        contentHash: string;
        steps: Array<{ stepId: string; phase: string; mandatory: boolean }>;
      };
    };
    const applyStep = (stepId: string) => apply.execute({
      incidentId: incident.id,
      procedureId: retrieved.procedure.procedureId,
      procedureRevision: retrieved.procedure.revision,
      procedureContentHash: retrieved.procedure.contentHash,
      stepId,
      expectedDecisionRevision: controller.getSnapshot().decisionRevision,
      confirmSimulation: true,
    });
    const byPhase = (phase: string) =>
      retrieved.procedure.steps.find((step) => step.phase === phase && step.mandatory)!;

    expect(await applyStep(byPhase("acknowledge").stepId)).toEqual(
      expect.objectContaining({ status: "procedure_step_acknowledged" }),
    );
    expect(await applyStep(byPhase("protect").stepId)).toEqual(
      expect.objectContaining({ status: "applied_to_simulation" }),
    );
    expect(await applyStep(byPhase("diagnose").stepId)).toEqual(
      expect.objectContaining({
        status: "procedure_step_acknowledged",
        capability: "operator-check",
      }),
    );
    expect(await applyStep(byPhase("coordinate").stepId)).toEqual(
      expect.objectContaining({ status: "procedure_step_acknowledged" }),
    );
    expect(await applyStep(byPhase("recover").stepId)).toEqual(
      expect.objectContaining({ status: "applied_to_simulation" }),
    );

    const earlyVerify = await applyStep(byPhase("verify").stepId);
    expect(earlyVerify).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "observation_window_incomplete",
      requiredSeconds: 30,
    }));

    const requiredObservationSeconds = 30;
    const requiredObservationTicks = Math.ceil(
      requiredObservationSeconds * 1_000 / NATIVE_SIMULATION_STEP_MS,
    );
    for (let index = 0; index < requiredObservationTicks; index += 1) controller.tick();

    expect(await applyStep(byPhase("verify").stepId)).toEqual(
      expect.objectContaining({
        status: "procedure_step_acknowledged",
        capability: "operator-check",
      }),
    );
    const closed = await applyStep(byPhase("close").stepId);
    expect(closed).toEqual(expect.objectContaining({
      status: "applied_to_simulation",
      capability: "resolve-simulation",
      nextRequiredStepId: null,
      normalStateVerification: expect.objectContaining({
        status: "passed",
        incidentResolved: true,
        activeIncidentRestrictionCount: 0,
        mandatoryProcedureStepsComplete: true,
      }),
    }));
    expect(controller.getSnapshot().incidents.find(
      (candidate) => candidate.id === incident.id,
    )?.status).toBe("resolved");

    const finalContext = await inspect.execute({ incidentId: incident.id });
    expect(finalContext).toEqual(expect.objectContaining({
      incident: expect.objectContaining({
        procedureExecution: expect.objectContaining({
          managementState: "normal",
          nextRequiredStepId: null,
        }),
      }),
    }));
    expectOperationalReadContext(finalContext);
  });

  it("schedules a train-target incident from an ISO occurrence time", async () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal", speed: 0 });
    const create = tool(createNativeSimulationTools(controller), "create_simulated_network_incident");
    const train = controller.getSnapshot().trains.find((candidate) => candidate.lineCode === "RER_A")!;
    const occurrenceTime = new Date(controller.getSnapshot().timestamp + 60_000).toISOString();

    const created = await create.execute({
      targetType: "train",
      targetId: train.id,
      lineCode: train.lineCode,
      type: "rolling-stock",
      effect: "dwell_extension",
      severity: "high",
      occurrenceTime,
      expectedDecisionRevision: 0,
      confirmSimulation: true,
    });

    expect(created).toEqual(expect.objectContaining({
      status: "created_in_simulation",
      incident: expect.objectContaining({
        status: "planned",
        occurrenceTime,
        incidentCode: "ICC-INC-RST-TRN-IMM-001",
        target: { type: "train", id: train.id },
        effect: "dwell_extension",
      }),
    }));
  });

  it("controls the deterministic simulation with exact revisions and safe no-ops", async () => {
    const controller = createNativeNetworkController({ scenarioId: "nominal", speed: 1 });
    const tools = createNativeSimulationTools(controller);
    const control = tool(tools, "control_network_simulation");

    const unconfirmed = await control.execute({
      action: "pause",
      expectedDecisionRevision: 0,
      confirmSimulation: false,
    });
    expect(unconfirmed).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "simulation_confirmation_required",
    }));

    const paused = await control.execute({
      action: "pause",
      expectedDecisionRevision: 0,
      confirmSimulation: true,
    });
    expect(paused).toEqual(expect.objectContaining({
      status: "simulation_control_applied",
      action: "pause",
      speed: 0,
      decisionRevision: 1,
    }));
    expectCommonContext(paused);

    const duplicatePause = await control.execute({
      action: "pause",
      expectedDecisionRevision: 1,
      confirmSimulation: true,
    });
    expect(duplicatePause).toEqual(expect.objectContaining({
      status: "blocked",
      reason: "no_op",
    }));
    expect(controller.getSnapshot().decisionRevision).toBe(1);

    const resumed = await control.execute({
      action: "resume",
      expectedDecisionRevision: 1,
      confirmSimulation: true,
    });
    expect(resumed).toEqual(expect.objectContaining({ speed: 1, decisionRevision: 2 }));

    const scenario = await control.execute({
      action: "activate_scenario",
      scenarioId: "m14-power",
      expectedDecisionRevision: 2,
      confirmSimulation: true,
    });
    expect(scenario).toEqual(expect.objectContaining({
      status: "simulation_control_applied",
      scenarioId: "m14-power",
      decisionRevision: 3,
    }));
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      scenarioId: "m14-power",
      speed: 1,
      decisionRevision: 3,
    }));

    expect(() => control.execute({
      action: "set_speed",
      speed: 3,
      expectedDecisionRevision: 3,
      confirmSimulation: true,
    })).toThrow("speed must be one of");
  });
});
