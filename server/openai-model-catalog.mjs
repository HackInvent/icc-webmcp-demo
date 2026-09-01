const MODEL_CATALOG = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    family: "GPT-5.6",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    family: "GPT-5.6",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    recommended: true,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    family: "GPT-5.6",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    family: "GPT-5.5",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.5-pro",
    label: "GPT-5.5 Pro",
    family: "GPT-5.5",
    reasoningEfforts: ["medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    family: "GPT-5.4",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "none",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    family: "GPT-5.4",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "none",
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    family: "GPT-5.4",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "none",
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3-Codex",
    family: "GPT-5.3",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    family: "GPT-5.2",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "none",
  },
  {
    id: "gpt-5.1",
    label: "GPT-5.1",
    family: "GPT-5.1",
    reasoningEfforts: ["none", "low", "medium", "high"],
    defaultReasoningEffort: "none",
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    family: "GPT-5",
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    family: "GPT-5",
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 nano",
    family: "GPT-5",
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5-pro",
    label: "GPT-5 Pro",
    family: "GPT-5",
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "o3-pro",
    label: "o3-pro",
    family: "o-series",
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
  },
  {
    id: "o3",
    label: "o3",
    family: "o-series",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    family: "Non-reasoning",
    reasoningEfforts: [],
    defaultReasoningEffort: null,
  },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    family: "Non-reasoning",
    reasoningEfforts: [],
    defaultReasoningEffort: null,
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    family: "Non-reasoning",
    reasoningEfforts: [],
    defaultReasoningEffort: null,
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o Mini",
    family: "Non-reasoning",
    reasoningEfforts: [],
    defaultReasoningEffort: null,
  },
];

const MODEL_BY_ID = new Map(MODEL_CATALOG.map((profile) => [profile.id, profile]));

function publicProfile(profile) {
  return {
    id: profile.id,
    label: profile.label,
    family: profile.family,
    reasoningEfforts: [...profile.reasoningEfforts],
    defaultReasoningEffort: profile.defaultReasoningEffort,
    recommended: profile.recommended === true,
  };
}

export const OPENAI_AGENT_MODEL_IDS = Object.freeze(MODEL_CATALOG.map(({ id }) => id));

export function openAiAgentModelProfile(model) {
  const profile = MODEL_BY_ID.get(model);
  return profile ? publicProfile(profile) : null;
}

export function configuredOpenAiAgentModels(allowedModels) {
  return allowedModels
    .map((model) => openAiAgentModelProfile(model))
    .filter(Boolean);
}

export function supportsReasoningEffort(model, effort) {
  const profile = MODEL_BY_ID.get(model);
  return Boolean(profile && profile.reasoningEfforts.includes(effort));
}

export function defaultReasoningEffortFor(model) {
  return MODEL_BY_ID.get(model)?.defaultReasoningEffort ?? null;
}

export function openAiReasoningParameter(reasoningEffort) {
  return reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {};
}
