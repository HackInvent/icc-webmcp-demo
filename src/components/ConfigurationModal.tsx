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

type ConfigurationTab = "agent" | "instructions" | "simulator" | "log";
type FeedbackTone = "success" | "error";

const INCIDENT_INSTRUCTION_SCHEMA_VERSION = "paris-icc-agent-instructions.v1";
const INCIDENT_INSTRUCTION_TYPES = [
  "infrastructure",
  "passenger",
  "rolling-stock",
  "staff",
  "power",
  "works",
  "external",
  "communications",
  "security",
] as const;

type IncidentInstructionType = typeof INCIDENT_INSTRUCTION_TYPES[number];

interface AgentIncidentInstruction {
  type: IncidentInstructionType;
  label: string;
  instruction: string;
  defaultInstruction: string;
  modified: boolean;
}

interface AgentInstructionConfiguration {
  schemaVersion: string;
  updatedAt: string | null;
  instructions: AgentIncidentInstruction[];
}

interface AgentInstructionTransfer {
  schemaVersion: typeof INCIDENT_INSTRUCTION_SCHEMA_VERSION;
  instructions: Array<Pick<AgentIncidentInstruction, "type" | "instruction">>;
}

interface AgentModelProfile {
  id: string;
  label: string;
  family: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  recommended: boolean;
}

interface AgentConfiguration {
  enabled: boolean;
  model: string | null;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  allowedModels: string[];
  models: AgentModelProfile[];
  reasoningEffort: string | null;
  updatedAt: string | null;
}

interface ConfigurationResponse {
  agent: AgentConfiguration;
  incidentInstructions: AgentInstructionConfiguration | null;
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

const TABS: ReadonlyArray<{ id: ConfigurationTab; label: string; icon: "radio" | "shield" | "settings" | "activity" }> = [
  { id: "agent", label: "Agent", icon: "radio" },
  { id: "instructions", label: "Agent instruction", icon: "shield" },
  { id: "simulator", label: "Simulator configuration", icon: "settings" },
  { id: "log", label: "Agent log", icon: "activity" },
];

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: "None — fastest",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium — balanced",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

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

function normalizeModelProfile(value: unknown): AgentModelProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profile = value as Partial<AgentModelProfile>;
  if (typeof profile.id !== "string" || !profile.id.trim()) return null;
  const reasoningEfforts = Array.isArray(profile.reasoningEfforts)
    ? [...new Set(profile.reasoningEfforts.filter((effort): effort is string => typeof effort === "string" && effort.length > 0))]
    : [];
  const defaultReasoningEffort = typeof profile.defaultReasoningEffort === "string" &&
    reasoningEfforts.includes(profile.defaultReasoningEffort)
    ? profile.defaultReasoningEffort
    : null;
  return {
    id: profile.id,
    label: typeof profile.label === "string" && profile.label.trim() ? profile.label : profile.id,
    family: typeof profile.family === "string" && profile.family.trim() ? profile.family : "OpenAI",
    reasoningEfforts,
    defaultReasoningEffort,
    recommended: profile.recommended === true,
  };
}

function normalizeAgentConfiguration(
  value: Partial<AgentConfiguration> | undefined,
  fallback: AgentConfiguration,
): AgentConfiguration {
  const model = typeof value?.model === "string" && value.model.trim() ? value.model.trim() : fallback.model;
  const allowedModels = Array.isArray(value?.allowedModels)
    ? value.allowedModels.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : fallback.allowedModels;
  const suppliedModels = Array.isArray(value?.models)
    ? value.models.map(normalizeModelProfile).filter((profile): profile is AgentModelProfile => Boolean(profile))
    : [];
  const fallbackModels = suppliedModels.length > 0 ? suppliedModels : fallback.models;
  const models = fallbackModels.length > 0
    ? fallbackModels
    : [...new Set([...(model ? [model] : []), ...allowedModels])].map((id) => ({
        id,
        label: id,
        family: "OpenAI",
        reasoningEfforts: typeof value?.reasoningEffort === "string" ? [value.reasoningEffort] : [],
        defaultReasoningEffort: typeof value?.reasoningEffort === "string" ? value.reasoningEffort : null,
        recommended: false,
      }));
  const reasoningEffort = value && "reasoningEffort" in value
    ? (typeof value.reasoningEffort === "string" ? value.reasoningEffort : null)
    : fallback.reasoningEffort;
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : fallback.enabled,
    model,
    defaultModel: typeof value?.defaultModel === "string" ? value.defaultModel : fallback.defaultModel,
    defaultReasoningEffort: typeof value?.defaultReasoningEffort === "string"
      ? value.defaultReasoningEffort
      : fallback.defaultReasoningEffort,
    allowedModels: [...new Set(models.map((profile) => profile.id))],
    models,
    reasoningEffort,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

function isIncidentInstructionType(value: unknown): value is IncidentInstructionType {
  return typeof value === "string" && (INCIDENT_INSTRUCTION_TYPES as readonly string[]).includes(value);
}

function normalizeIncidentInstructionConfiguration(value: unknown): AgentInstructionConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<AgentInstructionConfiguration>;
  if (candidate.schemaVersion !== INCIDENT_INSTRUCTION_SCHEMA_VERSION || !Array.isArray(candidate.instructions)) return null;
  const byType = new Map<IncidentInstructionType, AgentIncidentInstruction>();
  for (const raw of candidate.instructions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Partial<AgentIncidentInstruction>;
    if (
      !isIncidentInstructionType(item.type) ||
      typeof item.label !== "string" || !item.label.trim() ||
      typeof item.instruction !== "string" || item.instruction.trim().length < 40 || item.instruction.trim().length > 6_000 ||
      typeof item.defaultInstruction !== "string" || item.defaultInstruction.trim().length < 40 ||
      typeof item.modified !== "boolean" ||
      byType.has(item.type)
    ) return null;
    byType.set(item.type, {
      type: item.type,
      label: item.label.trim(),
      instruction: item.instruction.trim(),
      defaultInstruction: item.defaultInstruction.trim(),
      modified: item.modified,
    });
  }
  if (byType.size !== INCIDENT_INSTRUCTION_TYPES.length) return null;
  return {
    schemaVersion: candidate.schemaVersion,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
    instructions: INCIDENT_INSTRUCTION_TYPES.map((type) => byType.get(type) as AgentIncidentInstruction),
  };
}

function parseAgentInstructionTransfer(source: string): AgentInstructionTransfer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The instruction file must be a JSON object.");
  }
  const value = parsed as Partial<AgentInstructionTransfer>;
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("schemaVersion") ||
    !keys.includes("instructions") ||
    value.schemaVersion !== INCIDENT_INSTRUCTION_SCHEMA_VERSION ||
    !Array.isArray(value.instructions) ||
    value.instructions.length !== INCIDENT_INSTRUCTION_TYPES.length
  ) {
    throw new Error(`Expected a complete ${INCIDENT_INSTRUCTION_SCHEMA_VERSION} file.`);
  }
  const byType = new Map<IncidentInstructionType, string>();
  for (const raw of value.instructions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Every instruction entry must be an object.");
    const entry = raw as Partial<Pick<AgentIncidentInstruction, "type" | "instruction">>;
    const entryKeys = Object.keys(entry);
    const instruction = typeof entry.instruction === "string" ? entry.instruction.trim() : "";
    if (
      entryKeys.length !== 2 || !entryKeys.includes("type") || !entryKeys.includes("instruction") ||
      !isIncidentInstructionType(entry.type) || byType.has(entry.type) ||
      instruction.length < 40 || instruction.length > 6_000
    ) throw new Error("Every incident type must have one instruction between 40 and 6,000 characters.");
    byType.set(entry.type, instruction);
  }
  if (byType.size !== INCIDENT_INSTRUCTION_TYPES.length) throw new Error("The instruction file is incomplete.");
  return {
    schemaVersion: INCIDENT_INSTRUCTION_SCHEMA_VERSION,
    instructions: INCIDENT_INSTRUCTION_TYPES.map((type) => ({
      type,
      instruction: byType.get(type) as string,
    })),
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
  const { configuration: runtime, updateAgentConfiguration } = useRuntimeConfiguration();
  const [activeTab, setActiveTab] = useState<ConfigurationTab>("agent");
  const [configuration, setConfiguration] = useState<ConfigurationResponse | null>(null);
  const [configurationLoading, setConfigurationLoading] = useState(true);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(runtime.agent.model ?? "");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(runtime.agent.reasoningEffort ?? "");
  const [savingModel, setSavingModel] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [selectedInstructionType, setSelectedInstructionType] = useState<IncidentInstructionType>("infrastructure");
  const [instructionDrafts, setInstructionDrafts] = useState<Record<IncidentInstructionType, string> | null>(null);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionFeedback, setInstructionFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [transferFeedback, setTransferFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ fileName: string; configuration: ParsedSimulationConfiguration } | null>(null);
  const [log, setLog] = useState<AgentLogResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const instructionImportInputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const runtimeFallback: AgentConfiguration = {
    enabled: runtime.agent.enabled,
    model: runtime.agent.model,
    defaultModel: runtime.agent.model,
    defaultReasoningEffort: runtime.agent.reasoningEffort,
    allowedModels: runtime.agent.model ? [runtime.agent.model] : [],
    models: runtime.agent.model ? [{
      id: runtime.agent.model,
      label: runtime.agent.model,
      family: "OpenAI",
      reasoningEfforts: runtime.agent.reasoningEffort ? [runtime.agent.reasoningEffort] : [],
      defaultReasoningEffort: runtime.agent.reasoningEffort,
      recommended: false,
    }] : [],
    reasoningEffort: runtime.agent.reasoningEffort,
    updatedAt: null,
  };
  const agent = configuration?.agent ?? runtimeFallback;
  const selectedModelProfile = agent.models.find((profile) => profile.id === selectedModel) ?? null;
  const selectedEffort = selectedModelProfile?.reasoningEfforts.length
    ? selectedReasoningEffort
    : null;
  const selectionIsUnchanged = selectedModel === agent.model && selectedEffort === agent.reasoningEffort;
  const downloadUrl = configuration?.log.downloadUrl || "/api/agent/log/download";
  const instructionConfiguration = configuration?.incidentInstructions ?? null;
  const selectedInstruction = instructionConfiguration?.instructions.find(
    (entry) => entry.type === selectedInstructionType,
  ) ?? null;
  const currentInstructionDraft = instructionDrafts?.[selectedInstructionType] ?? "";
  const instructionChangesPending = Boolean(instructionConfiguration && instructionDrafts &&
    instructionConfiguration.instructions.some((entry) => instructionDrafts[entry.type].trim() !== entry.instruction));
  const instructionDraftIsValid = Boolean(instructionDrafts && INCIDENT_INSTRUCTION_TYPES.every((type) => {
    const instruction = instructionDrafts[type].trim();
    return instruction.length >= 40 && instruction.length <= 6_000;
  }));

  useEffect(() => {
    const controller = new AbortController();
    setConfigurationLoading(true);
    void fetchJson<ConfigurationResponse>("/api/configuration", { signal: controller.signal })
      .then((response) => {
        const normalized = normalizeAgentConfiguration(response.agent, runtimeFallback);
        const normalizedInstructions = normalizeIncidentInstructionConfiguration(response.incidentInstructions);
        setConfiguration({ ...response, agent: normalized, incidentInstructions: normalizedInstructions });
        setSelectedModel(normalized.model ?? "");
        setSelectedReasoningEffort(normalized.reasoningEffort ?? "");
        setInstructionDrafts(normalizedInstructions
          ? Object.fromEntries(normalizedInstructions.instructions.map((entry) => [entry.type, entry.instruction])) as Record<IncidentInstructionType, string>
          : null);
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
    if (
      !selectedModel ||
      !selectedModelProfile ||
      (selectedModelProfile.reasoningEfforts.length > 0 && !selectedReasoningEffort) ||
      savingModel ||
      !configuration
    ) return;
    setSavingModel(true);
    setModelFeedback(null);
    try {
      const response = await fetchJson<ConfigurationResponse | { agent: AgentConfiguration }>("/api/configuration/agent", {
        method: "PUT",
        body: JSON.stringify({ model: selectedModel, reasoningEffort: selectedEffort }),
      });
      const normalized = normalizeAgentConfiguration(response.agent, agent);
      setConfiguration((current) => current ? { ...current, agent: normalized } : {
        agent: normalized,
        incidentInstructions: null,
        log: { count: 0, downloadUrl: "/api/agent/log/download" },
      });
      const appliedModel = normalized.model ?? selectedModel;
      setSelectedModel(appliedModel);
      setSelectedReasoningEffort(normalized.reasoningEffort ?? "");
      updateAgentConfiguration(appliedModel, normalized.reasoningEffort);
      setModelFeedback({
        tone: "success",
        message: `${appliedModel}${normalized.reasoningEffort ? ` · ${normalized.reasoningEffort} effort` : " · no reasoning effort"} will be used for the next agent run.`,
      });
    } catch (error) {
      setModelFeedback({ tone: "error", message: errorMessage(error, "The agent configuration could not be updated.") });
    } finally {
      setSavingModel(false);
    }
  };

  const saveInstructions = async () => {
    if (!instructionDrafts || !instructionDraftIsValid || !instructionChangesPending || savingInstructions) return;
    setSavingInstructions(true);
    setInstructionFeedback(null);
    const payload: AgentInstructionTransfer = {
      schemaVersion: INCIDENT_INSTRUCTION_SCHEMA_VERSION,
      instructions: INCIDENT_INSTRUCTION_TYPES.map((type) => ({
        type,
        instruction: instructionDrafts[type].trim(),
      })),
    };
    try {
      const response = await fetchJson<{ incidentInstructions: AgentInstructionConfiguration }>(
        "/api/configuration/agent-instructions",
        { method: "PUT", body: JSON.stringify(payload) },
      );
      const normalized = normalizeIncidentInstructionConfiguration(response.incidentInstructions);
      if (!normalized) throw new Error("The server returned an invalid instruction registry.");
      setConfiguration((current) => current ? { ...current, incidentInstructions: normalized } : current);
      setInstructionDrafts(Object.fromEntries(
        normalized.instructions.map((entry) => [entry.type, entry.instruction]),
      ) as Record<IncidentInstructionType, string>);
      setInstructionFeedback({
        tone: "success",
        message: "All incident instructions were saved. New incident analyses will use the instruction matched to verified WebMCP evidence.",
      });
    } catch (error) {
      setInstructionFeedback({ tone: "error", message: errorMessage(error, "The incident instructions could not be saved.") });
    } finally {
      setSavingInstructions(false);
    }
  };

  const restoreInstructionDefaults = () => {
    if (!instructionConfiguration) return;
    setInstructionDrafts(Object.fromEntries(
      instructionConfiguration.instructions.map((entry) => [entry.type, entry.defaultInstruction]),
    ) as Record<IncidentInstructionType, string>);
    setInstructionFeedback({
      tone: "success",
      message: "Server JSON defaults loaded into the editor. Save them to replace the persisted overrides.",
    });
  };

  const importInstructions = async (file: File) => {
    setInstructionFeedback(null);
    try {
      const imported = parseAgentInstructionTransfer(await file.text());
      setInstructionDrafts(Object.fromEntries(
        imported.instructions.map((entry) => [entry.type, entry.instruction]),
      ) as Record<IncidentInstructionType, string>);
      setInstructionFeedback({
        tone: "success",
        message: `${file.name} loaded into the editor. Review the instructions, then save to apply them.`,
      });
    } catch (error) {
      setInstructionFeedback({ tone: "error", message: errorMessage(error, "The instruction file could not be imported.") });
    } finally {
      if (instructionImportInputRef.current) instructionImportInputRef.current.value = "";
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
                <p>Select a compatible OpenAI model and one of the reasoning efforts it supports.</p>
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
                    disabled={!configuration || savingModel || agent.models.length === 0}
                    onChange={(event) => {
                      const nextModel = event.target.value;
                      const nextProfile = agent.models.find((profile) => profile.id === nextModel);
                      setSelectedModel(nextModel);
                      setSelectedReasoningEffort((current) => nextProfile?.reasoningEfforts.includes(current)
                        ? current
                        : nextProfile?.defaultReasoningEffort ?? "");
                      setModelFeedback(null);
                    }}
                  >
                    {agent.models.length === 0 && <option value="">No compatible server models available</option>}
                    {[...new Set(agent.models.map((profile) => profile.family))].map((family) => (
                      <optgroup label={family} key={family}>
                        {agent.models.filter((profile) => profile.family === family).map((profile) => (
                          <option value={profile.id} key={profile.id}>
                            {profile.label} — {profile.id}{profile.recommended ? " (recommended)" : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <small>Server default: {agent.defaultModel ?? "not configured"}</small>
                </label>
                <label htmlFor="configuration-agent-reasoning-effort">
                  <span>Reasoning effort</span>
                  <select
                    id="configuration-agent-reasoning-effort"
                    data-testid="configuration-agent-reasoning-effort"
                    value={selectedReasoningEffort}
                    disabled={!configuration || savingModel || !selectedModelProfile?.reasoningEfforts.length}
                    onChange={(event) => {
                      setSelectedReasoningEffort(event.target.value);
                      setModelFeedback(null);
                    }}
                  >
                    {!selectedModelProfile?.reasoningEfforts.length ? (
                      <option value="">Not applicable — non-reasoning model</option>
                    ) : selectedModelProfile.reasoningEfforts.map((effort) => (
                      <option value={effort} key={effort}>{REASONING_EFFORT_LABELS[effort] ?? effort}</option>
                    ))}
                  </select>
                  <small>
                    {selectedModelProfile?.reasoningEfforts.length
                      ? `Model default: ${selectedModelProfile.defaultReasoningEffort ?? "provider default"}`
                      : "The reasoning parameter is omitted from OpenAI requests."}
                  </small>
                </label>
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="save-agent-model"
                  disabled={
                    !configuration ||
                    !selectedModel ||
                    !selectedModelProfile ||
                    (selectedModelProfile.reasoningEfforts.length > 0 && !selectedReasoningEffort) ||
                    selectionIsUnchanged ||
                    savingModel
                  }
                  onClick={() => void saveModel()}
                >
                  {savingModel ? <span className="configuration-spinner" /> : <Icon name="shield" size={15} />}
                  {savingModel ? "Applying…" : "Apply configuration"}
                </button>
                <p className="configuration-run-consistency">The selection applies to future runs. A WebMCP run already in progress keeps its original model and effort across every tool round.</p>
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

        {activeTab === "instructions" && (
          <section id="configuration-panel-instructions" role="tabpanel" aria-labelledby="configuration-tab-instructions" className="configuration-panel configuration-panel--instructions">
            <header className="configuration-panel__header" id="text-text-configuration-agent-instructions-introduction">
              <span className="configuration-panel__icon"><Icon name="shield" size={20} /></span>
              <div>
                <h3>Incident analysis instructions</h3>
                <p>Edit the focus applied after WebMCP verifies the selected incident type. Retrieved procedures and operator approval remain authoritative.</p>
              </div>
              <span className="configuration-state configuration-state--ready"><i />9 incident types</span>
            </header>

            {configurationLoading ? (
              <div className="configuration-loading" role="status"><span className="configuration-spinner" />Loading incident instructions…</div>
            ) : !instructionConfiguration || !instructionDrafts ? (
              <div className="configuration-log-empty configuration-log-empty--error" role="alert">
                <Icon name="alert" size={22} />
                <strong>Incident instructions unavailable</strong>
                <span>The server did not return a complete versioned instruction registry.</span>
              </div>
            ) : (
              <>
                <div className="configuration-instruction-workspace" id="text-text-configuration-agent-instruction-editor">
                  <aside className="configuration-instruction-types" aria-label="Incident types">
                    {instructionConfiguration.instructions.map((entry) => {
                      const custom = instructionDrafts[entry.type].trim() !== entry.defaultInstruction;
                      return (
                        <button
                          key={entry.type}
                          type="button"
                          className={selectedInstructionType === entry.type ? "is-active" : ""}
                          aria-pressed={selectedInstructionType === entry.type}
                          data-testid={`instruction-type-${entry.type}`}
                          onClick={() => setSelectedInstructionType(entry.type)}
                        >
                          <span>{entry.label}</span>
                          <small>{entry.type}</small>
                          <b className={custom ? "is-custom" : ""}>{custom ? "Custom" : "Default"}</b>
                        </button>
                      );
                    })}
                  </aside>
                  <article className="configuration-instruction-editor">
                    <header>
                      <div>
                        <span>Verified incident type</span>
                        <h4>{selectedInstruction?.label}</h4>
                      </div>
                      <code>{selectedInstructionType}</code>
                    </header>
                    <label htmlFor="configuration-agent-incident-instruction">
                      <span>Agent instruction</span>
                      <textarea
                        id="configuration-agent-incident-instruction"
                        data-testid="configuration-agent-incident-instruction"
                        value={currentInstructionDraft}
                        maxLength={6_000}
                        spellCheck
                        onChange={(event) => {
                          const instruction = event.target.value;
                          setInstructionDrafts((current) => current ? {
                            ...current,
                            [selectedInstructionType]: instruction,
                          } : current);
                          setInstructionFeedback(null);
                        }}
                      />
                    </label>
                    <div className="configuration-instruction-editor__meta">
                      <p>The server pins this instruction after the read-only incident inspection returns <code>{selectedInstructionType}</code>. It applies to the remaining procedure search and recommendation rounds.</p>
                      <span className={currentInstructionDraft.trim().length < 40 ? "is-invalid" : ""}>{currentInstructionDraft.length.toLocaleString("en-GB")} / 6,000</span>
                    </div>
                    <button
                      type="button"
                      className="button button--secondary configuration-instruction-reset-one"
                      disabled={currentInstructionDraft === selectedInstruction?.defaultInstruction}
                      onClick={() => {
                        if (!selectedInstruction) return;
                        setInstructionDrafts((current) => current ? {
                          ...current,
                          [selectedInstructionType]: selectedInstruction.defaultInstruction,
                        } : current);
                        setInstructionFeedback(null);
                      }}
                    >
                      <Icon name="reset" size={15} /> Restore this server default
                    </button>
                  </article>
                </div>

                <div className="configuration-instruction-actions" id="text-text-configuration-agent-instruction-actions">
                  <button type="button" className="button button--secondary" onClick={restoreInstructionDefaults}>
                    <Icon name="reset" size={15} /> Restore all defaults
                  </button>
                  <button type="button" className="button button--secondary" onClick={() => instructionImportInputRef.current?.click()}>
                    <Icon name="arrow" size={15} /> Import JSON
                  </button>
                  <input
                    ref={instructionImportInputRef}
                    className="configuration-file-input"
                    type="file"
                    accept="application/json,.json"
                    aria-label="Import agent incident instructions JSON"
                    data-testid="import-agent-instructions-input"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importInstructions(file);
                    }}
                  />
                  <a
                    className="button button--secondary"
                    href="/api/configuration/agent-instructions/export"
                    download
                    data-testid="export-agent-instructions"
                  >
                    <Icon name="external" size={15} /> Export saved JSON
                  </a>
                  <button
                    type="button"
                    className="button button--primary configuration-instruction-save"
                    data-testid="save-agent-instructions"
                    disabled={!instructionChangesPending || !instructionDraftIsValid || savingInstructions}
                    onClick={() => void saveInstructions()}
                  >
                    {savingInstructions ? <span className="configuration-spinner" /> : <Icon name="shield" size={15} />}
                    {savingInstructions ? "Saving…" : "Save instructions"}
                  </button>
                </div>
                {instructionChangesPending && !instructionDraftIsValid && (
                  <div className="configuration-feedback configuration-feedback--error" role="alert">
                    <Icon name="alert" size={16} />
                    <span>Every incident type needs an instruction between 40 and 6,000 characters before the registry can be saved.</span>
                  </div>
                )}
                {instructionFeedback && (
                  <div className={`configuration-feedback configuration-feedback--${instructionFeedback.tone}`} role={instructionFeedback.tone === "error" ? "alert" : "status"}>
                    <Icon name={instructionFeedback.tone === "error" ? "alert" : "shield"} size={16} />
                    <span>{instructionFeedback.message}</span>
                  </div>
                )}
              </>
            )}
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
              <div><span>Objects</span><strong>{nativeSimulation.trains.length} trains · {nativeSimulation.shuttles.length} shuttles · {nativeSimulation.incidents.length} incidents</strong></div>
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
                  <small>{pendingImport.fileName} · {pendingImport.configuration.nativeSnapshot.trains.length} trains · {pendingImport.configuration.nativeSnapshot.shuttles.length} shuttles · {pendingImport.configuration.nativeSnapshot.incidents.length} incidents · {formatLogTime(pendingImport.configuration.nativeSnapshot.timestamp)}</small>
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
              <div
                className="configuration-log-table-wrap"
                id="text-text-configuration-agent-log-table"
                role="region"
                aria-label="Scrollable agent execution log"
                tabIndex={0}
              >
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
                          <td><strong>{recordText(entry, "model") ?? "—"}</strong><small>{recordText(entry, "reasoningEffort") ? `${recordText(entry, "reasoningEffort")} effort` : "No reasoning effort"}</small></td>
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
