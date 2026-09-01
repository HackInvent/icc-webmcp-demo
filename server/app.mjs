import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentProtocolError, AgentService } from "./agent.mjs";
import { AgentRuntimeStore } from "./agent-runtime-store.mjs";
import {
  createBoundedSseWriter,
  snapshotStreamRevision,
} from "./bounded-sse-writer.mjs";
import { createOperationsRepository, OperationsRepositoryConflictError } from "./operations-repository.mjs";
import { createOperationsService, OperationsError } from "./operations-service.ts";
import { buildShiftReportHtml, shiftReportEvidence } from "./shift-report.mjs";
import { publicRuntimeConfiguration } from "./config.mjs";
import {
  parseCookies,
  serializeExpiredCookie,
  serializeSessionCookie,
  SessionCodec,
  SlidingWindowLimiter,
  verifyAccessCode,
} from "./security.mjs";

function operationsWorkspaceId(session) {
  return session.sid;
}

const LINE_REFS = Object.freeze({
  RER_A: "STIF:Line::C01742:",
  RER_B: "STIF:Line::C01743:",
  M13: "STIF:Line::C01383:",
  M14: "STIF:Line::C01384:",
});

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function setSecurityHeaders(response, config, requestId) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );
  response.setHeader("X-Request-Id", requestId);
  if (config.application.publicOrigin.startsWith("https://")) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function sendJson(response, status, body, headers = {}) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(encoded);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, headers);
  response.end();
}

async function readJson(request, maximumBytes) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json_required", "Content-Type application/json is required.");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) {
      throw new HttpError(413, "request_too_large", "The request body is too large.");
    }
    chunks.push(chunk);
  }
  if (length === 0) throw new HttpError(400, "json_required", "A JSON request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function methodAllowed(request, method) {
  if (request.method !== method) {
    throw new HttpError(405, "method_not_allowed", `${method} is required.`, { Allow: method });
  }
}

function enforceSameOrigin(request, config) {
  const origin = request.headers.origin;
  if (origin && origin !== config.application.publicOrigin) {
    throw new HttpError(403, "origin_rejected", "The request origin is not allowed.");
  }
}

function clientAddress(request, config) {
  if (config.server.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim().slice(0, 120);
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}

function authenticate(request, config, sessionCodec) {
  const token = parseCookies(request.headers.cookie)[config.auth.cookieName];
  return sessionCodec.verify(token);
}

function requireSession(request, config, sessionCodec) {
  const session = authenticate(request, config, sessionCodec);
  if (!session) throw new HttpError(401, "authentication_required", "Enter the access code to continue.");
  return session;
}

function staticCacheControl(filePath) {
  if (path.basename(filePath) === "index.html") return "no-store";
  if (/[/\\]assets[/\\].+\.[A-Za-z0-9_-]{8,}\./.test(filePath)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300";
}

async function sendFile(request, response, filePath) {
  const information = await stat(filePath);
  if (!information.isFile()) throw new HttpError(404, "not_found", "Resource not found.");
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": information.size,
    "Cache-Control": staticCacheControl(filePath),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    response.on("close", resolve);
    response.on("finish", resolve);
    stream.pipe(response);
  });
}

async function serveStatic(request, response, url, config) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed", "GET or HEAD is required.", { Allow: "GET, HEAD" });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "invalid_path", "The request path is invalid.");
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(config.server.distDirectory, relative);
  const rootPrefix = `${config.server.distDirectory}${path.sep}`;
  if (candidate !== path.join(config.server.distDirectory, "index.html") && !candidate.startsWith(rootPrefix)) {
    throw new HttpError(403, "path_rejected", "The request path is not allowed.");
  }
  try {
    await sendFile(request, response, candidate);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof HttpError && error.status === 404)) throw error;
    await sendFile(request, response, path.join(config.server.distDirectory, "index.html"));
  }
}

async function proxyPrim(request, response, url, config, fetchImpl) {
  methodAllowed(request, "GET");
  if (!config.prim.enabled) {
    throw new HttpError(503, "prim_not_configured", "The optional PRIM connector is disabled.");
  }
  const lineId = url.searchParams.get("lineId");
  if (!lineId || !Object.hasOwn(LINE_REFS, lineId)) {
    throw new HttpError(400, "invalid_line", `Allowed lines: ${Object.keys(LINE_REFS).join(", ")}.`);
  }
  const upstreamUrl = new URL(config.prim.apiUrl);
  upstreamUrl.searchParams.set("LineRef", LINE_REFS[lineId]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.prim.timeoutMs);
  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      headers: { Accept: "application/json", apikey: config.prim.apiKey },
      signal: controller.signal,
    });
  } catch (error) {
    throw new HttpError(
      error instanceof Error && error.name === "AbortError" ? 504 : 502,
      error instanceof Error && error.name === "AbortError" ? "prim_timeout" : "prim_unavailable",
      "The PRIM evidence source is unavailable.",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!upstream.ok) {
    throw new HttpError(502, "prim_upstream_error", `PRIM returned status ${upstream.status}.`);
  }
  const payload = await upstream.text();
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "private, max-age=15",
    "X-Prim-Line-Id": lineId,
  });
  response.end(payload);
}

async function openOperationsStream(
  request,
  response,
  operations,
  workspaceId,
  streams,
  isShuttingDown,
) {
  let ready = false;
  let preReadySnapshot = null;
  let cleaned = false;
  let unsubscribe = () => {};
  let writer = null;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    response.off("close", cleanup);
    response.off("finish", cleanup);
    response.off("error", cleanup);
    request.off("aborted", cleanup);
    writer?.stop();
    unsubscribe();
    streams.delete(response);
  };
  response.once("close", cleanup);
  response.once("finish", cleanup);
  response.once("error", cleanup);
  request.once("aborted", cleanup);

  const listener = (snapshot) => {
    if (!ready) {
      if (
        preReadySnapshot === null ||
        snapshotStreamRevision(snapshot) > snapshotStreamRevision(preReadySnapshot)
      ) {
        preReadySnapshot = snapshot;
      }
      return;
    }
    writer.offerSnapshot(snapshot);
  };

  try {
    const subscription = await operations.subscribe(workspaceId, listener);
    if (cleaned) {
      subscription();
      return;
    }
    unsubscribe = subscription;
    const initialSnapshot = await operations.getSnapshot(workspaceId);
    if (cleaned || response.destroyed || isShuttingDown()) {
      cleanup();
      response.destroy();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    writer = createBoundedSseWriter(response, { onTerminate: cleanup });
    streams.add(response);
    ready = true;
    writer.offerSnapshot(initialSnapshot);
    if (
      preReadySnapshot &&
      snapshotStreamRevision(preReadySnapshot) > snapshotStreamRevision(initialSnapshot)
    ) {
      writer.offerSnapshot(preReadySnapshot);
    }
    preReadySnapshot = null;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function handleError(response, error, requestId) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof OperationsRepositoryConflictError) {
    sendJson(response, 409, {
      error: "stale_state_revision",
      message: error.message,
      details: error.details ?? {},
      requestId,
    });
    return;
  }
  if (error instanceof HttpError || error instanceof AgentProtocolError || error instanceof OperationsError) {
    sendJson(response, error.status, {
      error: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    }, error.headers);
    return;
  }
  console.error(`[${requestId}] Unhandled server error`, error);
  sendJson(response, 500, {
    error: "internal_error",
    message: "The server could not complete this request.",
    requestId,
  });
}

export function createParisIccServer(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const sessionCodec = new SessionCodec({
    secret: config.auth.sessionSecret,
    ttlMinutes: config.auth.sessionTtlMinutes,
    now,
  });
  const loginLimiter = new SlidingWindowLimiter({
    limit: config.auth.maxFailedAttempts,
    windowMs: config.auth.failureWindowSeconds * 1_000,
    now,
  });
  const agentLimiter = new SlidingWindowLimiter({
    limit: config.agent.requestsPerMinute,
    windowMs: 60_000,
    now,
  });
  const agentRuntimeStore = options.agentRuntimeStore ?? new AgentRuntimeStore(config, { now });
  const agentService = new AgentService(config, { fetchImpl, now, runtimeStore: agentRuntimeStore });
  const operationsPromise = options.operationsService
    ? Promise.resolve(options.operationsService)
    : createOperationsRepository({
        databasePath: config.storage.databasePath,
        now,
      }).then((repository) => createOperationsService({
        repository,
        now,
        tickIntervalMs: config.storage.tickIntervalMs,
      }));
  const operationStreams = new Set();
  let operationsShuttingDown = false;

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    setSecurityHeaders(response, config, requestId);
    try {
      const url = new URL(request.url ?? "/", config.application.publicOrigin);
      if (url.pathname === "/healthz") {
        methodAllowed(request, "GET");
        const operations = await operationsPromise;
        sendJson(response, 200, {
          status: "ok",
          service: "paris-icc-webmcp",
          dataMode: config.application.dataMode,
          storage: { ready: operations.health().ready, engine: "sqlite" },
        });
        return;
      }
      if (url.pathname === "/api/session") {
        methodAllowed(request, "GET");
        const authenticated = Boolean(authenticate(request, config, sessionCodec));
        sendJson(response, 200, publicRuntimeConfiguration(config, authenticated, {
          model: agentRuntimeStore.currentModel(),
        }));
        return;
      }
      if (url.pathname === "/api/operations/snapshot") {
        methodAllowed(request, "GET");
        const session = requireSession(request, config, sessionCodec);
        const operations = await operationsPromise;
        const snapshot = await operations.getSnapshot(operationsWorkspaceId(session));
        sendJson(response, 200, snapshot, {
          ETag: `"operations-${snapshot.streamRevision ?? snapshot.stateRevision}"`,
        });
        return;
      }
      if (url.pathname === "/api/operations/events") {
        methodAllowed(request, "GET");
        const session = requireSession(request, config, sessionCodec);
        await openOperationsStream(
          request,
          response,
          await operationsPromise,
          operationsWorkspaceId(session),
          operationStreams,
          () => operationsShuttingDown,
        );
        return;
      }
      if (url.pathname === "/api/operations/commands") {
        methodAllowed(request, "POST");
        enforceSameOrigin(request, config);
        const session = requireSession(request, config, sessionCodec);
        const body = await readJson(request, config.server.maxRequestBodyBytes);
        const operations = await operationsPromise;
        sendJson(response, 200, await operations.command(operationsWorkspaceId(session), session.sid, body));
        return;
      }
      if (url.pathname === "/api/operations/audit") {
        methodAllowed(request, "GET");
        const session = requireSession(request, config, sessionCodec);
        const afterSequence = Number(url.searchParams.get("after") ?? 0);
        const operations = await operationsPromise;
        sendJson(response, 200, {
          events: await operations.listEvents(operationsWorkspaceId(session), {
            afterSequence: Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0,
            limit: 100,
          }),
        });
        return;
      }
      if (url.pathname === "/api/auth/login") {
        methodAllowed(request, "POST");
        enforceSameOrigin(request, config);
        const address = clientAddress(request, config);
        const attempt = loginLimiter.attempt(address);
        if (!attempt.allowed) {
          throw new HttpError(
            429,
            "too_many_attempts",
            "Too many access-code attempts. Please wait before retrying.",
            { "Retry-After": String(attempt.retryAfterSeconds) },
          );
        }
        const body = await readJson(request, config.server.maxRequestBodyBytes);
        const code = typeof body?.code === "string" ? body.code : "";
        if (!verifyAccessCode(code, config.auth.accessCodeHash)) {
          throw new HttpError(401, "invalid_access_code", "The access code is not valid.");
        }
        loginLimiter.reset(address);
        const issued = sessionCodec.issue();
        sendJson(
          response,
          200,
          publicRuntimeConfiguration(config, true, {
            model: agentRuntimeStore.currentModel(),
          }),
          {
            "Set-Cookie": serializeSessionCookie(
              config.auth.cookieName,
              issued.token,
              config.auth,
            ),
          },
        );
        return;
      }
      if (url.pathname === "/api/auth/logout") {
        methodAllowed(request, "POST");
        enforceSameOrigin(request, config);
        sendJson(response, 200, { status: "signed_out" }, {
          "Set-Cookie": serializeExpiredCookie(
            config.auth.cookieName,
            config.auth.secureCookies,
          ),
        });
        return;
      }
      if (url.pathname === "/api/configuration") {
        methodAllowed(request, "GET");
        requireSession(request, config, sessionCodec);
        sendJson(response, 200, {
          agent: {
            ...agentRuntimeStore.configuration(),
            reasoningEffort: config.openai.reasoningEffort,
            maxToolRounds: config.agent.maxToolRounds,
          },
          log: {
            count: agentRuntimeStore.entryCount(),
            retainedEntries: agentRuntimeStore.entryCount(),
            maximumEntries: config.agent.logMaxEntries,
            downloadUrl: "/api/agent/log/download",
          },
        });
        return;
      }
      if (url.pathname === "/api/configuration/agent") {
        methodAllowed(request, "PUT");
        enforceSameOrigin(request, config);
        requireSession(request, config, sessionCodec);
        const body = await readJson(request, config.server.maxRequestBodyBytes);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          typeof body.model !== "string"
        ) {
          throw new HttpError(400, "invalid_agent_configuration", "The request must contain exactly one model identifier.");
        }
        if (!config.openai.allowedModels.includes(body.model)) {
          throw new HttpError(400, "model_not_allowed", "The requested model is not allowed by server configuration.");
        }
        const updated = await agentRuntimeStore.updateModel(body.model);
        sendJson(response, 200, {
          agent: {
            ...updated,
            reasoningEffort: config.openai.reasoningEffort,
            maxToolRounds: config.agent.maxToolRounds,
          },
        });
        return;
      }
      if (url.pathname === "/api/agent/log") {
        methodAllowed(request, "GET");
        requireSession(request, config, sessionCodec);
        const requestedLimit = Number(url.searchParams.get("limit") ?? 200);
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > config.agent.logMaxEntries) {
          throw new HttpError(400, "invalid_log_limit", `limit must be an integer between 1 and ${config.agent.logMaxEntries}.`);
        }
        sendJson(response, 200, {
          entries: agentRuntimeStore.list(requestedLimit),
          total: agentRuntimeStore.entryCount(),
          limit: requestedLimit,
        });
        return;
      }
      if (url.pathname === "/api/agent/log/download") {
        methodAllowed(request, "GET");
        requireSession(request, config, sessionCodec);
        const date = new Date(now()).toISOString().slice(0, 10);
        sendJson(response, 200, agentRuntimeStore.export(), {
          "Content-Disposition": `attachment; filename="paris-icc-agent-log-${date}.json"`,
        });
        return;
      }
      if (url.pathname === "/api/reports/assist") {
        methodAllowed(request, "POST");
        enforceSameOrigin(request, config);
        const session = requireSession(request, config, sessionCodec);
        const limit = agentLimiter.attempt(session.sid);
        if (!limit.allowed) {
          throw new HttpError(429, "agent_rate_limit", "The report-assistant request limit was reached.", {
            "Retry-After": String(limit.retryAfterSeconds),
          });
        }
        const body = await readJson(request, config.server.maxRequestBodyBytes);
        const operations = await operationsPromise;
        const snapshot = await operations.getSnapshot(operationsWorkspaceId(session));
        if (typeof body?.reportId !== "string" || body.reportId !== snapshot.shift.report.reportId) {
          throw new HttpError(409, "stale_report", "The report changed after an operational reset.");
        }
        if (snapshot.shift.report.status === "frozen") {
          throw new HttpError(409, "report_frozen", "The frozen report cannot be replaced by an agent draft.");
        }
        let assisted = null;
        let usage;
        let warning = null;
        if (config.openai.enabled) {
          const generated = await agentService.draftShiftReport(
            shiftReportEvidence(snapshot.shift),
          );
          assisted = generated.draft;
          usage = generated.usage;
        } else {
          warning = "OpenAI is disabled; a deterministic log chronology was prepared for operator review.";
        }
        sendJson(response, 200, {
          status: "draft_ready",
          reportId: snapshot.shift.report.reportId,
          html: buildShiftReportHtml(snapshot.shift, assisted),
          modelAssisted: Boolean(assisted),
          warning,
          sourceLogCount: snapshot.shift.logs.length,
          sourceLogSequence: snapshot.shift.nextLogSequence - 1,
          usage,
        });
        return;
      }
      if (url.pathname === "/api/agent/turn") {
        methodAllowed(request, "POST");
        enforceSameOrigin(request, config);
        const session = requireSession(request, config, sessionCodec);
        const limit = agentLimiter.attempt(session.sid);
        if (!limit.allowed) {
          throw new HttpError(429, "agent_rate_limit", "The agent request limit was reached.", {
            "Retry-After": String(limit.retryAfterSeconds),
          });
        }
        const body = await readJson(request, config.server.maxRequestBodyBytes);
        sendJson(response, 200, await agentService.turn(session.sid, body));
        return;
      }
      if (url.pathname === "/api/agent/reset") {
        methodAllowed(request, "POST");
        enforceSameOrigin(request, config);
        const session = requireSession(request, config, sessionCodec);
        const body = await readJson(request, config.server.maxRequestBodyBytes);
        if (typeof body?.runId === "string") agentService.reset(session.sid, body.runId);
        sendJson(response, 200, { status: "reset" });
        return;
      }
      if (
        url.pathname === "/api/prim-line" ||
        url.pathname === "/.netlify/functions/prim-line"
      ) {
        requireSession(request, config, sessionCodec);
        await proxyPrim(request, response, url, config, fetchImpl);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        throw new HttpError(404, "not_found", "API route not found.");
      }
      await serveStatic(request, response, url, config);
    } catch (error) {
      handleError(response, error, requestId);
    }
  });

  let operationsClosePromise = null;
  let closePromise = null;
  const closeOperations = () => {
    if (!operationsClosePromise) {
      operationsClosePromise = operationsPromise.then((operations) => operations.close());
    }
    return operationsClosePromise;
  };
  const closeStreams = () => {
    operationsShuttingDown = true;
    for (const stream of operationStreams) stream.destroy();
    operationStreams.clear();
  };
  server.once("close", () => {
    closeStreams();
    void closeOperations().catch((error) => {
      console.error("[operations] shutdown failed", error);
    });
  });
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closeStreams();
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
        });
      }
      await closeOperations();
      await agentRuntimeStore.close();
    })();
    return closePromise;
  };

  return { server, agentService, agentRuntimeStore, sessionCodec, operationsPromise, close };
}
