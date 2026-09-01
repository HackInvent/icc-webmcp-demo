import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createParisIccServer } from "../server/app.mjs";
import { parsedServerConfig, TEST_ACCESS_CODE } from "./server-fixture.mjs";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function temporaryEnvironment() {
  const directory = mkdtempSync(path.join(tmpdir(), "paris-icc-operations-http-"));
  const distDirectory = path.join(directory, "dist");
  mkdirSync(distDirectory);
  writeFileSync(path.join(distDirectory, "index.html"), "<!doctype html><title>Paris ICC</title>");
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return {
    databasePath: path.join(directory, "operations.sqlite"),
    distDirectory,
  };
}

async function startServer(environment, tickIntervalMs = 5_000) {
  const config = parsedServerConfig({
    openai: { enabled: false, apiKey: "" },
    storage: {
      databasePath: environment.databasePath,
      tickIntervalMs,
    },
  });
  config.server.distDirectory = environment.distDirectory;
  const application = createParisIccServer(config);
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => application.close());
  return { ...application, baseUrl, config };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie.");
  return value.split(";", 1)[0];
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
  return cookieFrom(response);
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

async function audit(application, cookie) {
  const response = await fetch(`${application.baseUrl}/api/operations/audit`, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()).events;
}

async function eventually(read, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the expected operational state.");
}

describe("server-authoritative operations HTTP API", () => {
  it("protects the API, isolates signed sessions, persists refresh, and emits stream revisions", async () => {
    const environment = temporaryEnvironment();
    const application = await startServer(environment);

    expect((await fetch(`${application.baseUrl}/api/operations/snapshot`)).status).toBe(401);
    const firstCookie = await login(application);
    const session = await fetch(`${application.baseUrl}/api/session`, {
      headers: { Cookie: firstCookie },
    });
    expect(await session.json()).toMatchObject({ authenticated: true });

    const initial = await snapshot(application, firstCookie);
    expect(initial).toMatchObject({
      schema: "paris-icc-operations-runtime-v1",
      stateRevision: expect.any(Number),
      streamRevision: expect.any(Number),
    });
    const parallelCookie = await login(application);
    const parallelInitial = await snapshot(application, parallelCookie);
    expect(parallelInitial.runId).not.toBe(initial.runId);
    const envelope = {
      commandId: "CMD-HTTP-PAUSE-0001",
      type: "set_speed",
      expectedStateRevision: initial.stateRevision,
      payload: { speed: 0 },
    };
    const applied = await command(application, firstCookie, envelope);
    expect(applied.response.status).toBe(200);
    expect(applied.body).toMatchObject({
      commandId: envelope.commandId,
      stateRevision: initial.stateRevision + 1,
      result: { speed: 0 },
    });

    const refreshed = await snapshot(application, firstCookie);
    expect(refreshed).toMatchObject({
      runId: initial.runId,
      stateRevision: applied.body.stateRevision,
      native: { speed: 0 },
      detailed: { speed: 0 },
    });
    expect(await snapshot(application, parallelCookie)).toMatchObject({
      runId: parallelInitial.runId,
      stateRevision: parallelInitial.stateRevision,
      native: { speed: parallelInitial.native.speed },
      detailed: { speed: parallelInitial.detailed.speed },
    });
    expect((await audit(application, parallelCookie))
      .some((event) => event.commandId === envelope.commandId)).toBe(false);

    const streamController = new AbortController();
    const streamResponse = await fetch(`${application.baseUrl}/api/operations/events`, {
      headers: { Cookie: firstCookie },
      signal: streamController.signal,
    });
    expect(streamResponse.status).toBe(200);
    const firstChunk = await streamResponse.body.getReader().read();
    const streamText = new TextDecoder().decode(firstChunk.value);
    expect(streamText).toContain(`id: ${refreshed.streamRevision}`);
    expect(streamText).toContain("event: snapshot");
    streamController.abort();

    const logout = await fetch(`${application.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: firstCookie,
        Origin: application.config.application.publicOrigin,
      },
    });
    expect(logout.status).toBe(200);
    const secondCookie = await login(application);
    expect(secondCookie).not.toBe(firstCookie);
    const fresh = await snapshot(application, secondCookie);
    expect(fresh.runId).not.toBe(initial.runId);
    expect(fresh.runId).not.toBe(parallelInitial.runId);
    expect(fresh.native.speed).toBe(initial.native.speed);
  });

  it("enforces stale revisions and exact command-id idempotence without duplicate events", async () => {
    const application = await startServer(temporaryEnvironment());
    const cookie = await login(application);
    const initial = await snapshot(application, cookie);
    const envelope = {
      commandId: "CMD-HTTP-IDEMPOTENT-01",
      type: "set_speed",
      expectedStateRevision: initial.stateRevision,
      payload: { speed: 0 },
    };

    const first = await command(application, cookie, envelope);
    const replay = await command(application, cookie, envelope);
    expect(first.response.status).toBe(200);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const changedPayload = await command(application, cookie, {
      ...envelope,
      payload: { speed: 2 },
    });
    expect(changedPayload.response.status).toBe(409);
    expect(changedPayload.body).toMatchObject({ error: "command_id_reused" });

    const changedExpectedRevision = await command(application, cookie, {
      ...envelope,
      expectedStateRevision: first.body.stateRevision,
    });
    expect(changedExpectedRevision.response.status).toBe(409);
    expect(changedExpectedRevision.body).toMatchObject({ error: "command_id_reused" });

    const stale = await command(application, cookie, {
      commandId: "CMD-HTTP-STALE-00001",
      type: "set_speed",
      expectedStateRevision: initial.stateRevision,
      payload: { speed: 2 },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: "stale_state_revision",
      details: {
        expectedStateRevision: initial.stateRevision,
        currentStateRevision: first.body.stateRevision,
      },
    });

    const current = await snapshot(application, cookie);
    expect(current).toMatchObject({
      stateRevision: first.body.stateRevision,
      native: { speed: 0 },
    });
    const commandEvents = (await audit(application, cookie))
      .filter((event) => event.commandId === envelope.commandId);
    expect(commandEvents).toHaveLength(1);
  });

  it("restores state and exact command receipts after a SQLite-backed server restart", async () => {
    const environment = temporaryEnvironment();
    const firstServer = await startServer(environment);
    const firstCookie = await login(firstServer);
    const initial = await snapshot(firstServer, firstCookie);
    const envelope = {
      commandId: "CMD-HTTP-RESTART-001",
      type: "set_speed",
      expectedStateRevision: initial.stateRevision,
      payload: { speed: 0 },
    };
    const committed = await command(firstServer, firstCookie, envelope);
    expect(committed.response.status).toBe(200);
    await firstServer.close();

    const secondServer = await startServer(environment);
    const restored = await snapshot(secondServer, firstCookie);
    expect(restored).toMatchObject({
      runId: initial.runId,
      stateRevision: committed.body.stateRevision,
      streamRevision: committed.body.snapshot.streamRevision,
      native: { speed: 0 },
      detailed: { speed: 0 },
    });

    const replay = await command(secondServer, firstCookie, envelope);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(committed.body);
    expect((await audit(secondServer, firstCookie))
      .filter((event) => event.commandId === envelope.commandId)).toHaveLength(1);
  });

  it("promotes a due planned incident to a new decision revision and audit event", async () => {
    const application = await startServer(temporaryEnvironment(), 250);
    const cookie = await login(application);
    const initial = await snapshot(application, cookie);
    const section = initial.detailed.snapshot.powerSections[0];
    const envelope = {
      commandId: "CMD-HTTP-SCHEDULE-001",
      type: "schedule_power_incident",
      expectedStateRevision: initial.stateRevision,
      payload: {
        targetType: "power",
        targetId: section.id,
        lineCode: section.lineIds[0],
        type: "power",
        severity: "high",
        effect: "isolate-power",
        occurrenceTime: initial.detailed.snapshot.timestamp + 1,
        title: "Scheduled traction isolation",
        summary: "Activation verifies server-side scheduled decision transitions.",
      },
    };
    const scheduled = await command(application, cookie, envelope);
    expect(scheduled.response.status).toBe(200);
    const incidentId = scheduled.body.result.incident.id;
    expect(scheduled.body.result.incident.status).toBe("planned");

    const activated = await eventually(
      () => snapshot(application, cookie),
      (candidate) => candidate.detailed.snapshot.incidents.some(
        (incident) => incident.id === incidentId && incident.status === "active",
      ),
    );
    expect(activated.stateRevision).toBe(scheduled.body.stateRevision + 1);
    expect(activated.streamRevision).toBeGreaterThan(scheduled.body.snapshot.streamRevision);
    expect(await audit(application, cookie)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "scheduled_state_transition",
        stateRevision: activated.stateRevision,
      }),
    ]));
  });

  it("replays a durable evaluation receipt and applies it after a server restart", async () => {
    const environment = temporaryEnvironment();
    const firstServer = await startServer(environment);
    const firstCookie = await login(firstServer);
    const initial = await snapshot(firstServer, firstCookie);
    const incident = initial.native.incidents.find((candidate) => candidate.status === "active");
    expect(incident).toBeDefined();
    const evaluationEnvelope = {
      commandId: "CMD-HTTP-EVALUATE-001",
      type: "evaluate_native_response",
      expectedStateRevision: initial.stateRevision,
      payload: { incidentId: incident.id },
    };

    const evaluated = await command(firstServer, firstCookie, evaluationEnvelope);
    expect(evaluated.response.status).toBe(200);
    const evaluation = evaluated.body.result.evaluation;
    expect(evaluation).toMatchObject({
      incidentId: incident.id,
      decisionRevision: initial.native.decisionRevision,
      recommendedOptionId: expect.any(String),
    });
    await firstServer.close();

    const secondServer = await startServer(environment);
    const restored = await snapshot(secondServer, firstCookie);
    const replayed = await command(secondServer, firstCookie, evaluationEnvelope);
    expect(replayed.response.status).toBe(200);
    expect(replayed.body).toEqual(evaluated.body);

    const applied = await command(secondServer, firstCookie, {
      commandId: "CMD-HTTP-APPLY-EVAL-01",
      type: "apply_native_response",
      expectedStateRevision: restored.stateRevision,
      payload: {
        evaluationId: evaluation.id,
        optionId: evaluation.recommendedOptionId,
        expectedDecisionRevision: evaluation.decisionRevision,
      },
    });
    expect(applied.response.status).toBe(200);
    expect(applied.body.result.applied).toMatchObject({
      ok: true,
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
      decisionRevision: evaluation.decisionRevision + 1,
    });
    expect(applied.body.snapshot.native.lastDecision).toMatchObject({
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
    });

    await secondServer.close();
    const thirdServer = await startServer(environment);
    expect(await snapshot(thirdServer, firstCookie)).toMatchObject({
      stateRevision: applied.body.stateRevision,
      native: {
        decisionRevision: evaluation.decisionRevision + 1,
        lastDecision: {
          evaluationId: evaluation.id,
          optionId: evaluation.recommendedOptionId,
        },
      },
    });
  });

  it("keeps a reviewed evaluation applicable after a rejected command rollback", async () => {
    const application = await startServer(temporaryEnvironment());
    const cookie = await login(application);
    const initial = await snapshot(application, cookie);
    const incident = initial.native.incidents.find((candidate) => candidate.status === "active");
    expect(incident).toBeDefined();
    const evaluated = await command(application, cookie, {
      commandId: "CMD-HTTP-EVALUATE-ROLL",
      type: "evaluate_native_response",
      expectedStateRevision: initial.stateRevision,
      payload: { incidentId: incident.id },
    });
    expect(evaluated.response.status).toBe(200);
    const evaluation = evaluated.body.result.evaluation;

    const rejected = await command(application, cookie, {
      commandId: "CMD-HTTP-REJECT-EVAL-1",
      type: "apply_native_response",
      expectedStateRevision: evaluated.body.stateRevision,
      payload: {
        evaluationId: evaluation.id,
        optionId: "not-a-reviewed-option",
        expectedDecisionRevision: evaluation.decisionRevision,
      },
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "unknown_option" });
    const afterRollback = await snapshot(application, cookie);
    expect(afterRollback.stateRevision).toBe(evaluated.body.stateRevision);

    const applied = await command(application, cookie, {
      commandId: "CMD-HTTP-APPLY-ROLL-01",
      type: "apply_native_response",
      expectedStateRevision: afterRollback.stateRevision,
      payload: {
        evaluationId: evaluation.id,
        optionId: evaluation.recommendedOptionId,
        expectedDecisionRevision: evaluation.decisionRevision,
      },
    });
    expect(applied.response.status).toBe(200);
    expect(applied.body.result.applied).toMatchObject({
      ok: true,
      evaluationId: evaluation.id,
      optionId: evaluation.recommendedOptionId,
    });
  });
});
