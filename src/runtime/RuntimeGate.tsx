import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { Icon } from "../components/Icon";
import { operationsClient } from "./operationsClient";

export interface AgentPreset {
  id: string;
  label: string;
  prompt: string;
}

export interface PublicRuntimeConfiguration {
  authenticated: boolean;
  application: {
    name: string;
    environment: string;
    dataMode: string;
  };
  agent: {
    enabled: boolean;
    model: string | null;
    reasoningEffort: string | null;
    maxToolRounds: number;
    presets: AgentPreset[];
  };
  prim: {
    enabled: boolean;
  };
  developmentBypass?: boolean;
}

interface RuntimeContextValue {
  configuration: PublicRuntimeConfiguration;
  signOut: () => Promise<void>;
  updateAgentConfiguration: (model: string, reasoningEffort: string | null) => void;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

const DEVELOPMENT_CONFIGURATION: PublicRuntimeConfiguration = {
  authenticated: true,
  application: {
    name: "Paris ICC",
    environment: "vite-development",
    dataMode: "local-simulation",
  },
  agent: {
    enabled: false,
    model: null,
    reasoningEffort: null,
    maxToolRounds: 8,
    presets: [],
  },
  prim: { enabled: false },
  developmentBypass: true,
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readConfiguration(response: Response): Promise<PublicRuntimeConfiguration> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(response.status, "The Paris ICC server returned an unreadable response.");
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body &&
      typeof body.message === "string"
      ? body.message
      : "The Paris ICC server rejected this request.";
    throw new ApiError(response.status, message);
  }
  return body as PublicRuntimeConfiguration;
}

function AccessScreen({
  onAuthenticated,
}: {
  onAuthenticated: (configuration: PublicRuntimeConfiguration) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const configuration = await readConfiguration(response);
      setCode("");
      onAuthenticated(configuration);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Access could not be verified.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="access-screen" id="text-text-access-page">
      <section className="access-card" id="text-text-access-card" aria-labelledby="access-title">
        <div className="access-card__brand" id="text-text-access-brand">
          <span className="access-card__mark"><b>P</b><small>ICC</small></span>
          <div><strong>Paris ICC</strong><span>Rail incident decision support</span></div>
        </div>
        <div className="access-card__intro" id="text-text-access-introduction">
          <span className="access-card__eyebrow"><i /> OPERATIONAL SIMULATION</span>
          <h1 id="access-title">Enter the shared access code</h1>
          <p>
            Open the Paris rail operational simulation and its embedded WebMCP
            decision-support agent.
          </p>
        </div>
        <form id="text-text-access-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="access-code">Access code</label>
          <div className="access-card__input">
            <Icon name="shield" size={18} />
            <input
              id="access-code"
              type="password"
              autoComplete="current-password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Enter access code"
              autoFocus
            />
          </div>
          {error && <p className="access-card__error" role="alert"><Icon name="alert" size={15} />{error}</p>}
          <button type="submit" className="button button--primary" disabled={busy || !code.trim()}>
            {busy ? "Verifying…" : "Open operations canvas"}
            {!busy && <Icon name="arrow" size={16} />}
          </button>
        </form>
        <footer id="text-text-access-security-summary">
          <span><Icon name="shield" size={14} /> Secure server session</span>
          <span><Icon name="activity" size={14} /> Operational simulation data</span>
          <span><Icon name="radio" size={14} /> Native WebMCP tools</span>
        </footer>
      </section>
    </main>
  );
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <main className="access-screen" id="text-text-loading-page">
      <div className="access-loading" id="text-text-loading-status" role="status">
        <span><Icon name="network" size={24} /></span>
        <strong>{message}</strong>
      </div>
    </main>
  );
}

export function RuntimeGate({ children }: { children: ReactNode }) {
  const [configuration, setConfiguration] = useState<PublicRuntimeConfiguration | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const operationsState = useSyncExternalStore(
    operationsClient.subscribe,
    operationsClient.getSnapshot,
    operationsClient.getSnapshot,
  );

  useEffect(() => {
    const controller = new AbortController();
    setUnavailable(null);
    if (import.meta.env.DEV) {
      setConfiguration(DEVELOPMENT_CONFIGURATION);
      return () => controller.abort();
    }
    void fetch("/api/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(readConfiguration)
      .then(setConfiguration)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setUnavailable(error instanceof Error ? error.message : "The server is unavailable.");
      });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!configuration?.authenticated || configuration.developmentBypass) return;
    void operationsClient.bootstrap().catch(() => undefined);
  }, [configuration]);

  if (unavailable) {
    return (
      <main className="access-screen" id="text-text-unavailable-page">
        <section className="access-card access-card--error" id="text-text-unavailable-card">
          <span className="access-card__error-icon"><Icon name="alert" size={24} /></span>
          <h1>Paris ICC is temporarily unavailable</h1>
          <p>{unavailable}</p>
          <button type="button" className="button button--primary" onClick={() => setRetry((value) => value + 1)}>
            Retry connection
          </button>
        </section>
      </main>
    );
  }
  if (!configuration) return <LoadingScreen message="Opening secure operations session…" />;
  if (!configuration.authenticated) {
    return <AccessScreen onAuthenticated={setConfiguration} />;
  }
  if (!configuration.developmentBypass && !operationsState.serverSnapshot) {
    if (operationsState.status === "error") {
      return (
        <main className="access-screen" id="text-text-state-error-page">
          <section className="access-card access-card--error" id="text-text-state-error-card">
            <span className="access-card__error-icon"><Icon name="alert" size={24} /></span>
            <h1>Operational state is unavailable</h1>
            <p>{operationsState.error.message}</p>
            <button type="button" className="button button--primary" onClick={() => void operationsClient.bootstrap()}>
              Retry state connection
            </button>
          </section>
        </main>
      );
    }
    return <LoadingScreen message="Restoring the persistent operations state…" />;
  }

  const signOut = async () => {
    if (configuration.developmentBypass) return;
    operationsClient.close();
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    setConfiguration({ ...configuration, authenticated: false });
  };

  const updateAgentConfiguration = (model: string, reasoningEffort: string | null) => {
    setConfiguration((current) => current ? {
      ...current,
      agent: { ...current.agent, model, reasoningEffort },
    } : current);
  };

  return (
    <RuntimeContext.Provider value={{ configuration, signOut, updateAgentConfiguration }}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntimeConfiguration(): RuntimeContextValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("Runtime configuration is unavailable outside RuntimeGate.");
  return value;
}
