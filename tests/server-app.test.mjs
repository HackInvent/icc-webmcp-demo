import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createParisIccServer } from "../server/app.mjs";
import { parsedServerConfig, TEST_ACCESS_CODE } from "./server-fixture.mjs";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

async function startServer() {
  const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-server-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>Paris ICC test</title>");
  const config = parsedServerConfig({ openai: { enabled: false, apiKey: "" } });
  config.server.distDirectory = directory;
  config.storage.databasePath = path.join(directory, "operations.sqlite");
  const { server, close } = createParisIccServer(config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { baseUrl, config };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie.");
  return value.split(";", 1)[0];
}

describe("deployable HTTP server", () => {
  it("serves health/static content with production security headers", async () => {
    const { baseUrl } = await startServer();
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", dataMode: "local-simulation" });
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const page = await fetch(baseUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Paris ICC test");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("authenticates by code, exposes no secrets, and protects agent routes", async () => {
    const { baseUrl, config } = await startServer();
    const anonymous = await fetch(`${baseUrl}/api/session`);
    const anonymousBody = await anonymous.json();
    expect(anonymousBody.authenticated).toBe(false);
    expect(JSON.stringify(anonymousBody)).not.toContain(config.auth.sessionSecret);

    const unauthorizedAgent = await fetch(`${baseUrl}/api/agent/turn`, {
      method: "POST",
      headers: {
        Origin: config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "Inspect" }),
    });
    expect(unauthorizedAgent.status).toBe(401);

    const invalid = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "incorrect" }),
    });
    expect(invalid.status).toBe(401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: TEST_ACCESS_CODE }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");

    const authenticated = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: cookie },
    });
    expect(await authenticated.json()).toMatchObject({ authenticated: true });
  });

  it("rejects cross-origin login requests", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: TEST_ACCESS_CODE }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "origin_rejected" });
  });
});
