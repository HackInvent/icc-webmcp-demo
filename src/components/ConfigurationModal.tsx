import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SimulationState } from "../rail/domain";
import type { NativeSimulationSnapshot } from "../rail/nativeSimulation";
import {
  parseSimulationConfiguration,
  serializeSimulationConfiguration,
  type ParsedSimulationConfiguration,
} from "../rail/simulationConfiguration";
import { useRuntimeConfiguration } from "../runtime/RuntimeGate";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

type ConfigurationTab = "agent" | "simulator" | "log";
type FeedbackTone = "success" | "error";

interface AgentConfiguration {
  enabled: boolean;
  model: string | null;
  defaultModel: string | null;
  allowedModels: string[];
  reasoningEffort: string | null;
  updatedAt: string | null;
}

interface ConfigurationResponse {
  agent: AgentConfiguration;
  log: {
    count: number;
    downloadUrl: string;
  };
}

interface AgentLogResponse {
  entries: Array<Record<string, unknown>>;
  total: number;
}

interface ConfigurationModalProps {
  nativeSimulation: NativeSimulationSnapshot;
  detailedSimulation: SimulationState;
  onImportConfiguration: (configuration: ParsedSimulationConfiguration) => void | Promise<void>;
  onClose: () => void;
}

const TABS: ReadonlyArray<{ id: ConfigurationTab; label: string; icon: "radio" | "settings" | "activity" }> = [
  { id: "agent", label: "Agent", icon: "radio" },
  { id: "simulator", label: "Simulator configuration", icon: "settings" },
  { id: "log", label: "Agent log", icon: "activity" },
];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    // Preserve the status-based fallback when the server returns no JSON body.
  }
  return `The server rejected the request (${response.status}).`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as T;
}

function normalizeAgentConfiguration(
  value: Partial<AgentConfiguration> | undefined,
  fallback: AgentConfiguration,
): AgentConfiguration {
  const model = typeof value?.model === "string" && value.model.trim() ? value.model.trim() : fallback.model;
  const allowedModels = Array.isArray(value?.allowedModels)
    ? value.allowedModels.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : fallback.allowedModels;
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : fallback.enabled,
    model,
    defaultModel: typeof value?.defaultModel === "string" ? value.defaultModel : fallback.defaultModel,
    allowedModels: [...new Set([...(model ? [model] : []), ...allowedModels])],
    reasoningEffort: typeof value?.reasoningEffort === "string" ? value.reasoningEffort : fallback.reasoningEffort,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

function recordText(entry: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function formatLogTime(value: unknown): string {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatDuration(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function formatTokens(entry: Record<string, unknown>): string {
  const input = entry.inputTokens;
  const output = entry.outputTokens;
  if (typeof input !== "number" && typeof output !== "number") return "—";
  return `${typeof input === "number" ? input.toLocaleString("en-GB") : "—"} / ${typeof output === "number" ? output.toLocaleString("en-GB") : "—"}`;
}

export function ConfigurationModal({
  nativeSimulation,
  detailedSimulation,
  onImportConfiguration,
  onClose,
}: ConfigurationModalProps) {
  const { configuration: runtime, updateAgentModel } = useRuntimeConfiguration();
  const [activeTab, setActiveTab] = useState<ConfigurationTab>("agent");
  const [configuration, setConfiguration] = useState<ConfigurationResponse | null>(null);
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(runtime.agent.model ?? "");
  const [savingModel, setSavingModel] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [transferFeedback, setTransferFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ fileName: string; configuration: ParsedSimulationConfiguration } | null>(null);
  const [log, setLog] = useState<AgentLogResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const runtimeFallback: AgentConfiguration = {
    enabled: runtime.agent.enabled,
    model: runtime.agent.model,
    defaultModel: runtime.agent.model,
    allowedModels: runtime.agent.model ? [runtime.agent.model] : [],
    reasoningEffort: null,
    updatedAt: null,
  };
  const agent = configuration?.agent ?? runtimeFallback;
  const downloadUrl = configuration?.log.downloadUrl || "/api/agent/log/download";

  useEffect(() => {
    const controller = new AbortController();
    setConfigurationLoading(true);
    void fetchJson<ConfigurationResponse>("/api/configuration", { signal: controller.signal })
      .then((response) => {
        const normalized = normalizeAgentConfiguration(response.agent, runtimeFallback);
        setConfiguration({ ...response, agent: normalized });
        setSelectedModel(normalized.model ?? "");
        setConfigurationError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setConfigurationError(errorMessage(error, "Configuration service is unavailable."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setConfigurationLoading(false);
      });
    return () => controller.abort();
  }, []);

  const loadLog = async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      const response = await fetchJson<AgentLogResponse>("/api/agent/log?limit=200");
      const total = typeof response.total === "number" ? response.total : 0;
      setLog({
        entries: Array.isArray(response.entries) ? response.entries : [],
        total,
      });
      setConfiguration((current) => current ? {
        ...current,
        log: { ...current.log, count: total },
      } : current);
    } catch (error) {
      setLogError(errorMessage(error, "The agent log is unavailable."));
    } finally {
      setLogLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "log" && !log && !logLoading) void loadLog();
  }, [activeTab]);

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const saveModel = async () => {
    if (!selectedModel || savingModel || !configuration) return;
    setSavingModel(true);
    setModelFeedback(null);
    try {
      const response = await fetchJson<ConfigurationResponse | { agent: AgentConfiguration }>("/api/configuration/agent", {
        method: "PUT",
        body: JSON.stringify({ model: selectedModel }),
      });
      const normalized = normalizeAgentConfiguration(response.agent, agent);
      setConfiguration((current) => current ? { ...current, agent: normalized } : {
        agent: normalized,
        log: { count: 0, downloadUrl: "/api/agent/log/download" },
      });
      setSelectedModel(normalized.model ?? selectedModel);
      updateAgentModel(normalized.model ?? selectedModel);
      setModelFeedback({ tone: "success", message: `${normalized.model ?? selectedModel} will be used for the next agent run.` });
    } catch (error) {
      setModelFeedback({ tone: "error", message: errorMessage(error, "The model could not be updated.") });
    } finally {
      setSavingModel(false);
    }
  };

  const exportConfiguration = () => {
    const contents = serializeSimulationConfiguration(nativeSimulation, detailedSimulation);
    const blob = new Blob([contents], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date(nativeSimulation.timestamp).toISOString().slice(0, 19).replaceAll(":", "-");
    anchor.href = url;
    anchor.download = `paris-icc-simulation-${date}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setTransferFeedback({ tone: "success", message: "Current simulator baseline exported as validated JSON." });
  };

  const selectImportConfiguration = async (file: File) => {
    setImporting(true);
    setPendingImport(null);
    setTransferFeedback(null);
    try {
      const parsed = parseSimulationConfiguration(await file.text());
      setPendingImport({ fileName: file.name, configuration: parsed });
      setTransferFeedback({
        tone: "success",
        message: `${parsed.name} passed schema and operational-state validation. Review it before installation.`,
      });
    } catch (error) {
      setTransferFeedback({ tone: "error", message: errorMessage(error, "The configuration could not be imported.") });
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const installImportConfiguration = async () => {
    if (!pendingImport || importing) return;
    setImporting(true);
    setTransferFeedback(null);
    try {
      await onImportConfiguration(pendingImport.configuration);
      setTransferFeedback({
        tone: "success",
        message: `${pendingImport.configuration.name} installed as the new Reset baseline.`,
      });
      setPendingImport(null);
    } catch (error) {
      setTransferFeedback({ tone: "error", message: errorMessage(error, "The validated baseline could not be installed.") });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      contentId="text-text-modal-configuration"
      title="Application configuration"
      eyebrow="SERVER-HOSTED AGENT · OPERATIONAL BASELINE"
      onClose={onClose}
      wide
    >
      <div className="configuration-workspace" data-testid="configuration-modal">
        <nav className="configuration-tabs" id="text-text-configuration-tabs" role="tablist" aria-label="Configuration sections">
          {TABS.map((tab, index) => (
            <button
              key={tab.id}
              ref={(element) => { tabRefs.current[index] = element; }}
              id={`configuration-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`configuration-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={activeTab === tab.id ? "is-active" : ""}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => moveTabFocus(event, index)}
            >
              <Icon name={tab.icon} size={16} />
              <span>{tab.label}</span>
              {tab.id === "log" && configuration?.log.count ? <b>{configuration.log.count}</b> : null}
            </button>
          ))}
        </nav>

        {activeTab === "agent" && (
          <section id="configuration-panel-agent" role="tabpanel" aria-labelledby="configuration-tab-agent" className="configuration-panel">
            <header className="configuration-panel__header" id="text-text-configuration-agent-introduction">
              <span className="configuration-panel__icon"><Icon name="radio" size={20} /></span>
              <div>
                <h3>Decision-support model</h3>
                <p>Select the OpenAI model used by the server for subsequent agent turns.</p>
              </div>
              <span className={`configuration-state configuration-state--${agent.enabled ? "ready" : "offline"}`}>
                <i />{agent.enabled ? "Agent enabled" : "Agent disabled"}
              </span>
            </header>

            {configurationLoading ? (
              <div className="configuration-loading" role="status"><span className="configuration-spinner" />Loading server configuration…</div>
            ) : (
              <div className="configuration-agent-form" id="text-text-configuration-agent-form">
                <label htmlFor="configuration-agent-model">
                  <span>OpenAI model</span>
                  <select
                    id="configuration-agent-model"
                    data-testid="configuration-agent-model"
                    value={selectedModel}
                    disabled={!configuration || savingModel || agent.allowedModels.length === 0}
                    onChange={(event) => setSelectedModel(event.target.value)}
                  >
                    {agent.allowedModels.length === 0 && <option value="">No server models available</option>}
                    {agent.allowedModels.map((model) => <option value={model} key={model}>{model}</option>)}
                  </select>
                  <small>Default: {agent.defaultModel ?? "not configured"}{agent.reasoningEffort ? ` · Reasoning: ${agent.reasoningEffort}` : ""}</small>
                  <p className="configuration-run-consistency">The selection applies to future runs. A WebMCP run already in progress keeps its original model across every tool round.</p>
                </label>
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="save-agent-model"
                  disabled={!configuration || !selectedModel || selectedModel === agent.model || savingModel}
                  onClick={() => void saveModel()}
                >
                  {savingModel ? <span className="configuration-spinner" /> : <Icon name="shield" size={15} />}
                  {savingModel ? "Applying…" : "Apply model"}
                </button>
              </div>
            )}

            {configurationError && (
              <div className="configuration-feedback configuration-feedback--error" id="text-text-configuration-agent-unavailable" role="alert">
                <Icon name="alert" size={16} />
                <span><strong>Server settings unavailable</strong>{configurationError} The application continues with {runtime.agent.model ?? "the server default model"}.</span>
              </div>
            )}
            {modelFeedback && (
              <div className={`configuration-feedback configuration-feedback--${modelFeedback.tone}`} role={modelFeedback.tone === "error" ? "alert" : "status"}>
                <Icon name={modelFeedback.tone === "error" ? "alert" : "shield"} size={16} />
                <span>{modelFeedback.message}</span>
              </div>
            )}
            <div className="configuration-security-note" id="text-text-configuration-agent-security">
              <Icon name="shield" size={17} />
              <div><strong>API key remains on the server</strong><p>The browser only receives safe model metadata. OpenAI credentials are never exposed in this page or exported configuration.</p></div>
            </div>
          </section>
        )}

        {activeTab === "simulator" && (
          <section id="configuration-panel-simulator" role="tabpanel" aria-labelledby="configuration-tab-simulator" className="configuration-panel">
            <header className="configuration-panel__header" id="text-text-configuration-simulator-introduction">
              <span className="configuration-panel__icon"><Icon name="settings" size={20} /></span>
              <div><h3>Simulator baseline</h3><p>Move a complete, deterministic operating state between demonstration environments.</p></div>
            </header>
            <div className="configuration-scenario-summary" id="text-text-configuration-simulator-summary">
              <div><span>Scenario</span><strong>{nativeSimulation.scenarioName}</strong></div>
              <div><span>Operational time</span><strong>{formatLogTime(nativeSimulation.timestamp)}</strong></div>
              <div><span>Objects</span><strong>{nativeSimulation.trains.length} trains · {nativeSimulation.incidents.length} incidents</strong></div>
            </div>
            <div className="configuration-transfer-grid">
              <article>
                <span><Icon name="external" size={20} /></span>
                <h4>Export current baseline</h4>
                <p>Download the current native network and detailed corridor state, including explicit incident occurrence times.</p>
                <button type="button" className="button button--secondary" data-testid="export-simulation-configuration" onClick={exportConfiguration}>
                  <Icon name="external" size={15} /> Export JSON
                </button>
              </article>
              <article>
                <span><Icon name="arrow" size={20} /></span>
                <h4>Import a baseline</h4>
                <p>The file is schema-validated before it is installed in the persistent operations state.</p>
                <button type="button" className="button button--secondary" data-testid="import-simulation-configuration" disabled={importing} onClick={() => importInputRef.current?.click()}>
                  {importing ? <span className="configuration-spinner" /> : <Icon name="arrow" size={15} />}
                  {importing ? "Checking…" : "Choose JSON file"}
                </button>
                <input
                  ref={importInputRef}
                  className="configuration-file-input"
                  type="file"
                  accept="application/json,.json"
                  aria-label="Import simulation configuration JSON"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void selectImportConfiguration(file);
                  }}
                />
              </article>
            </div>
            {pendingImport && (
              <div className="configuration-import-preview" id="text-text-configuration-import-preview" data-testid="simulation-configuration-preview">
                <div>
                  <span>Validated import</span>
                  <strong>{pendingImport.configuration.name}</strong>
                  <small>{pendingImport.fileName} · {pendingImport.configuration.nativeSnapshot.trains.length} trains · {pendingImport.configuration.nativeSnapshot.incidents.length} incidents · {formatLogTime(pendingImport.configuration.nativeSnapshot.timestamp)}</small>
                </div>
                <button type="button" className="button button--secondary" onClick={() => { setPendingImport(null); setTransferFeedback(null); }}>Cancel</button>
                <button type="button" className="button button--danger" data-testid="install-simulation-configuration" disabled={importing} onClick={() => void installImportConfiguration()}>
                  {importing ? <span className="configuration-spinner" /> : <Icon name="alert" size={15} />}
                  {importing ? "Installing…" : "Install imported baseline"}
                </button>
              </div>
            )}
            <div className="configuration-warning" id="text-text-configuration-simulator-warning">
              <Icon name="alert" size={17} />
              <p><strong>Import replaces the Reset baseline.</strong> The imported operating state becomes the scenario restored by the red Reset control.</p>
            </div>
            {transferFeedback && (
              <div className={`configuration-feedback configuration-feedback--${transferFeedback.tone}`} role={transferFeedback.tone === "error" ? "alert" : "status"}>
                <Icon name={transferFeedback.tone === "error" ? "alert" : "shield"} size={16} />
                <span>{transferFeedback.message}</span>
              </div>
            )}
          </section>
        )}

        {activeTab === "log" && (
          <section id="configuration-panel-log" role="tabpanel" aria-labelledby="configuration-tab-log" className="configuration-panel configuration-panel--log">
            <header className="configuration-panel__header" id="text-text-configuration-agent-log-introduction">
              <span className="configuration-panel__icon"><Icon name="activity" size={20} /></span>
              <div><h3>Agent execution log</h3><p>Server-recorded turns, outcomes, model usage and timings. Most recent first.</p></div>
              <div className="configuration-log-actions">
                <button type="button" className="button button--secondary" data-testid="refresh-agent-log" disabled={logLoading} onClick={() => void loadLog()}>
                  <Icon name="reset" size={15} /> Refresh
                </button>
                {configuration && !logError ? (
                  <a className="button button--secondary" data-testid="download-agent-log" href={downloadUrl} download>
                    <Icon name="external" size={15} /> Download JSON
                  </a>
                ) : (
                  <button type="button" className="button button--secondary" data-testid="download-agent-log" disabled title="Agent log download requires the application server">
                    <Icon name="external" size={15} /> Download JSON
                  </button>
                )}
              </div>
            </header>
            {logLoading && !log ? (
              <div className="configuration-log-empty" role="status"><span className="configuration-spinner" /><strong>Loading agent activity…</strong></div>
            ) : logError ? (
              <div className="configuration-log-empty configuration-log-empty--error" role="alert">
                <Icon name="alert" size={22} /><strong>Agent log unavailable</strong><span>{logError}</span>
                <button type="button" className="button button--secondary" onClick={() => void loadLog()}>Try again</button>
              </div>
            ) : !log?.entries.length ? (
              <div className="configuration-log-empty" id="text-text-configuration-agent-log-empty">
                <Icon name="activity" size={23} /><strong>No agent turn recorded yet</strong><span>Run a decision-support analysis; its trace will appear here.</span>
              </div>
            ) : (
              <div className="configuration-log-table-wrap" id="text-text-configuration-agent-log-table">
                <table className="configuration-log-table">
                  <caption className="sr-only">Agent execution log, most recent first</caption>
                  <thead><tr><th>Recorded</th><th>Run / operation</th><th>Model</th><th>Outcome</th><th>Duration</th><th>Tokens in / out</th><th>Detail</th></tr></thead>
                  <tbody>
                    {log.entries.map((entry, index) => {
                      const status = recordText(entry, "outcome") ?? "completed";
                      const run = recordText(entry, "runId", "entityId", "id") ?? `#${log.total - index}`;
                      const category = recordText(entry, "category") ?? "generic";
                      const toolNames = Array.isArray(entry.toolNames)
                        ? entry.toolNames.filter((name): name is string => typeof name === "string")
                        : [];
                      const detail = recordText(entry, "errorCode") ?? (toolNames.length ? toolNames.join(", ") : "Completed without tool calls");
                      return (
                        <tr key={recordText(entry, "id") ?? `${run}-${index}`}>
                          <td><strong>{formatLogTime(entry.timestamp)}</strong><small>{recordText(entry, "id") ?? "recorded"}</small></td>
                          <td><code title={run}>{run}</code><small>{category}{recordText(entry, "entityId") ? ` · ${recordText(entry, "entityId")}` : ""}{recordText(entry, "toolRound") ? ` · round ${recordText(entry, "toolRound")}` : ""}</small></td>
                          <td><strong>{recordText(entry, "model") ?? "—"}</strong></td>
                          <td><span className={`configuration-log-status configuration-log-status--${status.toLowerCase().replaceAll("_", "-")}`}>{status}</span></td>
                          <td>{formatDuration(entry.durationMs)}</td>
                          <td>{formatTokens(entry)}</td>
                          <td><span className="configuration-log-outcome" title={detail}>{detail}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {log.total > log.entries.length && <p className="configuration-log-note">Showing the latest {log.entries.length} of {log.total} records. Download the full JSON log for investigation.</p>}
              </div>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
