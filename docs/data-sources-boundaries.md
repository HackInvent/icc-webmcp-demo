# Data sources and operational boundaries

This document is the truth contract for the current Paris ICC demonstration. It
separates simulated state, optional passenger-information evidence, static network
assets and agent-generated explanations. The interface is a decision-support
prototype, not an operational railway control system.

## Source classification

| Layer | Source | Current use | Explicit boundary |
| --- | --- | --- | --- |
| Native operational twin | Deterministic local simulation | 21-line train locations, delays, incidents, restrictions and decision revisions | Not live telemetry and not a signalling plan |
| Detailed corridors | Deterministic local simulation | RER A, RER B, Metro 13 and Metro 14 trains, directional CDVs, incidents, regulation, crews and traction power | Fictional scenario values; no field system connected |
| D-1 schedule | Bundled sample or locally imported CSV | Preview, impact evaluation, reviewed server-authoritative commit, persistence and undo | Not an operator timetable or workforce system |
| PRIM live | IDFM PRIM SIRI Lite Estimated Timetable | Read-only passenger estimated calls for four configured lines | Not train position, occupancy, signalling or movement authority |
| PRIM replay | Synthetic values encoded in the same SIRI Lite contract | Offline demo and repeatable parser validation | Must always be labelled replay/synthetic |
| Network topology and artwork | Committed SVG/JSON assets plus declared topology metadata | Stable station/interstation IDs and rendering geometry | Static reference asset; source and redistribution chain require verification |
| Procedure catalogue | Local versioned DEMO documents | Incident-code search, cited next steps and normal-state criteria | Synthetic and non-official; not an RATP, IDFM or regulatory instruction |
| OpenAI analysis | Server-side Responses API using bounded WebMCP outputs | Prioritises and explains retrieved procedure steps | Cannot create a valid step, grant approval or prove a state change |

## Deterministic simulated state

All displayed operational state is fictional unless a field is explicitly labelled
as PRIM evidence or static reference metadata. The simulation includes:

- train assignments and delay values;
- station/interstation occupation and detailed-corridor CDV state;
- incident occurrence times, codes, effects, severity and impact;
- restrictions, regulation actions and recovery receipts;
- passenger counts attached to simulated trains;
- driver-resource tokens, duties, qualifications and relief risk;
- power-section voltage, current, load and isolation state;
- D-1 services, tracks, driver assignments and change impacts.

The native 21-line engine and the four-line detailed-corridor engine are related demo
views, not two synchronized copies of a live railway. They have explicit simulation
clocks and revisions. Telemetry progression is separated from decision revision so a
moving clock does not silently validate or invalidate an operator decision.

Simulation speed controls are demo accelerators. Displayed time, occurrence time,
passenger exposure, delays, currents, voltages and resource values must not be
represented as current RATP, IDFM, SNCF or infrastructure-manager measurements.

## Train-state semantics

A native train has one authoritative operational location at a time:

- a **station**, including the modelled 20-second dwell; or
- an **interstation**, identified by one stable native object ID.

The renderer keeps the train glyph stable in the display slot owned by its current
station or interstation. At the next deterministic route boundary it is rebound and
appears in the next object. There is no transform tween between objects and no
continuous geographic coordinate, track-circuit observation, or live position
report.

The detailed corridor has its own directional CDV model. Those synthetic CDVs must
not be projected onto the native map as if they were real signalling sections.

## PRIM live and contract replay

The optional server connector accepts four known line identifiers: RER A, RER B,
Metro 13 and Metro 14. In live mode it requests the configured IDFM PRIM per-line
endpoint with a server-held key and passes the response to the strict SIRI Lite
Estimated Timetable parser.

Permitted PRIM claims are limited to the returned passenger-information evidence,
including line reference, estimated vehicle journey, stop, expected call time,
upstream timestamp, connector receipt time and line-level availability.

PRIM does not provide this application with:

- continuous train coordinates;
- CDV, axle-counter, route or signal state;
- movement authorities or interlocking commands;
- traction-power telemetry or switching authority;
- crew identity, duty or availability;
- incident-management commands.

Replay uses synthetic values in the same SIRI shape and the same parser. It proves
contract compatibility and repeatability, not connection freshness. A partial live
result means only that some requested lines succeeded; it does not make any
simulation layer live. See [IDFM PRIM connector and evidence boundary](prim-connector.md).

## Static topology and map asset

The active map loads [the committed SVG](../artifacts/ratp-network-native.svg) and
[its manifest](../artifacts/ratp-network-native.json). They provide stable demo
geometry and object identifiers for 21 rendered lines, 390 canonical station records
and 467 physical interstations. Exterior branches may be contracted by the artwork.
The asset is not a track plan, geographic survey, signalling plan or complete
passenger topology.

The exact provenance chain of the artwork and every transformation step must be
verified before public redistribution or production use. This document does **not**
assert that the SVG is an authorised or official RATP derivative. Do not infer such
status from filenames, embedded metadata, visual similarity, a URL or a recorded
hash. Reconcile the actual source files, dates, authorship, licences and permitted
transformations, then update the notices with evidence.

Project code is MIT-licensed. That licence does not relicense railway artwork,
operator names, logos, trademarks, GTFS data or other third-party material. Retain
[the third-party notice](../THIRD_PARTY_NOTICES.md), independently verify applicable
RATP/IDFM and source-platform terms, and obtain any permission required for the
intended publication.

## Procedures and decision support

Every simulated incident has a deterministic incident code. The incident modal
uses exactly three read-only page tools in order:

1. `inspect_incident_decision_context`;
2. `search_operational_procedures`;
3. `get_operational_procedure`.

The selected document is bound by procedure ID, revision and content hash. A valid
agent output may cite only step IDs present in that document. The application, not
free-form model text, constructs the arguments for
`apply_reviewed_procedure_step`. Before that write, the read-only
`assess_operator_procedure_choice` tool explains whether the selected step
differs from the current agent recommendation. The advice never blocks a
documented choice. The write then requires visible one-shot operator approval and
revalidates the current decision revision.

The bundled English catalogue is demo-authored, synthetic and explicitly
`official: false`. It contains no approved internal RATP/IDFM procedure and must not
be presented as a regulatory instruction. A real deployment would need an
authorised controlled-document source, access policy, lifecycle, revision process,
distribution rights and operational validation.

When OpenAI is disabled or unavailable, a labelled deterministic fallback orders
steps from the same retrieved document. It must not be described as model output.
Neither path proves that a recommendation is safe for a real railway. A successful
simulation receipt proves only that one reviewed demo step was recorded or applied
to local state.

## Human authority and control boundary

Paris ICC exposes no live field-control interface. In particular, it cannot send:

- signal aspects, routes or movement authorities;
- train speed or braking commands;
- switch, point or interlocking commands;
- traction-power isolation or restoration commands;
- real timetable, roster or passenger-information publication changes.

Read and evaluation tools may be invoked without an approval prompt. Every WebMCP
tool classified as a write is simulation-only and pauses at a visible one-shot
approval dialog. Exact revision guards, procedure binding and receipts support
review; they are not a safety case, certified interlocking or substitute for a
qualified operator and field authorization.

## Privacy and secret handling

- Driver resources use pseudonymous tokens. The demo contains no driver names,
  absence reasons, medical data, personal statements or live HR records.
- Schedule CSV files are parsed inside the application and committed only to the
  authenticated same-origin operations workspace; they are not sent to an external
  timetable service. Only use synthetic or authorised input.
- Simulation configuration exports are local scenario files. Do not add real
  operational or personal data before sharing them.
- The shared access code creates an HttpOnly session. It is not an individual
  identity, role model or production-grade accountability mechanism.
- OpenAI and PRIM keys belong in the private server configuration and must never be
  placed in `VITE_` variables, browser storage, URLs, screenshots or committed files.
- When OpenAI analysis is enabled, bounded page-tool outputs are relayed through the
  authenticated application server to the configured OpenAI Responses endpoint.
  Use only data authorised for that processing; the current corpus is synthetic.
- The application has an embedded SQLite demonstration store for runtime state,
  ordered events, and idempotent command receipts. It is not an immutable audit
  archive, certified operational database, backup system, or records-management
  control.

## Claims to avoid

Do not claim or imply that Paris ICC:

- displays live train positions, signals, CDVs, incidents, drivers or power state;
- uses PRIM estimated calls as signalling or train-position truth;
- controls a railway, substation, timetable, roster or passenger channel;
- contains official RATP/IDFM internal operating procedures;
- is affiliated with, endorsed by or authorised by RATP, IDFM, SNCF or SNCF Réseau;
- uses an officially licensed map derivative unless the full source chain and rights
  have first been verified;
- is safety-certified, SIL-rated, NIS2-certified, cybersecurity-certified or ready
  for operational service;
- computes a certified optimum, guarantees recovery, predicts disruption accurately
  or replaces a regulator;
- turns an in-page compatibility bridge into native browser WebMCP;
- treats a recommendation as applied without a successful tool receipt;
- treats removal of one restriction as proof that the incident has returned to
  normal.

Safe wording is precise: **PRIM passenger-information evidence may be live when the
optional connector is configured; all train movement, infrastructure, incident,
crew, schedule and power behavior remains deterministic local simulation.**

For the corresponding operator workflow, see the
[Paris ICC operator guide](operator-guide.md) and the
[jury walkthrough](jury-walkthrough.md).
