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
        accessCode: "editable-test-code",
        accessCodeHash: undefined,
      },
    }), {
      configPath: "/tmp/config.json",
      environment: {},
    });

    expect(verifyAccessCode("editable-test-code", config.auth.accessCodeHash)).toBe(true);
    expect(JSON.stringify(publicRuntimeConfiguration(config, false))).not.toContain("editable-test-code");
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
