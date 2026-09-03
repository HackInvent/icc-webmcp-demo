import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  OperationsClientError,
  operationsClient,
} from "../runtime/operationsClient";
import type {
  CircuitClosureRejectionReason,
  CircuitClosureReason,
  IncidentStatus,
  NewIncidentInput,
  PassengerFeedMode,
  SimulationState,
} from "./domain";
import type {
  SimulatorIncidentCreationResult,
  SimulatorIncidentDraft,
} from "./simulatorIncident";
import {
  DEFAULT_PRIM_PROXY_ENDPOINT,
  emptyPassengerFeed,
  loadPassengerFeed,
} from "./prim/feed";
import {
  addDemoIncident,
  advanceSimulation,
  assertSnapshotInvariants,
  applyRegulation,
  closeCircuit as closeCircuitInState,
  createSimulationState,
  reopenCircuit as reopenCircuitInState,
  resetSimulation,
  schedulePowerIncident as schedulePowerIncidentInState,
  setPowerStatus,
  setSimulationSpeed,
  updateIncidentStatus,
} from "./simulation";

const DECISION_REVISION_STORAGE_KEY = "paris-icc.rail-decision-revision.v1";
export const RAIL_BROWSER_FALLBACK_TICK_INTERVAL_MS = 1_000;

const CIRCUIT_REJECTION_REASONS = new Set<CircuitClosureRejectionReason>([
  "not_found",
  "occupied",
  "blocked",
  "already_closed",
  "already_open",
  "invalid_note",
  "invalid_reference",
  "live_forbidden",
]);

function circuitRejectionReason(error: unknown): CircuitClosureRejectionReason {
  if (
    error instanceof OperationsClientError &&
    CIRCUIT_REJECTION_REASONS.has(error.code as CircuitClosureRejectionReason)
  ) {
    return error.code as CircuitClosureRejectionReason;
  }
  return "blocked";
}

function storeDecisionRevision(decisionRevision: number): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      DECISION_REVISION_STORAGE_KEY,
      String(decisionRevision),
    );
  } catch {
    // The in-memory monotonic guard remains active when storage is unavailable.
  }
}

function createBrowserSimulationState(): SimulationState {
  const initial = createSimulationState();
  if (typeof window === "undefined") return initial;
  let decisionRevision = initial.snapshot.decisionRevision;
  try {
    const stored = Number(window.sessionStorage.getItem(DECISION_REVISION_STORAGE_KEY));
    if (
      Number.isSafeInteger(stored) &&
      stored >= decisionRevision &&
      stored < Number.MAX_SAFE_INTEGER
    ) {
      decisionRevision = stored + 1;
    }
  } catch {
    // Use the deterministic initial revision when storage is unavailable.
  }
  storeDecisionRevision(decisionRevision);
  return decisionRevision === initial.snapshot.decisionRevision
    ? initial
    : {
        ...initial,
        snapshot: { ...initial.snapshot, decisionRevision },
      };
}

function cloneSimulationState(state: SimulationState): SimulationState {
  return JSON.parse(JSON.stringify(state)) as SimulationState;
}

export function useRailSimulation() {
  const [state, setState] = useState<SimulationState>(() => createBrowserSimulationState());
  const [passengerFeedMode, setPassengerFeedModeState] = useState<PassengerFeedMode>("prim-replay");
  const [passengerFeed, setPassengerFeed] = useState(() => emptyPassengerFeed("prim-replay"));
  const operationsState = useSyncExternalStore(
    operationsClient.subscribe,
    operationsClient.getSnapshot,
    operationsClient.getSnapshot,
  );
  const serverState = operationsState.serverSnapshot?.detailed ?? null;
  const effectiveState = serverState ?? state;
  const stateRef = useRef(effectiveState);
  stateRef.current = effectiveState;
  const importedBaselineRef = useRef<SimulationState | null>(null);
  const passengerFeedRequestRef = useRef(0);
  const primEndpoint = import.meta.env.VITE_PRIM_PROXY_URL?.trim() || DEFAULT_PRIM_PROXY_ENDPOINT;
  const updateState = useCallback((transition: (current: SimulationState) => SimulationState) => {
    const currentState = stateRef.current;
    const nextState = transition(currentState);
    if (nextState.snapshot.decisionRevision !== currentState.snapshot.decisionRevision) {
      storeDecisionRevision(nextState.snapshot.decisionRevision);
    }
    stateRef.current = nextState;
    setState(nextState);
    return nextState;
  }, []);

  const refreshPassengerFeed = useCallback(async (
    mode: PassengerFeedMode = passengerFeedMode,
    signal?: AbortSignal,
  ) => {
    passengerFeedRequestRef.current += 1;
    const requestId = passengerFeedRequestRef.current;
    if (mode === "simulation") {
      const disabled = emptyPassengerFeed(mode);
      setPassengerFeed(disabled);
      return disabled;
    }
    setPassengerFeed((current) => ({
      ...current,
      mode,
      status: "loading",
      error: null,
    }));
    const result = await loadPassengerFeed({
      mode,
      snapshot: stateRef.current.snapshot,
      endpoint: primEndpoint,
      signal,
    });
    if (!signal?.aborted && requestId === passengerFeedRequestRef.current) {
      setPassengerFeed(result);
    }
    return result;
  }, [passengerFeedMode, primEndpoint]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshPassengerFeed(passengerFeedMode, controller.signal);
    if (passengerFeedMode === "simulation") return () => controller.abort();
    const refreshInterval = passengerFeedMode === "prim-live" ? 60_000 : 30_000;
    const timer = window.setInterval(() => {
      void refreshPassengerFeed(passengerFeedMode, controller.signal);
    }, refreshInterval);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [passengerFeedMode, refreshPassengerFeed]);

  useEffect(() => {
    if (serverState) return undefined;
    const timer = window.setInterval(() => {
      updateState(advanceSimulation);
    }, RAIL_BROWSER_FALLBACK_TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [serverState, updateState]);

  const enrichedState = useMemo<SimulationState>(() => ({
    ...effectiveState,
    snapshot: {
      ...effectiveState.snapshot,
      passengerFeed,
    },
  }), [effectiveState, passengerFeed]);

  return {
    state: enrichedState,
    passengerFeedMode,
    setPassengerFeedMode: (mode: PassengerFeedMode) => setPassengerFeedModeState(mode),
    refreshPassengerFeed: () => refreshPassengerFeed(passengerFeedMode),
    setSpeed: async (speed: SimulationState["speed"]) => {
      if (operationsClient.getServerSnapshot()) {
        const result = await operationsClient.command("set_speed", { speed });
        return result.snapshot?.detailed ?? stateRef.current;
      }
      return updateState((current) => setSimulationSpeed(current, speed));
    },
    reset: async () => {
      if (operationsClient.getServerSnapshot()) {
        const result = await operationsClient.command("reset_all", {});
        return result.snapshot?.detailed ?? stateRef.current;
      }
      return updateState((current) => {
        if (!importedBaselineRef.current) return resetSimulation(current);
        const baseline = cloneSimulationState(importedBaselineRef.current);
        return {
          ...baseline,
          snapshot: {
            ...baseline.snapshot,
            decisionRevision: current.snapshot.decisionRevision + 1,
          },
        };
      });
    },
    loadConfiguration: async (configuration: SimulationState) => {
      const baseline = cloneSimulationState(configuration);
      assertSnapshotInvariants(baseline.snapshot);
      const runtime = operationsClient.getServerSnapshot();
      if (runtime) {
        const result = await operationsClient.command("import_configuration", {
          name: baseline.snapshot.scenarioName,
          native: runtime.native,
          detailed: baseline,
        });
        return result.snapshot?.detailed ?? stateRef.current;
      }
      importedBaselineRef.current = baseline;
      return updateState((current) => ({
        ...cloneSimulationState(baseline),
        snapshot: {
          ...cloneSimulationState(baseline).snapshot,
          decisionRevision: current.snapshot.decisionRevision + 1,
        },
      }));
    },
    setIncidentStatus: async (id: string, status: IncidentStatus) => {
      if (operationsClient.getServerSnapshot()) {
        const result = await operationsClient.command(
          "set_detailed_incident_status",
          { id, status },
        );
        return result.snapshot?.detailed ?? stateRef.current;
      }
      return updateState((current) => updateIncidentStatus(current, id, status));
    },
    setPower: async (id: string, status: "energized" | "isolated") => {
      if (operationsClient.getServerSnapshot()) {
        const result = await operationsClient.command("set_power_status", { id, status });
        return result.snapshot?.detailed ?? stateRef.current;
      }
      return updateState((current) => setPowerStatus(current, id, status));
    },
    regulate: async (
      trainId: string,
      action: "priority" | "hold" | "turnback",
    ) => {
      if (operationsClient.getServerSnapshot()) {
        try {
          const result = await operationsClient.command<
            Record<string, unknown>,
            { message: string }
          >("regulate_train", { trainId, action });
          return {
            ok: true,
            message: result.result?.message ??
              (trainId + " · action " + action + " applied"),
          };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : "Regulation was rejected.",
          };
        }
      }
      const before = stateRef.current;
      const next = updateState((current) => applyRegulation(current, trainId, action));
      if (next === before) {
        return { ok: false, message: trainId + " is not present in the current simulation." };
      }
      const latest = next.snapshot.events[0];
      const rejected = latest?.kind === "regulation" && latest.title.includes("rejected");
      return {
        ok: !rejected,
        message: rejected
          ? latest.detail
          : trainId + " · action " + action + " applied to the simulation",
      };
    },
    addIncident: async (input: NewIncidentInput) => {
      if (operationsClient.getServerSnapshot()) {
        const result = await operationsClient.command<
          Record<string, unknown>,
          { incident: SimulationState["snapshot"]["incidents"][number] }
        >("add_detailed_incident", input as unknown as Record<string, unknown>);
        if (!result.result?.incident) throw new Error("The server did not return the incident.");
        return result.result.incident;
      }
      const next = updateState((current) => addDemoIncident(current, input));
      return next.snapshot.incidents[0];
    },
    scheduleIncident: async (
      draft: SimulatorIncidentDraft,
    ): Promise<SimulatorIncidentCreationResult> => {
      try {
        let incident: SimulationState["snapshot"]["incidents"][number] | undefined;
        if (operationsClient.getServerSnapshot()) {
          const result = await operationsClient.command<
            Record<string, unknown>,
            { incident: SimulationState["snapshot"]["incidents"][number] }
          >("schedule_power_incident", draft as unknown as Record<string, unknown>);
          incident = result.result?.incident;
        } else {
          const next = updateState((current) =>
            schedulePowerIncidentInState(current, draft),
          );
          incident = next.snapshot.incidents[0];
        }
        if (!incident || (incident.status !== "planned" && incident.status !== "active")) {
          return {
            ok: false,
            message: "The simulator did not create the requested power incident.",
          };
        }
        return {
          ok: true,
          incidentId: incident.id,
          status: incident.status,
          message: incident.status === "planned"
            ? incident.id + " scheduled on the simulation clock."
            : incident.id + " activated in the simulation.",
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error
            ? error.message
            : "The power incident could not be scheduled.",
        };
      }
    },
    closeCircuit: async (
      circuitId: string,
      reason: CircuitClosureReason,
      note?: string,
      reference?: string,
    ) => {
      if (operationsClient.getServerSnapshot()) {
        try {
          const result = await operationsClient.command<
            Record<string, unknown>,
            {
              action: "close";
              outcome: "closed";
              circuitId: string;
              message: string;
            }
          >("close_circuit", { circuitId, reason, note, reference });
          const nextState = result.snapshot?.detailed ?? stateRef.current;
          return {
            ok: true as const,
            action: "close" as const,
            outcome: "closed" as const,
            circuitId,
            message: result.result?.message ?? (circuitId + " closed."),
            nextState,
          };
        } catch (error) {
          return {
            ok: false as const,
            action: "close" as const,
            reason: circuitRejectionReason(error),
            circuitId,
            message: error instanceof Error ? error.message : "Circuit closure rejected.",
            nextState: stateRef.current,
          };
        }
      }
      const result = closeCircuitInState(stateRef.current, circuitId, reason, note, reference);
      if (result.ok) updateState(() => result.nextState);
      return result;
    },
    reopenCircuit: async (circuitId: string) => {
      if (operationsClient.getServerSnapshot()) {
        try {
          const result = await operationsClient.command<
            Record<string, unknown>,
            {
              action: "reopen";
              outcome: "reopened";
              circuitId: string;
              message: string;
            }
          >("reopen_circuit", { circuitId });
          const nextState = result.snapshot?.detailed ?? stateRef.current;
          return {
            ok: true as const,
            action: "reopen" as const,
            outcome: "reopened" as const,
            circuitId,
            message: result.result?.message ?? (circuitId + " reopened."),
            nextState,
          };
        } catch (error) {
          return {
            ok: false as const,
            action: "reopen" as const,
            reason: circuitRejectionReason(error),
            circuitId,
            message: error instanceof Error ? error.message : "Circuit reopening rejected.",
            nextState: stateRef.current,
          };
        }
      }
      const result = reopenCircuitInState(stateRef.current, circuitId);
      if (result.ok) updateState(() => result.nextState);
      return result;
    },
  };
}
