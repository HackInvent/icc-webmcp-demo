import { describe, expect, it } from "vitest";
import {
  defaultReasoningEffortFor,
  OPENAI_AGENT_MODEL_IDS,
  openAiAgentModelProfile,
  openAiReasoningParameter,
  supportsReasoningEffort,
} from "../server/openai-model-catalog.mjs";

describe("OpenAI agent model catalogue", () => {
  it("contains only the 21 current models compatible with the complete agent workflow", () => {
    expect(OPENAI_AGENT_MODEL_IDS).toHaveLength(21);
    expect(OPENAI_AGENT_MODEL_IDS).toEqual(expect.arrayContaining([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5-pro",
      "gpt-5.3-codex",
      "gpt-5-mini",
      "gpt-5-pro",
      "o3",
      "gpt-4.1",
      "gpt-4o-mini",
    ]));
    expect(OPENAI_AGENT_MODEL_IDS).not.toEqual(expect.arrayContaining([
      "gpt-5.4-pro",
      "gpt-5.2-pro",
    ]));
  });

  it("maps each model to its supported efforts and model default", () => {
    expect(openAiAgentModelProfile("gpt-5.6-terra")).toMatchObject({
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      recommended: true,
    });
    expect(openAiAgentModelProfile("gpt-5.5-pro")).toMatchObject({
      reasoningEfforts: ["medium", "high", "xhigh"],
      defaultReasoningEffort: "high",
    });
    expect(openAiAgentModelProfile("gpt-5")).toMatchObject({
      reasoningEfforts: ["minimal", "low", "medium", "high"],
    });
    expect(openAiAgentModelProfile("gpt-5-pro")).toMatchObject({
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    });
    expect(openAiAgentModelProfile("gpt-4.1")).toMatchObject({
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    });
    expect(supportsReasoningEffort("gpt-5.6-luna", "max")).toBe(true);
    expect(supportsReasoningEffort("gpt-5.4", "max")).toBe(false);
    expect(defaultReasoningEffortFor("gpt-5.2")).toBe("none");
  });

  it("omits the reasoning parameter for non-reasoning models", () => {
    expect(openAiReasoningParameter("high")).toEqual({ reasoning: { effort: "high" } });
    expect(openAiReasoningParameter(null)).toEqual({});
  });
});
