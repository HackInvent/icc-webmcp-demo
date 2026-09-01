import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createParisIccServer } from "../server/app.mjs";
import { parsedServerConfig, TEST_ACCESS_CODE } from "./server-fixture.mjs";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function environment() {
  const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-shift-report-"));
  const distDirectory = path.join(directory, "dist");
  mkdirSync(distDirectory);
  writeFileSync(path.join(distDirectory, "index.html"), "<!doctype html><title>Paris ICC</title>");
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return {
    databasePath: path.join(directory, "operations.sqlite"),
    distDirectory,
  };
}

async function start(target) {
  const config = parsedServerConfig({
    openai: { enabled: false, apiKey: "" },
    storage: { databasePath: target.databasePath, tickIntervalMs: 5_000 },
  });
  config.server.distDirectory = target.distDirectory;
  const application = createParisIccServer(config);
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  cleanups.push(async () => application.close());
  return { ...application, config, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function login(application) {
  const response = await fetch(`${application.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      Origin: application.config.application.publicOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code: TEST_ACCESS_CODE }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function snapshot(application, cookie) {
  const response = await fetch(`${application.baseUrl}/api/operations/snapshot`, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function command(application, cookie, body) {
  const response = await fetch(`${application.baseUrl}/api/operations/commands`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: application.config.application.publicOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

describe("persisted shift log and end-of-shift report", () => {
  it("survives restart, freezes editing, and starts a clean workspace on reset", async () => {
    const target = environment();
    const firstServer = await start(target);
    const cookie = await login(firstServer);
    const initial = await snapshot(firstServer, cookie);
    expect(initial.shift).toMatchObject({
      shiftId: expect.any(String),
      logs: expect.arrayContaining([
        expect.objectContaining({ eventType: "shift-started" }),
      ]),
      report: {
        reportId: expect.any(String),
        status: "draft",
        contentHtml: expect.stringContaining("End-of-shift operational report"),
      },
    });

    const paused = await command(firstServer, cookie, {
      commandId: "CMD-SHIFT-PAUSE-0001",
      type: "set_speed",
      expectedStateRevision: initial.stateRevision,
      payload: { speed: 0 },
    });
    expect(paused.response.status).toBe(200);
    expect(paused.body.snapshot.shift.logs.at(-1)).toMatchObject({
      category: "operator-action",
      eventType: "clock-rate-changed",
      actor: "operator",
      recordedAt: expect.any(Number),
      operationalTime: expect.any(Number),
    });

    const edited = await command(firstServer, cookie, {
      commandId: "CMD-SHIFT-REPORT-EDIT-01",
      type: "update_shift_report",
      expectedStateRevision: paused.body.stateRevision,
      payload: {
        reportId: initial.shift.report.reportId,
        contentHtml: "<h1>Shift report</h1><p onclick=\"bad()\"><strong>Reviewed</strong></p><script>bad()</script>",
        source: "operator",
      },
    });
    expect(edited.response.status).toBe(200);
    expect(edited.body.snapshot.shift.report.contentHtml).toBe(
      "<h1>Shift report</h1><p><strong>Reviewed</strong></p>",
    );

    const assistedResponse = await fetch(`${firstServer.baseUrl}/api/reports/assist`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: firstServer.config.application.publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reportId: initial.shift.report.reportId }),
    });
    expect(assistedResponse.status).toBe(200);
    expect(await assistedResponse.json()).toMatchObject({
      status: "draft_ready",
      reportId: initial.shift.report.reportId,
      modelAssisted: false,
      sourceLogCount: expect.any(Number),
      html: expect.stringContaining("Incident narratives and actions"),
    });

    await firstServer.close();
    const secondServer = await start(target);
    const restored = await snapshot(secondServer, cookie);
    expect(restored.shift.shiftId).toBe(initial.shift.shiftId);
    expect(restored.shift.report.contentHtml).toContain("<strong>Reviewed</strong>");
    expect(restored.shift.logs.some((entry) => entry.eventType === "clock-rate-changed")).toBe(true);

    const frozen = await command(secondServer, cookie, {
      commandId: "CMD-SHIFT-REPORT-FREEZE",
      type: "freeze_shift_report",
      expectedStateRevision: restored.stateRevision,
      payload: { reportId: restored.shift.report.reportId },
    });
    expect(frozen.response.status).toBe(200);
    expect(frozen.body.snapshot.shift.report).toMatchObject({
      status: "frozen",
      frozenAt: expect.any(Number),
    });

    const rejectedEdit = await command(secondServer, cookie, {
      commandId: "CMD-SHIFT-REPORT-EDIT-02",
      type: "update_shift_report",
      expectedStateRevision: frozen.body.stateRevision,
      payload: {
        reportId: restored.shift.report.reportId,
        contentHtml: "<p>Must not be accepted</p>",
        source: "operator",
      },
    });
    expect(rejectedEdit.response.status).toBe(409);
    expect(rejectedEdit.body).toMatchObject({ error: "report_frozen" });

    const reset = await command(secondServer, cookie, {
      commandId: "CMD-SHIFT-RESET-00001",
      type: "reset_all",
      expectedStateRevision: frozen.body.stateRevision,
      payload: {},
    });
    expect(reset.response.status).toBe(200);
    expect(reset.body.snapshot.shift.shiftId).not.toBe(initial.shift.shiftId);
    expect(reset.body.snapshot.shift.report).toMatchObject({ status: "draft" });
    expect(reset.body.snapshot.shift.report.contentHtml).not.toContain("Reviewed");
    expect(reset.body.snapshot.shift.logs.some((entry) => entry.eventType === "clock-rate-changed")).toBe(false);
    expect(reset.body.snapshot.shift.logs.at(-1)).toMatchObject({ eventType: "workspace-reset" });
  });
});
