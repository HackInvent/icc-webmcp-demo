# Development and validation

This guide describes the reproducible checks used for Paris ICC development. All
commands run from the repository root unless stated otherwise.

## Repository structure

- `src/rail/` — deterministic operational simulation, native network model,
  interdependence graph, routing and impact analysis, configuration import/export,
  incidents, PRIM contracts, and providers
- `src/procedures/` — synthetic incident codification and versioned procedures used by the
  operational simulation
- `src/webmcp/` — typed WebMCP tool registration, read contracts, guarded writes,
  and operator approval
- `src/agent/` — native/in-page WebMCP execution and procedure-grounded incident
  decision workflow
- `src/components/` and `src/pages/` — operator interface, network overview,
  simulator, procedures, schedules, regulation, and power views
- `server/` — authenticated static server, OpenAI agent protocol, sessions,
  security headers, optional PRIM proxy, server-authoritative operations service,
  SSE delivery, and embedded SQLite repository
- `tests/` — deployable-server, configuration, authentication, and agent tests
- `scripts/` — SVG checks, browser validation, WebMCP validation, deployment smoke,
  and PRIM smoke
- `artifacts/` — generated evidence and validation reports; these are not runtime
  secrets
- `config/server.example.json` and `config/server.schema.json` — public
  configuration reference; `config/server.local.json` is private and ignored

## Install and run locally

Use Node.js 20 or newer (Node.js 22 LTS is recommended) and install exactly the locked dependencies:

```bash
npm ci
```

Start the Vite development application:

```bash
npm run dev
```

This mode uses local deterministic data and PRIM contract replay. For the
authenticated server, build and run the full configuration described in
`docs/deployment.md`.

## Core quality gates

Run the server syntax checks, TypeScript checks, unit/integration suite, and
production build:

```bash
npm run check:server
npm run check
npm run check:rail-graph
npm test
npm run test:rail-graph
npm run build
```

The maintained baseline is the complete zero-failure output of `npm test`. Treat a
skipped test, unhandled rejection, console error, or changed deterministic fixture
as a regression unless the test inventory was intentionally updated.

Useful focused checks include:

```bash
npx vitest run tests/server-operations-repository.test.mjs tests/server-operations-restart.test.mjs src/runtime/operationsClient.test.ts
npx vitest run tests/server-shift-report.test.mjs tests/server-shift-report-agent.test.mjs src/pages/OperationsRecords.test.ts
npm run test:ratp-native -- --require-render
npm run test:ratp-native-compliance -- --render-check
npm run check:rail-graph
npm run test:rail-graph
npm run test:ratp-svg
npm run test:ratp-transparent
```

To reproduce the audited cross-station source from a downloaded IDFM GTFS ZIP:

```bash
npm run build:rail-connections -- --gtfs /path/to/IDFM-gtfs.zip
npm run build:rail-connections -- --gtfs /path/to/IDFM-gtfs.zip --check
```

This source audit selects 28 documented pairs. Twenty-five have reciprocal
evidence among the 184 audited GTFS cross-station pairs; three additional links
are named explicitly by IDFM decision 20251017-192 and are marked
`official-documentary`. The audit rejects 159 GTFS proximity candidates before
the normal graph gates run.

## Playwright and Chromium

Install the pinned Python browser dependency:

```bash
python3 -m pip install -r requirements-webmcp.txt
```

The native WebMCP validator requires Chromium **151 or newer** with the
experimental WebMCP DevTools Protocol domain. It searches common Chromium paths;
override discovery with `WEBMCP_CHROMIUM` or `--browser`.

Run the complete tool-contract validation:

```bash
npm run test:webmcp
```

The script uses an existing `http://127.0.0.1:5173/#/overview` server or starts a
temporary Vite server itself. It validates the exact 22-tool catalogue, strict
input schemas, read-only annotations, coded incident inspection, procedure
search/retrieval, revision and content-hash binding, cited step application,
stale-state guards, one-shot approval, receipts, simulation reset, schedule
decisions, CDV closure, and tool disposal.
The validator intercepts the browser's agent endpoint and exercises the local,
procedure-grounded fallback. It does not send operational context to an external
model; model/tool-call behavior is covered by the server agent tests.

Write a machine-readable report explicitly with:

```bash
npm run test:webmcp -- --report artifacts/webmcp-validation.json
```

Useful options are:

```bash
npm run test:webmcp -- --headed --timeout 20
npm run test:webmcp -- --browser /path/to/chromium
```

For the semantic-zoom and cross-route UI suite, first keep Vite running in one
terminal:

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Then run in another terminal:

```bash
npm run test:native-ui
```

This validator currently launches `/snap/bin/chromium` and writes screenshots and
`artifacts/native-network-ui-validation.json`. It verifies topology counts,
runtime SVG ownership, marker layers, semantic zoom, discrete train transitions, incident modal,
routes, mobile overflow, simulator import/export, and WebMCP browser evidence.

## Authenticated deployment smoke

The deployment smoke targets `http://127.0.0.1:8787/#/overview` by default. For a
public deployment, inject the URL and shared code through the environment rather
than placing credentials in source files or reports:

```bash
export WEBMCP_URL='https://paris-icc-demo.hackinvent.com/#/overview'
export WEBMCP_ACCESS_CODE='<provided securely>'
npm run smoke:deployment
```

Optional browser override:

```bash
export WEBMCP_CHROMIUM='/path/to/chromium'
```

The smoke logs in through the visible access gate, confirms the 22 registered
tools, reads the incident code and exact procedure revision/hash/steps, checks the
procedure citations, and approves the first cited step through the one-shot
surface. It then reloads the same browser context and cookie, reopens the same
incident, proves the completed step remains recorded and absent from the pending
cards, and proves the same next step is still unlocked. It rejects that second
write, verifies the current-shift log is newest first, edits and reloads the
report to prove autosave, forces the local agent fallback, reads the complete log
through `inspect_shift_log`, finalizes it against the real authenticated report
endpoint, freezes the document, and verifies the print path and edit lock. No
external model is called by this smoke test.
The access code and cookie value are never written to the JSON report.

## PRIM connector smoke

The PRIM smoke contacts the configured IDFM endpoint directly and requires a
server-side credential in the process environment:

```bash
export PRIM_API_KEY='<provided securely>'
npm run smoke:prim
```

Use `PRIM_API_URL` only to override the official endpoint for an authorised test.
The script checks RER A, RER B, Metro 13, and Metro 14 using their bounded LineRef
contracts and prints counts and timestamps, never the credential. Do not run this
gate when PRIM access is unavailable; contract replay and its parser tests remain
the deterministic CI path.

## Recommended pre-release sequence

Run these gates before an evaluation or production release:

```bash
npm ci
npm run check:server
npm run check
npm run check:rail-graph
npm test
npm run test:rail-graph
npm run build
npm run test:ratp-native -- --require-render
npm run test:ratp-native-compliance -- --render-check
npm run test:webmcp -- --report artifacts/webmcp-validation.json
```

With the local UI server running, add:

```bash
npm run test:native-ui
```

With the authenticated full server running, finish with:

```bash
npm run smoke:deployment
```

Run `npm run smoke:prim` only when live PRIM credentials and network access are
part of the release scope. A release is not ready if any required gate fails, the
tool count differs unexpectedly, browser/page errors appear, a report exposes a
secret, or the UI blurs the boundary between sourced PRIM evidence and simulated
railway state.
