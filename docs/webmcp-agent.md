# WebMCP and the embedded incident-decision agent

## What WebMCP contributes

Paris ICC publishes the operational state and bounded simulation actions of the current page as typed tools. This lets an agent work with the same incident, map revision, schedule review, and procedure evidence visible to the operator, without adding a separate railway-specific agent API for every screen.

The page remains the authority for tool definitions and visible approval. The authenticated operations service is the authority for mutable demonstration state. The model can prepare a recommendation from read-only evidence, but an operator must explicitly approve every page tool classified as a write; approved commands are revision-bound and persisted in the session workspace.

The tool catalogue is assembled by [`createIccTools`](../src/webmcp/tools.ts), extended by [`createNativeSimulationTools`](../src/webmcp/nativeTools.ts), wrapped by [`createIccToolCatalog`](../src/webmcp/register.ts), and published by [`registerIccTools`](../src/webmcp/register.ts).

## Native WebMCP and the in-page bridge

| Property | Native WebMCP | In-page compatibility bridge |
|---|---|---|
| Publication | `document.modelContext.registerTool(...)` | The same wrapped definitions are retained by the React application. |
| Discovery | `document.modelContext.getTools()` | `createInPageWebMcpCatalog(...)` receives the retained definitions. |
| Execution | `document.modelContext.executeTool(...)` with JSON-string arguments | Calls the wrapped `execute(...)` function directly. |
| Origin handling | Discovered tools are filtered to the current page origin. | Definitions are supplied by the current application instance. |
| Browser requirement | Requires native `document.modelContext` discovery and execution. | Works in a conventional browser for the embedded application flow. |
| Intended role | Demonstrates native page-tool discovery and execution. | Keeps the embedded decision workflow usable for development and conventional-browser access when native browser support is absent. |

Both paths use the same tool schemas, validators, simulation controller, activity reporting, and approval wrapper. The bridge is an application compatibility mechanism; it should not be described as native browser WebMCP. Transport selection and execution are in [`src/agent/nativeWebMcp.ts`](../src/agent/nativeWebMcp.ts).

## Exact tool catalogue

The current application publishes 19 tools when the native-network controller is present. The runtime classifier in [`webMcpActivityKind`](../src/webmcp/register.ts) distinguishes 11 reads, two non-committing analysis/staging operations, and six writes.

| Class | Tool | Purpose | Primary source |
|---|---|---|---|
| Read | `inspect_prim_feed` | Read PRIM provenance, freshness, coverage, and bounded passenger estimated-call evidence. | [`tools.ts`](../src/webmcp/tools.ts) |
| Read | `prepare_shift_brief` | Produce a bounded, ranked cross-domain handover from the visible revision. | [`tools.ts`](../src/webmcp/tools.ts) |
| Read | `inspect_network_state` | Read the detailed simulated network summary and stable decision revision. | [`tools.ts`](../src/webmcp/tools.ts) |
| Read | `get_circulation` | Read one simulated train circulation, current CDV, delay, next stop, and pseudonymous driver token. | [`tools.ts`](../src/webmcp/tools.ts) |
| Read | `inspect_j1_capacity` | Read aggregate D-1 driver capacity without employee identities or sensitive absence data. | [`tools.ts`](../src/webmcp/tools.ts) |
| Read | `list_operational_incidents` | List planned and current incidents in the detailed simulation. | [`tools.ts`](../src/webmcp/tools.ts) |
| Read | `inspect_schedule_plan` | Read a bounded, redacted D-1 plan page with its exact SHA-256 version hash. | [`tools.ts`](../src/webmcp/tools.ts) |
| Analysis | `preview_schedule_change` | Stage one deterministic schedule change against an exact plan hash without committing it. | [`tools.ts`](../src/webmcp/tools.ts) |
| Analysis | `evaluate_schedule_impact` | Evaluate and stage impact evidence for the exact pending preview without committing the plan. | [`tools.ts`](../src/webmcp/tools.ts) |
| Write | `apply_reviewed_schedule_change` | Commit the exact pending, evaluated, separately authorized preview to the server-authoritative schedule workspace. | [`tools.ts`](../src/webmcp/tools.ts) |
| Write | `simulate_track_circuit_closure` | Close or reopen one CDV in the detailed deterministic simulation. | [`tools.ts`](../src/webmcp/tools.ts) |
| Write | `simulate_regulation_action` | Apply a guarded regulation action to one simulated train. | [`tools.ts`](../src/webmcp/tools.ts) |
| Read | `inspect_network_digital_twin` | Read a bounded summary of the native 21-line network twin. | [`nativeTools.ts`](../src/webmcp/nativeTools.ts) |
| Read | `inspect_incident_decision_context` | Read one incident's codification, impact, restrictions, revision, and procedure execution state. | [`nativeTools.ts`](../src/webmcp/nativeTools.ts) |
| Read | `search_operational_procedures` | Search the active workspace catalogue for the exact code of an incident present in the twin. | [`nativeTools.ts`](../src/webmcp/nativeTools.ts) |
| Read | `get_operational_procedure` | Retrieve one exact document identity: procedure ID, revision and SHA-256 content hash. | [`nativeTools.ts`](../src/webmcp/nativeTools.ts) |
| Write | `apply_reviewed_procedure_step` | Record or apply one exact operator-reviewed capability from a matching procedure step. | [`nativeTools.ts`](../src/webmcp/nativeTools.ts) |
| Write | `create_simulated_network_incident` | Create or schedule one bounded incident on a known train, station, or interstation. | [`nativeTools.ts`](../src/webmcp/nativeTools.ts) |
| Write | `control_network_simulation` | Pause, resume, change speed, reset, or activate a curated native scenario. | [`nativeTools.ts`](../src/webmcp/nativeTools.ts) |

The two schedule tools classified as **Analysis** have `readOnlyHint: false` because they create pending preview or impact artifacts in the authenticated schedule workspace. They do not commit the schedule plan and are not in [`MUTATING_WEBMCP_TOOL_NAMES`](../src/webmcp/register.ts), so the common write-approval dialog is reserved for the six actions listed as **Write**. They should be presented as non-committing staging operations, not as pure reads.

## Incident decision contract

The embedded incident flow exposes exactly three read-only tools to the server-side model:

1. `inspect_incident_decision_context({ incidentId })`
2. `search_operational_procedures({ incidentCode })`
3. `get_operational_procedure({ procedureId, procedureRevision, procedureContentHash })`

The server forces this order one call at a time. It rejects different tool names,
additional arguments, an incident ID other than the selected one, a searched code
other than the inspected code, or a procedure ID/revision/hash triple that was not
returned by the search. The model never receives
`apply_reviewed_procedure_step` in incident-decision mode. See [`READ_TOOLS`](../src/agent/procedureDecisionAgent.ts)
and [`INCIDENT_DECISION_TOOL_NAMES`](../server/agent.mjs).

### Evidence chain

The accepted recommendation must preserve this chain:

```text
incidentId
  -> incidentCode + decisionRevision
  -> procedureId + procedureRevision + procedureContentHash
  -> retrieved immutable stepIds
  -> cited operator plan
  -> one reviewed step application
```

Search returns identity and provenance metadata only. The selected document must then be retrieved. The server verifies that its revision and content hash match the search evidence, that step IDs are unique, and that normal-state criteria are present before it accepts a final answer.

## Versioned procedure workspace

The 14-document catalogue revision `2026.08.30.4` is an immutable application
baseline. Procedure editing does not rewrite that asset. Each authenticated
operations workspace instead owns a small versioned registry in SQLite:

- `activeOverrides` selects the active workspace revision for a procedure;
- referenced version documents retain active edits and historical revisions
  cited by procedure executions; and
- the browser snapshot carries a bounded catalogue projection rather than
  retransmitting the complete baseline on every one-second SSE update.

On **Procedures**, **Edit procedure** opens the complete step rail and **Edit
step** opens it at a specific step. The controlled publication contract permits
only the step title, operator instruction, rationale, responsible role,
preconditions, required evidence, completion criteria, and minimum/nominal/
maximum planning duration to change. Procedure and step IDs, step order, phase,
mandatory status, executable capability, operator-confirmation requirement,
incident applicability, machine evidence-reference kind, and return-to-normal
policy remain immutable.

**Publish step revision** sends the expected procedure revision and content hash
with a strict patch. The operations service rejects stale or malformed drafts,
then creates a new document revision and content hash, advances the workspace
catalogue sequence, persists the registry, and appends a
`procedure-step-revision-published` operator-action entry. The bundled document
and prior workspace revisions are never mutated.

`search_operational_procedures` resolves the active workspace revision.
`get_operational_procedure` requires the exact ID, revision, and hash returned by
search. A new incident analysis therefore sees the current published content,
while an execution already started against an older identity remains pinned to
that immutable revision. The exact resolver also lets WebMCP finish, review, and
audit an older execution after a later edit. Procedure publication is an
authenticated human workspace command; it is deliberately not exposed to the
incident agent as a WebMCP write tool.

### `incident-decision.v2`

The final model response uses the strict JSON schema [`INCIDENT_DECISION_SCHEMA`](../server/agent.mjs). It contains only these top-level fields:

```json
{
  "schemaVersion": "incident-decision.v2",
  "incidentId": "...",
  "incidentCode": "...",
  "decisionRevision": 0,
  "procedureId": "...",
  "procedureRevision": "...",
  "procedureContentHash": "...",
  "executiveSummary": "...",
  "actions": [
    {
      "stepId": "...",
      "priority": 1,
      "rationale": "...",
      "operatorChecks": ["..."]
    }
  ],
  "risks": ["..."],
  "normalStateCriteria": ["..."],
  "advisoryOnly": true,
  "humanReviewRequired": true
}
```

`additionalProperties` is false throughout the schema. The final action list may cite only step IDs from the retrieved document and may not omit the next mandatory unfinished step. The client independently parses and cross-checks the context, search, procedure, identifiers, revision, hash, steps, and normal-state criteria before rendering them. See [`parseContext`, `parseSearch`, `parseProcedure`, and `parseRecommendation`](../src/agent/procedureDecisionAgent.ts).

The agent may prioritize steps and explain their relevance. It cannot invent an executable capability: the displayed instruction and any mapped capability remain those of the retrieved procedure document.

## Model and browser round trips

The browser starts `/api/agent/turn` with only the three read-tool definitions and the selected incident ID. The server asks the model for one forced tool call. The browser executes that page tool through native WebMCP or the in-page bridge, then returns the output to the server for validation. After all three evidence reads, the server requests the strict final JSON result.

This design keeps page execution in the browser and keeps OpenAI credentials on the server. Tool output is treated as untrusted operational data, not as model instructions. The server validates the evidence after every round in [`AgentService.#recordIncidentDecisionEvidence`](../server/agent.mjs).

The header **Configuration** modal exposes only models listed in
`openai.allowedModels`. `PUT /api/configuration/agent` validates the exact model
server-side and persists it for subsequent runs and report drafts. The model is
captured when a run starts, so changing the global setting cannot mix models
inside an active inspect/search/get sequence.

Each server call appends a bounded metadata-only entry containing its timestamp,
category, model, outcome, duration, optional tool names and token counts. The
authenticated **Agent log** view reads `/api/agent/log`; its JSON download is
served by `/api/agent/log/download`. Prompts, browser tool arguments and outputs,
model answers, API keys, and server instructions are deliberately excluded.

## Operator approval and write execution

The model-generated recommendation is not an authorization. When the operator selects the next cited procedure step, [`applyIncidentProcedureStep`](../src/agent/procedureDecisionAgent.ts) builds this exact tool input:

```json
{
  "incidentId": "...",
  "procedureId": "...",
  "procedureRevision": "...",
  "procedureContentHash": "...",
  "stepId": "...",
  "expectedDecisionRevision": 0,
  "confirmSimulation": true
}
```

[`wrapToolDefinition`](../src/webmcp/register.ts) recognizes the tool as a write, clones and freezes the arguments, and sends the exact serialized JSON to [`WebMcpApprovalDialog`](../src/components/WebMcpApprovalDialog.tsx). The application allows one pending approval, expires it after 90 seconds, and blocks execution if approval is unavailable, rejected, expired, or aborted. Changed arguments require a new approval.

Approval is necessary but not sufficient. [`apply_reviewed_procedure_step`](../src/webmcp/nativeTools.ts) then verifies:

- the target is the local simulation and the snapshot is not marked `live`;
- `confirmSimulation` is exactly `true`;
- the current `decisionRevision` equals `expectedDecisionRevision`;
- the incident exists and remains active;
- the exact procedure revision exists and its SHA-256 content hash is unchanged;
- the incident code is included in the document's applicability;
- the requested step exists and has not already been recorded;
- all preceding mandatory steps are complete;
- verify and close phases respect the procedure observation window;
- a state-changing capability is one of the four modelled primitives and is available for this incident.

Documentary and acknowledgement steps are recorded without changing the operational twin. State-changing steps are mapped to an internal deterministic response evaluation; the underlying controller checks the exact decision revision again before applying it. Each successful call returns a receipt or acknowledgement and clears the client decision cache so the next cycle re-inspects current evidence.

## Return to normal

Each procedure declares ordered steps, an observation window, normal-state criteria, and an operator-signoff requirement. A recover-phase capability records the recovery start time. Verify or close steps are blocked until the observation window has elapsed.

For a close-phase simulation action, the current implementation reports `passed` only when:

- the incident is resolved;
- no active restriction linked to that incident remains; and
- every mandatory procedure step is complete.

The procedure's textual normal-state criteria are displayed alongside that result for operator review. They are evidence requirements, not individually instrumented or safety-certified sensor checks.

## Deterministic fallback

If server-side model analysis is disabled or unavailable, the browser still executes the same inspect, search, and retrieve sequence. [`fallbackRecommendation`](../src/agent/procedureDecisionAgent.ts) builds an ordered plan only from mandatory unfinished steps in the retrieved document. The UI labels this state as a procedure-derived fallback and does not substitute a generic response-option catalogue.

The fallback preserves useful decision support without pretending that model reasoning succeeded. It does not relax operator approval, revision guards, procedure identity checks, step ordering, or return-to-normal conditions.

## Cross-tool safeguards

| Safeguard | Applies to | Enforcement |
|---|---|---|
| JSON object and bounded schemas | All tools | Input schemas use bounded fields and generally `additionalProperties: false`; executors also reject unknown fields. |
| Result bounds | Read and analysis tools | Native and detailed tool outputs are normally capped at 12 items and bounded text lengths. |
| Same-origin discovery | Native WebMCP | Discovered tools with another origin are excluded. |
| Visible one-shot approval | Six write tools | Exact frozen arguments are displayed before execution; procedure steps use an inline panel in the existing incident modal. |
| Stable decision revision | Native writes, CDV, regulation | Stale operational context blocks mutation; ordinary telemetry ticks do not invalidate the guard. |
| Explicit simulation confirmation | Native writes, CDV, regulation | `confirmSimulation: true` is mandatory. |
| Live-source prohibition | Simulation writes | Writes reject live snapshots or live commands. |
| No-op and duplicate rejection | Incident creation and simulation control | Existing unresolved equivalent effects and unchanged control requests are blocked. |
| Versioned schedule review | Schedule commit | Exact plan hash, preview ID, impact ID, absence of hard blocks, and a one-use visible authorization are required. |
| Immutable procedure citation | Procedure step apply | Exact incident code, document ID, revision, hash, and step ID are revalidated. |
| Controlled procedure publication | Human procedure editor | Expected revision/hash, strict editable-field allowlist, immutable execution fields, new hash, SQLite persistence, and shift-log event. |
| Sequential execution | Procedure steps | Preceding mandatory steps and observation window are enforced. |
| Abort handling | Tool and approval flows | Calls are checked before approval and before mutation. |

## Public demonstration boundaries

- The baseline catalogue contains 14 synthetic, English, demo-authored procedures. It is explicitly not an official RATP, IDFM, infrastructure-manager, or regulatory corpus. A real deployment must replace it with authorized controlled documents, role-based publication, independent approval, and organization-specific distribution rules.
- All train movement, incidents, power state, delay, passenger load, response impact, and recovery behavior in the digital twin are deterministic simulation data unless a field explicitly identifies separate PRIM passenger evidence.
- PRIM is a read-only passenger-information source. It does not expose train position, signalling, CDV occupancy, traction-power control, or crew commands.
- The server-side incident agent can read only the three procedural tools. It cannot autonomously call the procedure apply tool.
- Procedure workspace revisions and execution progress are persisted with the authenticated operations workspace in embedded SQLite. They are not part of the portable simulator export and do not constitute an immutable regulatory document repository or audit record.
- Native procedural targets currently cover train, station, interstation, and line-communication incidents. Power procedure documents exist, but the power simulator is a separate detailed-state path today.
- Return-to-normal logic validates generic simulation signals and ordered procedural progress, not certified operational telemetry.
- Schedule preview and evaluation alter pending authenticated workspace artifacts even though they do not commit a plan; this is why their WebMCP annotation is not read-only.
- The in-page bridge and native `document.modelContext` path share the application contract, but only the latter demonstrates native browser tool discovery and execution.
- The controls described here are demonstrator safeguards. They are not a security certification, a railway safety case, or authorization for operational use.
