import { useEffect, useMemo, useSyncExternalStore } from "react";
import { operationsClient } from "../runtime/operationsClient";
import type {
  ProcedureCatalogueSnapshot,
  ProcedureExecutionSnapshot,
} from "../runtime/types";
import type { OperationalResponseState } from "../operations/operationalResponse";
import {
  createNativeNetworkController,
  type NativeApplyReviewedResult,
  type NativeIncident,
  type NativeIncidentInput,
  type NativeNetworkController,
  type NativeNetworkControllerOptions,
  type NativeResponseEvaluation,
  type NativeScenarioId,
  type NativeShuttleInsertionInput,
  type NativeShuttleInsertionReceipt,
  type NativeSimulationConfigurationState,
  type NativeSimulationSnapshot,
  type NativeSimulationSpeed,
  type NativeTrainInsertionInput,
  type NativeTrainInsertionReceipt,
} from "./nativeSimulation";

export type Awaitable<T> = T | Promise<T>;

export const NATIVE_BROWSER_FALLBACK_TICK_INTERVAL_MS = 1_000;

export interface NativeNetworkControllerFacade {
  getSnapshot: () => NativeSimulationSnapshot;
  subscribe: (listener: () => void) => () => void;
  tick: () => Awaitable<NativeSimulationSnapshot>;
  reset: () => Awaitable<NativeSimulationSnapshot>;
  setSpeed: (speed: NativeSimulationSpeed) => Awaitable<NativeSimulationSnapshot>;
  activateScenario: (scenarioId: NativeScenarioId) => Awaitable<NativeSimulationSnapshot>;
  loadConfiguration: (
    configuration: NativeSimulationConfigurationState,
  ) => Awaitable<NativeSimulationSnapshot>;
  createIncident: (input: NativeIncidentInput) => Awaitable<NativeIncident>;
  insertTrain: (input: NativeTrainInsertionInput) => Awaitable<NativeTrainInsertionReceipt>;
  insertShuttle: (input: NativeShuttleInsertionInput) => Awaitable<NativeShuttleInsertionReceipt>;
  evaluateResponse: (input: { incidentId: string }) => Awaitable<NativeResponseEvaluation>;
  applyReviewedOption: (input: {
    evaluationId: string;
    optionId: string;
    expectedDecisionRevision: number;
  }) => Awaitable<NativeApplyReviewedResult>;
  applyProcedureStep?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  getProcedureExecutions?: () => readonly ProcedureExecutionSnapshot[];
  getProcedureCatalogue?: () => ProcedureCatalogueSnapshot | undefined;
  getOperationalResponse?: () => OperationalResponseState | undefined;
}

export interface UseNativeNetworkSimulationOptions extends NativeNetworkControllerOptions {
  autoTick?: boolean;
  tickIntervalMs?: number;
}

function commandSnapshot(
  result: { snapshot?: { native: NativeSimulationSnapshot } },
  fallback: () => NativeSimulationSnapshot,
): NativeSimulationSnapshot {
  return result.snapshot?.native ?? fallback();
}

export function useNativeNetworkSimulation(
  options: UseNativeNetworkSimulationOptions = {},
) {
  const {
    autoTick = true,
    tickIntervalMs = NATIVE_BROWSER_FALLBACK_TICK_INTERVAL_MS,
    scenarioId,
    speed,
    startTimestamp,
  } = options;
  const localController = useMemo<NativeNetworkController>(
    () => createNativeNetworkController({ scenarioId, speed, startTimestamp }),
    [scenarioId, speed, startTimestamp],
  );
  const localSnapshot = useSyncExternalStore(
    localController.subscribe,
    localController.getSnapshot,
    localController.getSnapshot,
  );
  const operationsState = useSyncExternalStore(
    operationsClient.subscribe,
    operationsClient.getSnapshot,
    operationsClient.getSnapshot,
  );
  const remoteSnapshot = operationsState.serverSnapshot?.native ?? null;
  const remoteEnabled = operationsState.serverSnapshot !== null;

  useEffect(() => {
    if (!autoTick || remoteSnapshot) return undefined;
    const interval = Math.max(100, Math.round(tickIntervalMs));
    const timer = window.setInterval(localController.tick, interval);
    return () => window.clearInterval(timer);
  }, [autoTick, localController, remoteSnapshot, tickIntervalMs]);

  const controller = useMemo<NativeNetworkControllerFacade>(() => {
    const getSnapshot = () =>
      operationsClient.getServerSnapshot()?.native ?? localController.getSnapshot();
    const getRuntime = () => operationsClient.getServerSnapshot();

    return {
      getSnapshot,
      subscribe: (listener) => {
        const unsubscribeRemote = operationsClient.subscribe(listener);
        const unsubscribeLocal = localController.subscribe(listener);
        return () => {
          unsubscribeRemote();
          unsubscribeLocal();
        };
      },
      tick: () => getRuntime() ? getSnapshot() : localController.tick(),
      reset: async () => {
        if (!getRuntime()) return localController.reset();
        const result = await operationsClient.command("reset_all", {});
        return commandSnapshot(result, getSnapshot);
      },
      setSpeed: async (nextSpeed) => {
        if (!getRuntime()) return localController.setSpeed(nextSpeed);
        const result = await operationsClient.command("set_speed", { speed: nextSpeed });
        return commandSnapshot(result, getSnapshot);
      },
      activateScenario: async (nextScenario) => {
        if (!getRuntime()) return localController.activateScenario(nextScenario);
        const result = await operationsClient.command("activate_native_scenario", {
          scenarioId: nextScenario,
        });
        return commandSnapshot(result, getSnapshot);
      },
      loadConfiguration: async (configuration) => {
        const runtime = getRuntime();
        if (!runtime) return localController.loadConfiguration(configuration);
        const result = await operationsClient.command("import_configuration", {
          name: configuration.scenarioName,
          native: configuration,
          detailed: runtime.detailed,
        });
        return commandSnapshot(result, getSnapshot);
      },
      createIncident: async (input) => {
        if (!getRuntime()) return localController.createIncident(input);
        const result = await operationsClient.command<
          Record<string, unknown>,
          { incident: NativeIncident }
        >("create_native_incident", input as unknown as Record<string, unknown>);
        const incident = result.result?.incident;
        if (!incident) throw new Error("The server did not return the created incident.");
        return incident;
      },
      insertTrain: async (input) => {
        if (!getRuntime()) return localController.insertTrain(input);
        const result = await operationsClient.command<
          Record<string, unknown>,
          { insertion: NativeTrainInsertionReceipt }
        >("insert_native_train", input as unknown as Record<string, unknown>);
        const insertion = result.result?.insertion;
        if (!insertion) throw new Error("The server did not return the train-insertion receipt.");
        return insertion;
      },
      insertShuttle: async (input) => {
        if (!getRuntime()) return localController.insertShuttle(input);
        const result = await operationsClient.command<
          Record<string, unknown>,
          { insertion: NativeShuttleInsertionReceipt }
        >("insert_native_shuttle", input as unknown as Record<string, unknown>);
        const insertion = result.result?.insertion;
        if (!insertion) throw new Error("The server did not return the shuttle-insertion receipt.");
        return insertion;
      },
      evaluateResponse: async (input) => {
        if (!getRuntime()) return localController.evaluateResponse(input);
        const result = await operationsClient.command<
          Record<string, unknown>,
          { evaluation: NativeResponseEvaluation }
        >("evaluate_native_response", input);
        const evaluation = result.result?.evaluation;
        if (!evaluation) throw new Error("The server did not return the response evaluation.");
        return evaluation;
      },
      applyReviewedOption: async (input) => {
        if (!getRuntime()) return localController.applyReviewedOption(input);
        const result = await operationsClient.command<
          Record<string, unknown>,
          { applied: NativeApplyReviewedResult }
        >("apply_native_response", input);
        const applied = result.result?.applied;
        if (!applied) throw new Error("The server did not return the reviewed action receipt.");
        return applied;
      },
      ...(remoteEnabled ? {
        applyProcedureStep: async (input: Record<string, unknown>) => {
          const result = await operationsClient.command<Record<string, unknown>, Record<string, unknown>>(
            "apply_procedure_step",
            input,
          );
          if (!result.result) throw new Error("The server did not return the procedure-step receipt.");
          return result.result;
        },
        getProcedureExecutions: () =>
          operationsClient.getServerSnapshot()?.procedureExecutions ?? [],
        getProcedureCatalogue: () =>
          operationsClient.getServerSnapshot()?.procedureCatalogue,
        getOperationalResponse: () =>
          operationsClient.getServerSnapshot()?.operationalResponse,
      } : {}),
    };
  }, [localController, remoteEnabled]);

  const snapshot = remoteSnapshot ?? localSnapshot;
  return {
    controller,
    snapshot,
    tick: controller.tick,
    reset: controller.reset,
    setSpeed: controller.setSpeed,
    activateScenario: controller.activateScenario,
    createIncident: controller.createIncident,
    insertTrain: controller.insertTrain,
    insertShuttle: controller.insertShuttle,
    evaluateResponse: controller.evaluateResponse,
    applyReviewedOption: controller.applyReviewedOption,
  };
}
