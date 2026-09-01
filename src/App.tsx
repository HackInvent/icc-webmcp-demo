import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebMcpApprovalDialog } from "./components/WebMcpApprovalDialog";
import { EntityModal } from "./components/EntityModal";
import { NativeIncidentDecisionModal } from "./components/NativeIncidentDecisionModal";
import { ConfigurationModal } from "./components/ConfigurationModal";
import { Icon } from "./components/Icon";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { useHashRoute } from "./navigation";
import type { CircuitClosureResult, EntitySelection, NewIncidentInput } from "./rail/domain";
import { useRailSimulation } from "./rail/useRailSimulation";
import { useNativeNetworkSimulation } from "./rail/useNativeNetworkSimulation";
import type { NativeIncidentEffect } from "./rail/nativeSimulation";
import type { NativeLineCode } from "./rail/nativeNetwork";
import type { SimulatorIncidentCreationResult, SimulatorIncidentDraft } from "./rail/simulatorIncident";
import { operationsClient } from "./runtime/operationsClient";
import { scheduleWorkspace } from "./schedules/workspace";
import { createSampleSchedulePlan } from "./schedules/sample";
import { DetailPage } from "./pages/DetailPage";
import { IncidentsPage } from "./pages/IncidentsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PassengerFlowPage } from "./pages/PassengerFlowPage";
import { PowerPage } from "./pages/PowerPage";
import { RegulationPage } from "./pages/RegulationPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SimulatorPage } from "./pages/SimulatorPage";
import { ProceduresPage } from "./pages/ProceduresPage";
import { OperationsLogPage } from "./pages/OperationsLogPage";
import { ShiftReportPage } from "./pages/ShiftReportPage";
import { ScadaPage } from "./pages/ScadaPage";
import { BusServicesPage } from "./pages/BusServicesPage";
import { RollingStockPage } from "./pages/RollingStockPage";
import {
  listActiveProcedures,
  migrateProcedureWorkspace,
  PROCEDURE_CATALOG_REVISION,
} from "./procedures";
import type { PublishProcedureStepInput } from "./components/ProcedureEditorModal";
import {
  registerIccTools,
  type WebMcpActivity,
  type WebMcpApprovalDecision,
  type WebMcpApprovalHandler,
  type WebMcpApprovalRequest,
  type WebMcpAvailability,
} from "./webmcp/register";
import type {
  CircuitClosureCommand,
  CircuitClosureDependencyResult,
} from "./webmcp/tools";

function projectCircuitClosureResult(
  result: CircuitClosureResult,
): CircuitClosureDependencyResult {
  if (result.ok) {
    return {
      ok: true,
      outcome: result.outcome,
      circuitId: result.circuitId,
      message: result.message,
    };
  }
  return {
    ok: false,
    reason: result.reason,
    circuitId: result.circuitId,
    message: result.message,
  };
}

interface PendingToolApproval {
  requestId: string;
  finish: (decision: WebMcpApprovalDecision) => void;
}

function App() {
  const route = useHashRoute();
  const rail = useRailSimulation();
  const nativeNetwork = useNativeNetworkSimulation();
  const [collapsed, setCollapsed] = useState(false);
  const hasMountedRoute = useRef(false);
  const [selection, setSelection] = useState<EntitySelection | null>(null);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [nativeDecisionIncidentId, setNativeDecisionIncidentId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [webMcpAvailability, setWebMcpAvailability] = useState<WebMcpAvailability>({
    checked: false,
    supported: false,
    count: 0,
    names: [],
  });
  const [, setWebMcpActivity] = useState<WebMcpActivity[]>([]);
  const [webMcpTools, setWebMcpTools] = useState<readonly WebMcpToolDefinition[]>([]);
  const [toolApproval, setToolApproval] = useState<WebMcpApprovalRequest | null>(null);
  const pendingApprovalRef = useRef<PendingToolApproval | null>(null);
  const snapshot = rail.state.snapshot;
  const serverSnapshot = operationsClient.getServerSnapshot();
  const procedureWorkspace = useMemo(
    () => migrateProcedureWorkspace(serverSnapshot?.procedureCatalogue),
    [serverSnapshot?.procedureCatalogue],
  );
  const activeProcedures = useMemo(
    () => listActiveProcedures(procedureWorkspace),
    [procedureWorkspace],
  );
  const procedureMetadata = useMemo(() => ({
    procedureCount: activeProcedures.length,
    revision: procedureWorkspace.sequence > 0
      ? `${PROCEDURE_CATALOG_REVISION} · ${procedureWorkspace.revision}`
      : PROCEDURE_CATALOG_REVISION,
    contentHash: procedureWorkspace.contentHash,
  }), [activeProcedures.length, procedureWorkspace]);
  const snapshotRef = useRef(snapshot);
  const regulateRef = useRef(rail.regulate);
  const closeCircuitRef = useRef(rail.closeCircuit);
  const reopenCircuitRef = useRef(rail.reopenCircuit);
  snapshotRef.current = snapshot;
  regulateRef.current = rail.regulate;
  closeCircuitRef.current = rail.closeCircuit;
  reopenCircuitRef.current = rail.reopenCircuit;

  const requestToolApproval = useCallback<WebMcpApprovalHandler>((request, options) => {
    if (options?.signal?.aborted) {
      return {
        approved: false,
        reason: "The tool call was cancelled before operator review.",
      };
    }
    if (pendingApprovalRef.current) {
      return {
        approved: false,
        reason: "Another operator approval is already pending.",
      };
    }

    return new Promise<WebMcpApprovalDecision>((resolve) => {
      const signal = options?.signal;
      let timeoutId = 0;
      const finish = (decision: WebMcpApprovalDecision) => {
        if (pendingApprovalRef.current?.requestId !== request.id) return;
        window.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        pendingApprovalRef.current = null;
        setToolApproval(null);
        resolve(decision);
      };
      const onAbort = () => finish({
        approved: false,
        reason: "The tool call was cancelled before operator approval.",
      });
      timeoutId = window.setTimeout(() => finish({
        approved: false,
        reason: "Operator approval timed out after 90 seconds.",
      }), 90_000);
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingApprovalRef.current = { requestId: request.id, finish };
      setToolApproval(request);
    });
  }, []);

  const decideToolApproval = useCallback((approved: boolean) => {
    pendingApprovalRef.current?.finish({
      approved,
      reason: approved
        ? undefined
        : "The operator rejected this exact tool call.",
    });
  }, []);

  useEffect(() => {
    let active = true;
    let dispose: (() => Promise<void>) | undefined;
    void registerIccTools(
      () => snapshotRef.current,
      {
        regulate: (trainId, action) => regulateRef.current(trainId, action),
        schedules: scheduleWorkspace,
        setCircuitClosure: async (
          circuitId: string,
          command: CircuitClosureCommand,
        ) => projectCircuitClosureResult(
          await (command.kind === "close"
            ? closeCircuitRef.current(
                circuitId,
                command.reason,
                command.note,
              )
            : reopenCircuitRef.current(circuitId)),
        ),
        nativeNetwork: nativeNetwork.controller,
      },
      (activity) => {
        if (!active) return;
        setWebMcpActivity((current) => [
          activity,
          ...current.filter((item) => item.id !== activity.id),
        ].slice(0, 8));
      },
      requestToolApproval,
    )
      .then((registration) => {
        if (!active) return registration.dispose();
        dispose = registration.dispose;
        setWebMcpTools(registration.tools);
        setWebMcpAvailability({
          checked: true,
          supported: registration.supported,
          count: registration.count,
          names: registration.names,
        });
      })
      .catch((error: unknown) => {
        if (active) {
          console.error("WebMCP tool registration failed.", error);
          setWebMcpTools([]);
          setWebMcpAvailability({
            checked: true,
            supported: false,
            count: 0,
            names: [],
          });
        }
      });
    return () => {
      active = false;
      pendingApprovalRef.current?.finish({
        approved: false,
        reason: "The application closed before operator approval.",
      });
      if (dispose) void dispose();
    };
  }, [requestToolApproval]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const labels = {
      overview: "Network overview",
      "passenger-flow": "Passenger flow",
      simulator: "SimView",
      procedures: "Failure-management procedures",
      schedules: "Schedules & decisions",
      incidents: "Incident management",
      regulation: "Delays & regulation",
      power: "Electrical power supply",
      scada: "SCADA architecture",
      buses: "Bus continuity services",
      "rolling-stock": "Rolling stock",
      log: "Operations log",
      report: "End-of-shift report",
      detail: route.id ? `Operational record · ${route.id}` : "Operational record",
    };
    document.title = `${labels[route.page]} · Paris ICC - WebMCP DEMO`;
    if (!hasMountedRoute.current) {
      hasMountedRoute.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route.id, route.page]);

  const notify = (message: string) => setToast(message);
  const publishProcedureStep = useCallback(async (input: PublishProcedureStepInput) => {
    if (!operationsClient.getServerSnapshot()) {
      throw new Error("The server-authoritative procedure workspace is unavailable.");
    }
    const response = await operationsClient.command<
      Record<string, unknown>,
      { procedure?: { revision?: string } }
    >("update_procedure_step", input as unknown as Record<string, unknown>);
    const revision = response.result?.procedure?.revision;
    setToast(revision
      ? `Procedure step published as revision ${revision}`
      : "Procedure step revision published");
    return response.result;
  }, []);
  const closeCircuit = (
    circuitId: string,
    reason: "works" | "incident",
    note: string,
  ): void => {
    void rail.closeCircuit(circuitId, reason, note)
      .then((result) => notify(result.message))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "Circuit closure failed."));
  };
  const reopenCircuit = (circuitId: string): void => {
    void rail.reopenCircuit(circuitId)
      .then((result) => notify(result.message))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "Circuit reopening failed."));
  };
  const createSimulatorIncident = async (
    draft: SimulatorIncidentDraft,
  ): Promise<SimulatorIncidentCreationResult> => {
    if (draft.targetType === "power") {
      const result = await rail.scheduleIncident(draft);
      if (result.ok) notify(result.message);
      return result;
    }
    try {
      const incident = await nativeNetwork.createIncident({
        lineCode: draft.lineCode as NativeLineCode,
        target: { type: draft.targetType, id: draft.targetId },
        effect: draft.effect as NativeIncidentEffect,
        occurrenceTime: draft.occurrenceTime,
        title: draft.title,
        summary: draft.summary,
        type: draft.type,
        severity: draft.severity,
        speedLimitKmh: draft.speedLimitKmh,
        owner: "ICC simulation controller",
      });
      const result: SimulatorIncidentCreationResult = {
        ok: true,
        incidentId: incident.id,
        status: incident.status as "planned" | "active",
        message: incident.status === "planned"
          ? incident.id + " scheduled on the operational clock."
          : incident.id + " activated in the operational state.",
      };
      notify(result.message);
      return result;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "The incident could not be created.",
      };
    }
  };
  const inlineDecisionApproval =
    toolApproval?.toolName === "apply_reviewed_procedure_step" &&
    nativeDecisionIncidentId &&
    toolApproval.input.incidentId === nativeDecisionIncidentId
      ? toolApproval
      : null;

  return (
    <div id="text-text-application-shell" className={`app-shell${collapsed ? " app-shell--collapsed" : ""}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to operational content
      </a>
      <Sidebar currentPage={route.page} currentDetailType={route.detailType} snapshot={snapshot} collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
      <div className="app-workspace" id="text-text-application-workspace">
        <Topbar
          currentPage={route.page}
          snapshot={snapshot}
          speed={rail.state.speed}
          setSpeed={(speed) => {
            void (async () => {
              try {
                if (operationsClient.getServerSnapshot()) {
                  // One server command updates both simulation models atomically.
                  await rail.setSpeed(speed);
                } else {
                  await Promise.all([
                    rail.setSpeed(speed),
                    Promise.resolve(nativeNetwork.setSpeed(speed)),
                  ]);
                }
              } catch (error) {
                notify(error instanceof Error ? error.message : "Simulation speed could not be changed.");
              }
            })();
          }}
          onSelect={setSelection}
          onSource={() => setSelection({ type: "source", id: "source" })}
          onConfiguration={() => setConfigurationOpen(true)}
          configurationOpen={configurationOpen}
          onReset={() => {
            void (async () => {
              try {
                if (operationsClient.getServerSnapshot()) {
                  // reset_all restores traffic, native map and schedule workspace together.
                  await rail.reset();
                } else {
                  await Promise.all([
                    rail.reset(),
                    Promise.resolve(nativeNetwork.reset()),
                  ]);
                  await scheduleWorkspace.loadPlan(createSampleSchedulePlan());
                }
                setSelection(null);
                notify("Complete scenario reset: traffic 05:42 and D-1 sample plan restored");
              } catch (error) {
                notify(error instanceof Error ? error.message : "The scenario reset failed.");
              }
            })();
          }}
        />
        <main className="app-main" id="main-content" tabIndex={-1}>
          {route.page === "overview" && (
            <OverviewPage
              snapshot={snapshot}
              nativeSimulation={nativeNetwork.snapshot}
              operationalResponse={(operationsClient.getServerSnapshot() as unknown as { operationalResponse?: unknown } | null)?.operationalResponse}
              nativeIncidentId={route.nativeIncidentId}
              onIncidentActivate={setNativeDecisionIncidentId}
              onCreateIncident={createSimulatorIncident}
            />
          )}
          {route.page === "passenger-flow" && (
            <PassengerFlowPage simulation={nativeNetwork.snapshot} detailedSnapshot={snapshot} />
          )}
          {route.page === "simulator" && (
            <SimulatorPage
              snapshot={snapshot}
              nativeSimulation={nativeNetwork.snapshot}
              onSelect={setSelection}
              onInsertTrain={async (input) => {
                const receipt = await nativeNetwork.insertTrain(input);
                notify(`${receipt.train.id} inserted at ${receipt.stationId} · direction ${receipt.direction === 1 ? "outbound" : "inbound"}`);
                return receipt;
              }}
              onCreateIncident={createSimulatorIncident}
            />
          )}
          {route.page === "procedures" && (
            <ProceduresPage
              initialProcedureId={route.procedureId}
              procedures={activeProcedures}
              metadata={procedureMetadata}
              onPublishStep={serverSnapshot ? publishProcedureStep : undefined}
            />
          )}
          {route.page === "schedules" && <SchedulesPage snapshot={snapshot} onSelect={setSelection} />}
          {route.page === "incidents" && (
            <IncidentsPage
              snapshot={snapshot}
              nativeSimulation={nativeNetwork.snapshot}
              onSelect={setSelection}
            />
          )}
          {route.page === "regulation" && <RegulationPage nativeSimulation={nativeNetwork.snapshot} snapshot={snapshot} onSelect={setSelection} />}
          {route.page === "power" && <PowerPage snapshot={snapshot} onSelect={setSelection} />}
          {route.page === "scada" && (
            <ScadaPage
              simulation={nativeNetwork.snapshot}
              operationalResponse={(operationsClient.getServerSnapshot() as unknown as { operationalResponse?: unknown } | null)?.operationalResponse}
              onIncidentActivate={setNativeDecisionIncidentId}
            />
          )}
          {route.page === "buses" && (
            <BusServicesPage
              simulation={nativeNetwork.snapshot}
              operationalResponse={(operationsClient.getServerSnapshot() as unknown as { operationalResponse?: unknown } | null)?.operationalResponse}
              onIncidentActivate={setNativeDecisionIncidentId}
            />
          )}
          {route.page === "rolling-stock" && <RollingStockPage />}
          {route.page === "log" && operationsClient.getServerSnapshot()?.shift && (
            <OperationsLogPage shift={operationsClient.getServerSnapshot()!.shift} />
          )}
          {route.page === "report" && operationsClient.getServerSnapshot()?.shift && (
            <ShiftReportPage shift={operationsClient.getServerSnapshot()!.shift} />
          )}
          {route.page === "detail" && route.detailType && route.id && (
            <DetailPage
              type={route.detailType}
              id={route.id}
              snapshot={snapshot}
              onSelect={setSelection}
              onCloseCircuit={closeCircuit}
              onReopenCircuit={reopenCircuit}
            />
          )}
        </main>
      </div>

      {selection && (
        <EntityModal
          selection={selection}
          snapshot={snapshot}
          onClose={() => setSelection(null)}
          onIncidentStatus={(id, status) => {
            void rail.setIncidentStatus(id, status)
              .then(() => {
                setSelection(null);
                notify(`${id} · status ${status} recorded in the operational state`);
              })
              .catch((error: unknown) => notify(error instanceof Error ? error.message : "Incident status update failed."));
          }}
          onPower={(id, status) => {
            void rail.setPower(id, status)
              .then(() => {
                setSelection(null);
                notify(`${id} · ${status === "isolated" ? "isolation" : "power restoration"} recorded`);
              })
              .catch((error: unknown) => notify(error instanceof Error ? error.message : "Power status update failed."));
          }}
          onRegulate={(trainId, action) => {
            void rail.regulate(trainId, action)
              .then((result) => notify(result.message))
              .catch((error: unknown) => notify(error instanceof Error ? error.message : "Regulation action failed."));
          }}
          onCreateIncident={(input: NewIncidentInput) => {
            void rail.addIncident(input)
              .then((incident) => {
                setSelection(null);
                notify(`${incident.id} added to the operations log`);
              })
              .catch((error: unknown) => notify(error instanceof Error ? error.message : "Incident creation failed."));
          }}
          onCloseCircuit={closeCircuit}
          onReopenCircuit={reopenCircuit}
          onPassengerFeedMode={(mode) => rail.setPassengerFeedMode(mode)}
          onRefreshPassengerFeed={() => {
            void rail.refreshPassengerFeed().then((feed) => {
              notify(feed.status === "ready"
                ? `${feed.mode} refreshed · ${feed.observations.length} estimated calls`
                : feed.error ?? `${feed.mode} refresh completed with ${feed.status} status`);
            });
          }}
        />
      )}

      {configurationOpen && (
        <ConfigurationModal
          nativeSimulation={nativeNetwork.snapshot}
          detailedSimulation={rail.state}
          onImportConfiguration={async (configuration) => {
            if (operationsClient.getServerSnapshot()) {
              await operationsClient.command("import_configuration", {
                name: configuration.name,
                native: configuration.nativeSnapshot,
                detailed: configuration.detailedState,
              });
            } else {
              await Promise.all([
                Promise.resolve(nativeNetwork.controller.loadConfiguration(configuration.nativeSnapshot)),
                rail.loadConfiguration(configuration.detailedState),
              ]);
            }
            setSelection(null);
            notify(configuration.name + " installed as the simulation baseline");
          }}
          onClose={() => setConfigurationOpen(false)}
        />
      )}

      {nativeDecisionIncidentId && (
        <NativeIncidentDecisionModal
          incidentId={nativeDecisionIncidentId}
          simulation={nativeNetwork.snapshot}
          procedureCatalogueSequence={serverSnapshot?.procedureCatalogue?.sequence ?? 0}
          expectedToolNames={webMcpAvailability.names}
          inPageTools={webMcpTools}
          toolApproval={inlineDecisionApproval}
          onToolApprovalDecision={decideToolApproval}
          toolsPublished={
            webMcpAvailability.checked &&
            [
              "inspect_incident_decision_context",
              "search_operational_procedures",
              "get_operational_procedure",
              "apply_reviewed_procedure_step",
            ].every((name) =>
              webMcpAvailability.names.includes(name) &&
              webMcpTools.some((tool) => tool.name === name)
            )
          }
          onClose={() => {
            if (inlineDecisionApproval) decideToolApproval(false);
            setNativeDecisionIncidentId(null);
          }}
          onApplied={(message) => notify(message)}
        />
      )}

      {toolApproval && !inlineDecisionApproval && (
        <WebMcpApprovalDialog
          request={toolApproval}
          onDecision={decideToolApproval}
        />
      )}

      {toast && <div id="text-text-global-notification" className="toast" role="status"><span><Icon name="shield" size={17}/></span>{toast}</div>}
    </div>
  );
}

export default App;
