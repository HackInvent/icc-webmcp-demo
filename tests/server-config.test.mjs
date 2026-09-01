import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  parseServerConfig,
  publicRuntimeConfiguration,
} from "../server/config.mjs";
import { verifyAccessCode } from "../server/security.mjs";
import { rawServerConfig, TEST_ACCESS_HASH } from "./server-fixture.mjs";

describe("server JSON configuration", () => {
  it("expands environment references, resolves paths, and never publishes secrets", () => {
    const raw = rawServerConfig({
      auth: {
        accessCodeHash: "${ACCESS_HASH}",
        sessionSecret: "${SESSION_SECRET}",
      },
      openai: { apiKey: "${OPENAI_KEY}" },
    });
    const config = parseServerConfig(raw, {
      configPath: "/srv/paris-icc/config/server.local.json",
      environment: {
        ACCESS_HASH: TEST_ACCESS_HASH,
        SESSION_SECRET: "a-session-secret-that-is-longer-than-thirty-two-characters",
        OPENAI_KEY: "sk-test-environment-key-123456789",
      },
    });

    expect(config.server.distDirectory).toBe("/srv/paris-icc/dist");
    expect(config.storage.agentRuntimePath).toBe("/srv/paris-icc/state/agent-runtime.json");
    expect(config.openai.apiKey).toBe("sk-test-environment-key-123456789");
    expect(config.openai.allowedModels).toContain(config.openai.model);
    const publicConfig = publicRuntimeConfiguration(config, true, { model: "gpt-5.6-sol" });
    expect(publicConfig).toMatchObject({
      authenticated: true,
      application: { dataMode: "local-simulation" },
      agent: { enabled: true, model: "gpt-5.6-sol" },
    });
    const exposed = JSON.stringify(publicConfig);
    expect(exposed).not.toContain("sk-test");
    expect(exposed).not.toContain("session-secret");
    expect(exposed).not.toContain("scrypt$");
  });

  it("fails fast on missing secrets and unsafe cookie/origin combinations", () => {
    expect(() => parseServerConfig(rawServerConfig({
      openai: { apiKey: "${MISSING_OPENAI_KEY}" },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(ConfigurationError);

    expect(() => parseServerConfig(rawServerConfig({
      auth: { secureCookies: true },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/requires an https publicOrigin/);

    expect(() => parseServerConfig(rawServerConfig({
      application: { publicOrigin: "https://paris_icc_demo.example.com" },
      auth: { secureCookies: true },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/cannot contain underscores/);
  });

  it("accepts a plaintext access code from a private JSON without publishing it", () => {
    const config = parseServerConfig(rawServerConfig({
      auth: {
        accessCode: "editable-jury-code",
        accessCodeHash: undefined,
      },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    });

    expect(verifyAccessCode("editable-jury-code", config.auth.accessCodeHash)).toBe(true);
    expect(JSON.stringify(publicRuntimeConfiguration(config, false))).not.toContain("editable-jury-code");
  });

  it("requires a unique model allowlist containing the configured default", () => {
    expect(() => parseServerConfig(rawServerConfig({
      openai: { allowedModels: ["gpt-5.6-sol"] },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/must include openai.model/);

    expect(() => parseServerConfig(rawServerConfig({
      openai: { allowedModels: ["gpt-5.6-terra", "gpt-5.6-terra"] },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/must not contain duplicate/);
  });

  it("validates the configured reasoning effort against the selected model", () => {
    expect(() => parseServerConfig(rawServerConfig({
      openai: {
        model: "gpt-5.5-pro",
        allowedModels: ["gpt-5.5-pro"],
        reasoningEffort: "low",
      },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/is not supported by gpt-5.5-pro/);

    const nonReasoning = parseServerConfig(rawServerConfig({
      openai: {
        model: "gpt-4.1",
        allowedModels: ["gpt-4.1"],
        reasoningEffort: null,
      },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    });
    expect(nonReasoning.openai.reasoningEffort).toBeNull();

    expect(() => parseServerConfig(rawServerConfig({
      openai: {
        model: "future-unverified-model",
        allowedModels: ["future-unverified-model"],
      },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/not a current OpenAI model compatible/);
  });

  it("loads one complete and unique instruction for every incident type", () => {
    const config = parseServerConfig(rawServerConfig(), {
      configPath: "/tmp/config.json",
      environment: {},
    });
    expect(config.agent.incidentInstructions.map((entry) => entry.type)).toEqual([
      "infrastructure",
      "passenger",
      "rolling-stock",
      "staff",
      "power",
      "works",
      "external",
      "communications",
      "security",
    ]);

    const incomplete = rawServerConfig();
    incomplete.agent.incidentInstructions = incomplete.agent.incidentInstructions.slice(0, 8);
    expect(() => parseServerConfig(incomplete, {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/must contain exactly 9 incident types/);

    const duplicate = rawServerConfig();
    duplicate.agent.incidentInstructions[8] = {
      ...duplicate.agent.incidentInstructions[8],
      type: "infrastructure",
    };
    expect(() => parseServerConfig(duplicate, {
      configPath: "/tmp/config.json",
      environment: {},
    })).toThrow(/must be unique/);
  });

  it("defaults the authenticated operations clock to one real-time second", () => {
    const raw = rawServerConfig();
    delete raw.storage.tickIntervalMs;
    const config = parseServerConfig(raw, {
      configPath: "/tmp/config.json",
      environment: {},
    });
    expect(config.storage.tickIntervalMs).toBe(1_000);
  });
});
