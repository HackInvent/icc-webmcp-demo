# Paris ICC operator guide

This guide covers the current local-simulation build. Paris ICC is a
decision-support demonstration: every operational change stays inside the local
simulation and the operator remains the decision authority. Read
[Data sources and operational boundaries](data-sources-boundaries.md) before
presenting the application as a live system.

## Sign in

The deployed application uses one shared access code. Open the HTTPS site,
enter the code on the **Private demonstration** screen, and select
**Open operations canvas**.

- No personal account or browser API key is required.
- The OpenAI and optional PRIM credentials stay on the server.
- A successful login creates an HttpOnly same-origin session cookie.
- `npm run dev` uses an explicit development bypass. OpenAI is disabled in this
  mode and incident recommendations use the labelled procedure fallback.

For server setup and build commands, see the [project README](../README.md).

## Navigation and routes

The application uses hash routes, so a route can be bookmarked without requiring
special Nginx routing rules.

| Surface | Route | Purpose |
| --- | --- | --- |
| Network overview | `#/overview` | Native 21-line map, trains, delays and incident decisions |
| Passenger flow | `#/passenger-flow` | Network heatmap, station queues, train loads and sourced demand rates |
| Incident deep link | `#/overview/incident/:id` | Focus a native incident and open its decision workflow |
| SimView | `#/simulator` | Inspect and filter simulated objects; create incidents and insert trains |
| Procedures | `#/procedures` | Inspect the versioned DEMO catalogue and publish controlled step revisions |
| Schedules & drivers | `#/schedules-drivers` | Prepare and review D-1 schedule changes |
| Incident management | `#/incidents` | Review detailed-corridor and native incidents |
| Delays & regulation | `#/regulation` | Inspect delayed services and test regulation actions |
| Traction power | `#/power` | Inspect simulated electrical sections and events |
| Operations log | `#/operations-log` | Review the persisted current-shift chronology, newest first |
| Shift report | `#/shift-report` | Edit, assist, freeze and print the end-of-shift report |
| Operational record | `#/details/:type/:id` | Open a train, circuit, driver, incident or power record |

The left navigation contains the operational workspaces. **Procedures** and
**SimView** are available in the header. The global search opens detailed-model
trains, services, track circuits, incidents, drivers and power sections. Native
map stations have their own search inside **Network overview**.

## Network overview

### Find and frame the relevant area

1. Choose **All 21 lines**, **16 Metro**, or **RER A–E**.
2. Use **Find station or IDFM code**, then select **Locate**. Names such as
   `Châtelet` and identifiers such as `IDFM:71673` are accepted.
3. Select a line in the map's left rail to fit that line, or select **Network fit**
   to restore the complete view.
4. Select **Fit problems** to frame current incidents and delay hotspots.
5. Pan by dragging. Zoom with the mouse wheel or the `−` and `+` controls. Select
   **Fit** to restore the root view.

Semantic zoom deliberately changes information density:

- **Overview** keeps stable incident, works, power and delay indicators visible.
- **Operations** reveals trains, mission codes and delays.
- **Detail** adds circulation, next-station and exact object evidence.

The incident symbol remains visible at every level. A train is operationally
assigned to one station or interstation and remains stable in that object until it
is discretely rebound to the next one; the map does not tween it between objects. See
[Train-state semantics](data-sources-boundaries.md#train-state-semantics).

### Open an incident

Select an incident marker with the pointer or keyboard. The map focuses the
affected object and opens **Agent decision support · human control** for that exact
incident and decision revision. The same modal can be reached from a native
incident link in **Incident management** or **SimView**.

## Procedure-grounded incident workflow

The modal starts automatically; there is no chat prompt to compose.

1. Confirm the incident ID, incident code, occurrence time, restriction and
   affected line.
2. Watch the read-only retrieval trace. It must run in this order:
   `inspect_incident_decision_context` → `search_operational_procedures` →
   `get_operational_procedure`.
3. Check the procedure source banner. The bundled catalogue must appear as
   **DEMO synthetic procedure · not an official RATP/IDFM instruction**.
4. Verify the exact procedure ID, revision and integrity hash. Review impacted
   trains, passenger exposure, worst delay and decision revision.
5. Review each cited step. The document instruction, required evidence, agent
   rationale and operator checks are shown separately. The agent may order and
   explain retrieved steps; it cannot invent a step or executable command.
6. Complete steps in the displayed procedure order. A later step remains disabled
   until the required previous step is recorded.
7. Select the enabled action, normally **Review & apply**, only after checking the
   current evidence.

After approval, the modal never changes into a replacement screen. The applied card moves to **Completed procedure steps**, where its outcome, receipt, decision revision and instruction remain reviewable. The same modal refreshes the WebMCP context in place and unlocks the next required step.

If the decision revision changes independently while the modal is open, the recommendation is marked expired. Select **Refresh evidence** before continuing; the existing workflow remains visible during that refresh.

## Inline one-shot WebMCP approval

A procedure action does not execute when its recommendation button is first
selected. Paris ICC expands the selected procedure card and displays the exact
WebMCP confirmation inside the existing incident decision modal. No second modal
is opened, so the incident, evidence, citation and operator action remain in one
continuous workflow.

Before approval, verify:

- tool name and simulation-only status;
- incident ID and current decision revision;
- procedure ID, revision and content hash;
- cited step ID and the exact arguments to be executed.

Select **Confirm and record this step** only for that exact call. Rejecting,
closing, timing out, or cancelling the inline confirmation leaves the simulation unchanged. Approval is single-use and
cannot authorize a later or modified call. The tool rechecks the incident,
procedure, step capability, hash and decision revision immediately before applying
the local change.

After success, retain the procedure receipt and select **Retrieve next-step
guidance**. Evidence is read again before another step. Do not close the incident
merely because one restriction changed: review every item in **Conditions to verify
before closure** and obtain the displayed operator sign-off.

## Passenger flow

Open **Passenger flow** from the left navigation. The native network drawing is
the map background; coloured station markers show the current modelled pressure.
Choose one of the 21 lines to inspect its published reference volume, year,
publisher, source URL, station divisor, period divisor and exact per-station
arrival rate. **All Metro + RER lines** aggregates the independent line/station
queues at interchanges.

Select a heat marker to inspect the waiting queue, generated/boarded/alighted
totals, last exchange, arrival rate, and trains physically dwelling at that
station. A queue grows linearly once per simulated second. At a station boundary,
10% of a train's passengers alight (100% at a terminus), then waiting passengers
board up to the train's reference capacity. Any excess remains visible at the
station. The exchange occurs once on arrival, not on every dwell tick.

The heatmap state is part of the server-authoritative snapshot. It therefore
survives browser refresh and controlled server restart; **Reset** restores the
configured baseline. The `inspect_network_digital_twin` WebMCP read tool exposes
the busiest bounded queues and train load/capacity without authorising a write.

## Procedures workspace

Open **Procedures** in the header, select a document in the register, and review
its ID, current revision, SHA-256 integrity hash, applicability, ordered steps,
and return-to-normal policy. The bundled 14-document catalogue is the immutable
baseline; published changes belong to the current authenticated operations
workspace.

To revise a procedure step:

1. Select **Edit procedure** to open the complete step rail, or select **Edit
   step** beside a specific step.
2. Choose a step. Edit its title, operator instruction, rationale, responsible
   role, preconditions, required evidence, completion criteria, or minimum/
   nominal/maximum planning duration. Publish or explicitly discard the current
   draft before navigating to another step.
3. Review **Execution invariants**. Step ID, order, phase, mandatory status,
   capability, confirmation rule, applicability, machine evidence gate, and
   return-to-normal policy cannot be edited.
4. Review **Pending changes** and resolve every validation message. Duration
   values must remain ordered `minimum <= nominal <= maximum`.
5. Select **Publish step revision**. The service checks the displayed revision
   and hash again; stale drafts are rejected rather than overwriting a newer edit.
6. Wait for the catalogue refresh. Confirm that the document displays its new
   revision and integrity hash.

Each accepted publication is persisted in SQLite and adds a timestamped operator
entry to **Operations log** with the procedure, step, old/new revision, and changed
fields. Reloading or restarting restores the active edit. Global **Reset** starts
a new operational shift but deliberately keeps procedure workspace revisions.

WebMCP procedure search uses the active revision for a new analysis. An incident
workflow already started against an older ID/revision/hash remains pinned to that
historical document, so an edit cannot replace an instruction in the middle of an
operator-approved sequence.

## SimView

Open **SimView** in the header to inspect the current model registry. It exposes
separate tabs for trains, incidents, stations, interstations, power, track circuits,
drivers and events. Use the text search, line filter and pagination to narrow the
tables. The Trains table shows onboard/reference capacity and load; the Stations
table shows waiting passengers, arrivals per second and cumulative exchanges.
`T… / D…` shows the native telemetry and decision revisions.

### Add an incident

1. Open the **Incidents** tab and select **Add incident**.
2. Choose the target type: train, station, interstation or electrical section.
3. Choose the line and the exact target object.
4. For a station, choose a coherent operational preset. **Station closure for
   engineering works** binds `works / station-closure`; **Abandoned baggage**
   binds `security / abandoned-baggage`. For other targets, select the supported
   category and effect. A reduced-speed effect also requires its speed limit.
5. Set **Occurrence time · Europe/Paris** and review the impact preview.
6. Edit the generated title and operational summary if needed.
7. Select **Activate incident** for the current/past simulation time or **Schedule
   incident** for a future simulation time.

The simulator derives an incident code and impact from the selected target and
effect. A planned incident becomes active when its own simulation clock reaches the
occurrence time. Native-network and detailed power incidents use their respective
model clocks, both displayed in the form.

Works closures and abandoned-baggage protection exclude the station from train
paths and calls. Approaching trains reverse without a visual position jump, and
the incident procedure requires operator-approved flanking turnbacks followed by
a split provisional service on the two operable sides. Police clearance is
mandatory before an abandoned-baggage station can be reopened.

### Configure the agent and move a baseline

- Open **Configuration** in the header. In **Agent**, select a model, choose one
  of the reasoning efforts supported by that model, and select **Apply
  configuration**. The pair applies to subsequent runs and reports; an
  already-started multi-round WebMCP run retains its original model and effort.
  Non-reasoning models show that the setting is not applicable. The API key
  remains on the server.
- In **Simulator configuration**, **Export JSON** downloads the current native
  and detailed simulation state, including explicit occurrence times for every
  incident.
- **Choose JSON file** validates a Paris ICC configuration without changing
  state. Review the displayed name, timestamp and object counts, then choose
  **Install imported baseline**. The accepted import becomes the new simulation
  **Reset** baseline for the current authenticated operations workspace.
- In **Agent log**, refresh the newest-first execution trace or download its
  versioned JSON form. It records model, reasoning effort when applicable,
  outcome, duration, tool names and token counts, but never prompts, tool
  arguments or outputs, or credentials.
- Treat exported JSON as scenario input, not as a railway record or live snapshot.

Import does not replace the D-1 schedule CSV. Schedule plans are managed separately
in **Schedules & drivers**.

## Other operational workspaces

### Schedules & drivers

Use **Import schedule CSV** to load a bounded local plan, or start with the bundled
[sample schedule](../public/sample-paris-schedule.csv). The source is not overwritten
or uploaded by the schedule workspace.

Prepare one shift, driver, track or cancellation patch, inspect the non-destructive
preview, run the impact evaluation, and resolve any hard block. Apply only the exact
reviewed hashes after visible authorization. A successful commit changes the
server-authoritative demonstration schedule, persists a receipt and provides an
undo path.

### Track-circuit closure

Open a track-circuit record from a detailed corridor view or object link. A free
circuit can be closed for **Works** or **Incident**, with an optional note, and later
reopened. Occupied, blocked, stale, redundant or non-simulation requests are
rejected. A closure is a local availability restriction, not a signalling command.

### Delays and regulation

Filter **Delays & regulation** by line, then select a delayed service or proposal to
open its train record. The available detailed-corridor actions are **Give priority**,
**Hold for 36 s**, and **Turn back**. They are deterministic simulation actions and
can be rejected when route, occupancy, terminal or revision conditions do not permit
them.

### Traction power

Use **Traction power** to review constrained sections, measurements and the power
operations log. Selecting a section opens its simulated voltage, current and load.
**Isolate in simulation** and **Restore power in simulation** never contact a
substation or field system.

### Passenger-information source

Select the source chip in the header to choose:

- **ICC deterministic simulation** — no passenger feed;
- **PRIM contract replay** — synthetic SIRI Lite values through the production
  parser;
- **IDFM PRIM live** — optional read-only estimated calls through the authenticated
  server proxy.

Use **Refresh source** after changing modes. PRIM observations never determine
simulated train position, track-circuit, signalling, power or crew state. Details are
in [the PRIM connector contract](prim-connector.md).

## Operations log and end-of-shift report

### Review the investigation chronology

Open **Operations log** to inspect the normalized current-shift register. Entries
are recorded by the server after successful state changes and include both the
operational timestamp and server receipt timestamp, a monotonic log ID, category,
affected incident and entities, actor, event type, summary and incident elapsed
duration when applicable. Automatic incident activation and status transitions
are logged as well as operator actions.

The table always starts with the newest entry. Filter by incidents, operator
actions, decision support or system events, or search an ID, incident or object.
This register is different from the lower-level repository audit: it is deliberately
readable by an operator and is the evidence supplied to the report assistant.

### Prepare the report

1. Open **Shift report**. The current draft is restored from SQLite after a page
   reload or controlled server restart.
2. Edit the document directly. Formatting includes bold, italic, underline,
   strikethrough, headings, paragraphs, quotations, bulleted and numbered lists,
   undo and redo.
3. Do not look for a Save button. An edit is autosaved after a short pause; check
   the persistence status above the document before leaving the page.
4. Select **Draft from shift logs** when assistance is required. The server reads
   the persisted current-shift register, asks the configured OpenAI model for a
   structured evidence-grounded synthesis, validates every cited log ID, then
   produces sanitized editable HTML. If OpenAI is disabled, the same button creates
   a deterministic complete chronology from the register.
5. Review and correct the draft. The assistant must not invent an incident, time,
   duration, action or outcome absent from the logs.
6. Select **Freeze & print PDF** only after operator review. Confirmation durably
   locks the report until Reset and opens the browser print dialogue. Choose
   **Save as PDF** or a printer. A frozen report remains printable but cannot be
   edited and cannot be regenerated by the agent.

### Pause, speed and reset

The header controls pause and the `×1`, `×2`, and `×4` demo accelerators. These are
simulation accelerators, not real-time ratios. **Reset** restores the current
simulation baseline, reloads the bundled D-1 sample schedule, and opens a fresh
shift register and report draft. It preserves the versioned procedure workspace.
Reset is consequential: freeze and export the current report first when it must be
retained. The lower-level SQLite operation events and command receipts remain
available for technical investigation.

## Troubleshooting and demo fallbacks

| Symptom | Operator response |
| --- | --- |
| Access code rejected | Check the shared code and wait if repeated failures triggered the login limiter. Do not enter an OpenAI key in the browser. |
| `The request origin is not allowed` | The browser origin must exactly match `application.publicOrigin`, including scheme, hostname and port. Correct the server JSON or public URL, then restart the server. |
| Application reports the server unavailable | Confirm the production build exists and the Node server and Nginx proxy are running. Retry `/api/session` through the public origin. |
| Page tools remain on “Publishing…” | Reload the page. A native-capable browser uses Native WebMCP; a standard browser uses the explicitly labelled in-page bridge. |
| OpenAI explanation unavailable | Continue with the labelled procedure fallback or select **Retry OpenAI analysis**. The fallback retrieves the same procedure and never uses a generic action catalogue. |
| Recommendation expired | Select **Refresh evidence**. Never reuse a plan from an older decision revision. |
| Procedure step was blocked | Read the returned reason, close any other approval dialog, refresh evidence and verify procedure order and current state. Do not bypass the guard. |
| Procedure edit reports a stale revision | Close or refresh the editor, review the newly active revision and reapply the intended descriptive change. Never overwrite the newer publication blindly. |
| PRIM live is unavailable | Select **PRIM contract replay**. It preserves the parser contract while clearly labelling values synthetic. |
| Map appears too sparse | Select **Fit problems**, isolate a line, or zoom from Overview to Operations/Detail. |
| Imported simulation is rejected | Use an unedited export from the current application version and inspect the validation message. The previous baseline remains active. |
| Report change appears unsaved | Wait for the persistence indicator to return to **Saved**. Check `/api/operations/events` if it remains on autosaving or reports an error. |
| Report assistant is unavailable | Continue editing manually. With OpenAI disabled, the server produces a complete deterministic chronology from the same persisted log. |
| Report was frozen too early | A frozen report is intentionally immutable. Print/export it if needed, then use the global **Reset** only when starting a new operational workspace. |
