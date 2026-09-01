# Simulation and procedure model

This document is the maintained domain reference for the local simulator,
incident codification, synthetic procedure catalogue, and return-to-normal
lifecycle.

## Two complementary simulation engines

Paris ICC deliberately separates the network-scale visual twin from the more
detailed four-line operational model.

| Engine | Scope | Primary use | State revision |
| --- | --- | --- | --- |
| Native network | 21 Metro/RER lines, 390 stations, 467 interstations, 42 trains | Network overview, semantic zoom, incident-agent demonstration | Separate telemetry and decision revisions |
| Detailed corridor | RER A, RER B, Metro 13, Metro 14 | CDV occupancy, regulation, D-1 resources, power, detailed records | Snapshot and decision revisions |

Both engines are deterministic. In the authenticated deployment runtime they are
owned by the server operations workspace: the browser renders authoritative
snapshots and sends guarded commands. The standalone development runtime keeps an
in-browser compatibility controller. Both modes share the same domain engines and
export contract, but the two engine views do not pretend to be the same signalling
model.

## Time and train location

Both operational engines advance by one simulated second per step. The top-bar
controls pause them or apply a ×1, ×2, or ×4 simulation multiplier. In authenticated
server mode, the operations timer fires every 1,000 ms by default, so ×1 tracks
wall-clock time while ×2 and ×4 are explicit accelerators. Train positions remain
discrete station/interstation occupations rather than interpolated movement.

Native trains use a 20-second simulated station dwell. Operationally, a train is
in exactly one of two location states:

- **station**, while dwelling at a named station;
- **interstation**, while occupying the named station-to-station object.

The renderer keeps the train in a fixed slot owned by that station or
interstation. At the next route boundary it disappears from that slot and appears
in the next object; no continuous transform is used between objects.

The detailed corridor advances by one simulated second per step and retains its
own train/CDV mechanics. A station dwell lasts exactly 20 simulated seconds.

## Passenger demand and station exchange

The native snapshot owns one passenger state for every line/station pair. For
Metro, its constant arrival rate is:

```text
OMNIL 2025 annual journeys / rendered stations on the line / (365 × 24 × 3,600)
```

For RER A–E, the same calculation uses the published daily operator/authority
reference divided by rendered stations and 86,400 seconds. No headway, capacity,
interchange or load-factor coefficient changes that rate. Fractional arrivals
are retained in a remainder, while the visible queue and cumulative counters are
integers. Source years, qualifiers and conversion limits are documented in
[Line ridership reference](line-ridership-sources.md).

Passenger exchange happens exactly once when a train changes from an
interstation object to a station object:

1. 10% of onboard passengers alight at an intermediate station, rounded to the
   nearest whole passenger; at a terminus, all onboard passengers alight.
2. The remaining onboard count determines free reference capacity.
3. Waiting passengers board up to that free capacity.
4. Passengers that do not fit remain in the station queue.

The state records generated, boarded and alighted totals plus the last exchange
time and counts. Queue state and onboard loads use the same persisted/exported
native snapshot and therefore follow pause, ×1/×2/×4, import and Reset semantics.

## Scenario baseline

The native engine exposes five deterministic scenarios:

| Scenario | Purpose |
| --- | --- |
| `nominal` | All 21 lines without an active native restriction |
| `m13-works` | Late engineering handback on Metro 13 |
| `rer-a-signal` | Central RER A detection failure |
| `m14-power` | Metro 14 traction-power instability |
| `multi-event` | Three concurrent constraints for a network-wide story |

Reset returns the engines to the selected baseline. It is not an undo of a real
operation.

## Creating incidents

Use **SimView -> Incidents -> Add incident**. The form requires:

- incident type: infrastructure, passenger, rolling stock, staff, power, works,
  external, communications, or security;
- target type and exact target: train, station, interstation, line, or power section;
- compatible effect;
- severity, title, and summary;
- occurrence date and time in Paris operational time.

An occurrence in the future creates a planned incident. The engine activates it
when simulated time reaches that timestamp and applies the modelled effect. Every
incident preserves its occurrence time in ISO-8601 form when exported.

## Incident codification

The application derives an immutable simulation code from the incident type,
target type, and effect. Codes use the `ICC-INC-*` namespace; they are exercise
identifiers, not operator or regulatory codes.

Examples:

| Code | Meaning in this simulation |
| --- | --- |
| `ICC-INC-RST-TRN-IMM-001` | Immobilised rolling stock train |
| `ICC-INC-INF-INT-BLK-001` | Infrastructure interstation block |
| `ICC-INC-WRK-INT-BLK-001` | Engineering worksite block/handback |
| `ICC-INC-PWR-PWR-DEG-001` | Degraded traction-power section |
| `ICC-INC-PWR-PWR-ISO-001` | Isolated traction-power section |

Classification is centralized in `src/procedures/index.ts`. Imported detailed
incidents from an earlier schema are normalized to the same code system.

## Procedure catalogue

The local catalogue contains 14 versioned demonstration documents.

| Procedure | Scope |
| --- | --- |
| `ICC-PROC-RST-TRAIN-001` | Immobilised rolling stock |
| `ICC-PROC-ONBOARD-001` | Passenger, staff, or external train event |
| `ICC-PROC-STATION-CLOSURE-001` | Station closure and controlled reopening |
| `ICC-PROC-STATION-WORKS-CLOSURE-001` | Station works closure, flanking turnbacks, split provisional service, and handback |
| `ICC-PROC-STATION-DWELL-001` | Extended station dwell |
| `ICC-PROC-INTERSTATION-BLOCK-001` | Unplanned interstation blockage |
| `ICC-PROC-WORKS-HANDBACK-001` | Engineering possession handback |
| `ICC-PROC-INTERSTATION-SPEED-001` | Temporary interstation speed restriction |
| `ICC-PROC-POWER-DEGRADED-001` | Degraded traction-power operation |
| `ICC-PROC-POWER-ISOLATION-001` | Isolated traction-power section |
| `ICC-PROC-POWER-WORKS-001` | Electrical works handback |
| `ICC-PROC-SCADA-COMMUNICATION-001` | Degraded or lost line-supervision communications and maintenance dispatch |
| `ICC-PROC-ABANDONED-BAGGAGE-001` | Station protection and explicit police clearance |
| `ICC-PROC-ROLLING-STOCK-TOWING-001` | Protected rescue and three-hour nominal towing operation |

Together they cover the core type/target/effect combinations plus dedicated
cases exposed by SimView: station works closure, degraded communications, lost
communications, abandoned baggage, and towing-required rolling stock. The
current catalogue revision is `2026.08.30.4`; documents carry their own
revision (`1.0` or `1.1`) and a stable SHA-256 content hash.

For station works closure and abandoned baggage, graph-grounded flanking
turnbacks and the split provisional service are mandatory procedure steps. Each
requires explicit operator approval and a persistent receipt. The affected
station is absent from every service segment; reopening remains guarded by the
applicable engineering handback or police clearance and monitored recovery.

> These documents are synthetic, demo-authored evidence. They are explicitly
> not official RATP, IDFM, infrastructure-manager, or regulatory instructions.
> A real deployment must ingest authorized controlled documents and preserve
> their ownership, revision, validity, and distribution rules.

The **Procedures** page at `#/procedures` exposes applicability, source notice,
document reference, revision, hash, ordered steps, required evidence, and the
return-to-normal policy.

### Controlled step editing

The bundled 14-document catalogue is an immutable baseline. **Edit procedure**
opens a three-column workspace with the complete step rail; **Edit step** opens
the same workspace directly on the selected step. The editor warns before a step
change or close would discard unpublished fields, and it publishes one step
revision at a time.

The editable attributes are deliberately limited to:

- step title, operator instruction, rationale, and responsible role;
- preconditions, required evidence, and completion criteria; and
- minimum, nominal, and maximum planning duration in seconds.

The procedure ID, step ID, order, phase, mandatory status, executable capability,
operator-confirmation rule, incident applicability, machine evidence-reference
kind, and return-to-normal policy are locked. The editor displays these execution
invariants beside the draft, validates content and duration ordering, and shows
the pending field-level diff before publication.

Publication is optimistic and append-only. The browser submits the current
procedure revision and SHA-256 hash with the step patch. A stale identity or an
unknown/locked field is rejected. An accepted patch produces a new document
revision and hash, advances the workspace catalogue sequence, persists the active
override in embedded SQLite, and records a timestamped
`procedure-step-revision-published` operator action. The baseline and earlier
workspace revisions remain unchanged.

New searches and incident analyses use the active revision. A procedure execution
already tied to a previous ID/revision/hash retains that exact historical document
until its workflow is complete; later editing cannot silently change an instruction
mid-execution. The exact historical identity remains available to WebMCP retrieval
and server-side step validation.

## Mandatory procedure lifecycle

Every current document uses the same guarded lifecycle:

~~~mermaid
stateDiagram-v2
    [*] --> Acknowledge
    Acknowledge --> Protect
    Protect --> Diagnose
    Diagnose --> Coordinate
    Coordinate --> Recover
    Recover --> Observe
    Observe --> Verify: observation window complete
    Verify --> Close: every criterion + operator sign-off
    Close --> Normal
~~~

The model may prioritize and explain steps, but it cannot add a step or turn free
text into a command. The controlled capability set is:

- `acknowledge`;
- `protect-and-hold`;
- `degraded-operation`;
- `publish-passenger-information`;
- `protect-connections`;
- `dispatch-maintenance`;
- `activate-provisional-service`;
- `activate-turnbacks`;
- `activate-shuttle-bus`;
- `insert-train`;
- `start-towing`;
- `close-incident`.

Diagnostic, coordination, and verification steps are recorded as documentary
operator acknowledgements. Capability steps may change the versioned operational
state only after the same visible one-shot approval. Mandatory steps execute in
document order; optional continuity steps are exposed only when their exact
document capability is due or has a prepared plan.

## Return to normal

Applying a recovery capability does not close the incident. The engine records
the recovery time and telemetry revision, then enforces the document's observation
window:

- the observation window declared by the retrieved procedure (commonly 30 or 60
  operational seconds in the accelerated demonstration scenario).

Verification and closure are blocked until the window has elapsed. Closure also
requires:

- the incident to be resolved;
- no active restriction owned by that incident;
- all mandatory procedure steps to be recorded;
- explicit operator sign-off.

The tool returns a `normalStateVerification` receipt. The current engine verifies
those generic machine signals and returns the document's textual criteria for
human review; it does not claim that every criterion is connected to a certified
field sensor.

## Import and export

The header **Configuration** modal, under **Simulator configuration**, exports
one JSON document with schema
`paris-icc-simulation-configuration-v1`. It includes:

- export and simulation timestamps;
- simulation speed and native scenario;
- native trains and incidents;
- detailed trains, circuits, drivers, incidents, power sections, and events.

The parser rejects invalid JSON, unknown schemas, inconsistent engine state, and
files larger than 4 MB. Selection first creates an in-modal validation preview;
only the explicit **Install imported baseline** action replaces the authenticated
workspace baseline. **Reset** then returns to that imported baseline.

The operations service persists the imported baseline, active procedure
overrides, referenced historical procedure revisions, procedure-execution
progress, receipts, and current twin state in embedded SQLite. They survive a page
refresh and controlled process restart when the signed session, session secret,
and database file are preserved. Procedure edits also survive the global
simulation **Reset**, which starts a new shift without rewriting the controlled
knowledge workspace. These records are intentionally not included in a portable
simulation export, and the event journal is demonstration evidence rather than an
immutable regulatory audit archive.

## Invariants and limits

- Native movement remains on connected rendered interstations and inside the
  owning SVG object.
- A blocked segment holds an approaching train rather than teleporting it.
- The detailed engine prevents conflicting CDV occupancy and invalid speed/state
  combinations.
- Native incident procedures currently drive train, station, and interstation
  modal workflows. Power procedures are present in the catalogue, while power
  incident creation and supervision currently use the detailed simulation.
- The authenticated workspace survives reload and controlled restart in embedded
  SQLite. A JSON export remains the portable scenario interchange format, while a
  stopped-server database copy is required to preserve the complete runtime and
  event history.
- None of these invariants constitutes railway safety certification.

## Source modules

- `src/rail/nativeSimulation.ts`: network-scale engine and scenarios.
- `src/rail/simulation.ts`: detailed four-line engine.
- `src/rail/simulationConfiguration.ts`: combined import/export contract.
- `src/procedures/types.ts`: procedure and return-normal types.
- `src/procedures/catalogue.ts`: synthetic documents and hashes.
- `src/procedures/integrity.ts`: canonical serialization and SHA-256 integrity.
- `src/procedures/registry.ts`: workspace revisions, active overrides, exact
  historical retrieval, validation, and publication.
- `src/procedures/index.ts`: codification and public procedure exports.
- `src/webmcp/nativeTools.ts`: procedure execution and normal-state guards.
