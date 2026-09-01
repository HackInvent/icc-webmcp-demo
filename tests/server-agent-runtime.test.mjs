import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename as renameFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeStore } from "../server/agent-runtime-store.mjs";
import { AgentService } from "../server/agent.mjs";
import { createParisIccServer } from "../server/app.mjs";
import { parsedServerConfig, TEST_ACCESS_CODE, TEST_WEBMCP_TOOL } from "./server-fixture.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie.");
  return value.split(";", 1)[0];
}

describe("persisted agent configuration and bounded execution log", () => {
  it("keeps one model for every round of an active run and uses the new model for the next run", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-agent-run-model-"));
    const config = parsedServerConfig();
    config.storage.agentRuntimePath = path.join(directory, "agent-runtime.json");
    const store = new AgentRuntimeStore(config);
    const requestModels = [];
    let requestNumber = 0;
    const fetchImpl = vi.fn(async (_url, options) => {
      requestModels.push(JSON.parse(options.body).model);
      requestNumber += 1;
      if (requestNumber === 1) {
        return jsonResponse({
          output: [{
            type: "function_call",
            call_id: "call-stable-model",
            name: TEST_WEBMCP_TOOL.name,
            arguments: "{}",
          }],
          usage: { input_tokens: 20, output_tokens: 4 },
        });
      }
      return jsonResponse({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Inspection completed." }],
        }],
        usage: { input_tokens: 40, output_tokens: 8 },
      });
    });
    const service = new AgentService(config, { fetchImpl, runtimeStore: store });

    try {
      const first = await service.turn("session-stable", {
        prompt: "Inspect.",
        tools: [TEST_WEBMCP_TOOL],
      });
      await store.updateModel("gpt-5.6-sol");
      await service.turn("session-stable", {
        runId: first.runId,
        toolOutputs: [{ callId: "call-stable-model", output: "{}" }],
      });
      await service.turn("session-stable", {
        prompt: "Inspect again.",
        tools: [TEST_WEBMCP_TOOL],
      });

      expect(requestModels).toEqual([
        "gpt-5.6-terra",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
      ]);
      expect(store.list(10)).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: "tool_calls", toolNames: [TEST_WEBMCP_TOOL.name] }),
        expect.objectContaining({ outcome: "completed", model: "gpt-5.6-sol" }),
      ]));
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("protects the API, persists the selected allowlisted model, and downloads a secret-free log", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-agent-runtime-"));
    writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>Paris ICC test</title>");
    const requests = [];
    const fetchImpl = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Operational brief ready." }],
        }],
        usage: { input_tokens: 73, output_tokens: 19 },
      });
    });
    const config = parsedServerConfig();
    config.server.distDirectory = directory;
    config.storage.databasePath = path.join(directory, "operations.sqlite");
    config.storage.agentRuntimePath = path.join(directory, "agent-runtime.json");
    const application = createParisIccServer(config, { fetchImpl });
    await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
    const address = application.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const anonymous = await fetch(`${baseUrl}/api/configuration`);
      expect(anonymous.status).toBe(401);

      for (const endpoint of ["/api/agent/log", "/api/agent/log/download"]) {
        const protectedResponse = await fetch(`${baseUrl}${endpoint}`);
        expect(protectedResponse.status).toBe(401);
      }
      const anonymousUpdate = await fetch(`${baseUrl}/api/configuration/agent`, {
        method: "PUT",
        headers: {
          Origin: config.application.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol" }),
      });
      expect(anonymousUpdate.status).toBe(401);

      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          Origin: config.application.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: TEST_ACCESS_CODE }),
      });
      const cookie = cookieFrom(login);
      const authenticatedHeaders = { Cookie: cookie };

      const initial = await fetch(`${baseUrl}/api/configuration`, { headers: authenticatedHeaders });
      expect(await initial.json()).toMatchObject({
        agent: {
          model: "gpt-5.6-terra",
          defaultModel: "gpt-5.6-terra",
          allowedModels: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
        },
        log: { count: 0, downloadUrl: "/api/agent/log/download" },
      });

      const crossOrigin = await fetch(`${baseUrl}/api/configuration/agent`, {
        method: "PUT",
        headers: {
          ...authenticatedHeaders,
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol" }),
      });
      expect(crossOrigin.status).toBe(403);

      const extraProperty = await fetch(`${baseUrl}/api/configuration/agent`, {
        method: "PUT",
        headers: {
          ...authenticatedHeaders,
          Origin: config.application.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", apiKey: "must-not-be-accepted" }),
      });
      expect(extraProperty.status).toBe(400);
      expect(await extraProperty.json()).toMatchObject({ error: "invalid_agent_configuration" });

      const rejected = await fetch(`${baseUrl}/api/configuration/agent`, {
        method: "PUT",
        headers: {
          ...authenticatedHeaders,
          Origin: config.application.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "unapproved-model" }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: "model_not_allowed" });

      const updated = await fetch(`${baseUrl}/api/configuration/agent`, {
        method: "PUT",
        headers: {
          ...authenticatedHeaders,
          Origin: config.application.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-luna" }),
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ agent: { model: "gpt-5.6-luna" } });

      const session = await fetch(`${baseUrl}/api/session`, { headers: authenticatedHeaders });
      expect(await session.json()).toMatchObject({ agent: { model: "gpt-5.6-luna" } });

      const agentTurn = await fetch(`${baseUrl}/api/agent/turn`, {
        method: "POST",
        headers: {
          ...authenticatedHeaders,
          Origin: config.application.publicOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "TOP-SECRET-PROMPT inspect the network.",
          tools: [TEST_WEBMCP_TOOL],
        }),
      });
      expect(agentTurn.status).toBe(200);
      expect(requests[0].model).toBe("gpt-5.6-luna");

      const logResponse = await fetch(`${baseUrl}/api/agent/log?limit=10`, { headers: authenticatedHeaders });
      const log = await logResponse.json();
      expect(log).toMatchObject({ total: 1, limit: 10 });
      expect(log.entries[0]).toMatchObject({
        category: "generic",
        model: "gpt-5.6-luna",
        outcome: "completed",
        inputTokens: 73,
        outputTokens: 19,
      });
      expect(JSON.stringify(log)).not.toContain("TOP-SECRET-PROMPT");
      expect(JSON.stringify(log)).not.toContain(config.openai.apiKey);

      const download = await fetch(`${baseUrl}/api/agent/log/download`, { headers: authenticatedHeaders });
      expect(download.headers.get("content-disposition")).toMatch(/attachment; filename="paris-icc-agent-log-/);
      const downloaded = await download.text();
      expect(downloaded).toContain("paris-icc-agent-log.v1");
      expect(downloaded).not.toContain("TOP-SECRET-PROMPT");
      expect(downloaded).not.toContain(config.openai.apiKey);

      await application.close();
      const restored = new AgentRuntimeStore(config);
      expect(restored.currentModel()).toBe("gpt-5.6-luna");
      expect(restored.entryCount()).toBe(1);
      await restored.close();
    } finally {
      await application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds newest-first entries and rolls back a failed sidecar write", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-agent-store-"));
    const config = parsedServerConfig();
    config.agent.logMaxEntries = 50;
    config.storage.agentRuntimePath = path.join(directory, "agent-runtime.json");
    const store = new AgentRuntimeStore(config, { now: (() => {
      let value = Date.UTC(2026, 7, 30, 12, 0, 0);
      return () => value++;
    })() });
    try {
      for (let index = 0; index < 55; index += 1) {
        await store.record({
          category: "generic",
          model: store.currentModel(),
          outcome: "completed",
          durationMs: index,
          runId: `run-${index}`,
        });
      }
      expect(store.entryCount()).toBe(50);
      expect(store.list(2).map((entry) => entry.runId)).toEqual(["run-54", "run-53"]);

      store.path = directory;
      await expect(store.updateModel("gpt-5.6-sol")).rejects.toBeDefined();
      expect(store.currentModel()).toBe("gpt-5.6-terra");

      store.path = path.join(directory, "recovered-agent-runtime.json");
      await expect(store.updateModel("gpt-5.6-luna")).resolves.toMatchObject({
        model: "gpt-5.6-luna",
      });
    } finally {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent records across a failed write and removes the failed temporary file", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-agent-concurrent-"));
    const config = parsedServerConfig();
    config.storage.agentRuntimePath = path.join(directory, "agent-runtime.json");
    let releaseFirstRename;
    let signalFirstRename;
    const firstRenameStarted = new Promise((resolve) => { signalFirstRename = resolve; });
    const firstRenameGate = new Promise((resolve) => { releaseFirstRename = resolve; });
    let renameCount = 0;
    const store = new AgentRuntimeStore(config, {
      rename: async (source, destination) => {
        renameCount += 1;
        if (renameCount === 1) {
          signalFirstRename();
          await firstRenameGate;
          throw new Error("injected first rename failure");
        }
        await renameFile(source, destination);
      },
    });

    try {
      const failedRecord = store.record({
        category: "generic",
        model: store.currentModel(),
        outcome: "completed",
        durationMs: 1,
        runId: "run-failed",
      });
      await firstRenameStarted;
      const failedExpectation = expect(failedRecord).rejects.toThrow("injected first rename failure");
      const successfulRecord = store.record({
        category: "incident",
        model: store.currentModel(),
        outcome: "tool_calls",
        durationMs: 2,
        runId: "run-success",
        toolNames: ["inspect_incident_decision_context"],
      });
      releaseFirstRename();

      await failedExpectation;
      await expect(successfulRecord).resolves.toMatchObject({ runId: "run-success" });
      expect(store.list(10).map((entry) => entry.runId)).toEqual(["run-success"]);
      const persisted = JSON.parse(readFileSync(config.storage.agentRuntimePath, "utf8"));
      expect(persisted.entries.map((entry) => entry.runId)).toEqual(["run-success"]);
      expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      releaseFirstRename?.();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
