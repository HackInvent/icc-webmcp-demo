# IDFM PRIM connector and evidence boundary

Last verified: 27 August 2026.

## Connector behavior

Paris ICC can consume an existing regional transport feed instead of inventing a
custom “live” payload. The browser requests one of four canonical line identifiers
from a same-origin authenticated server route. The server holds the PRIM credential,
requests the IDFM per-line endpoint with the `apikey` header, and returns the raw
JSON. A strict client parser then reads the SIRI Lite Estimated Timetable envelope.

The offline replay is not a second, simplified implementation. It emits the same
SIRI keys and runs through the same parser. This keeps the scenario repeatable while the production integration path remains
executable.

```text
IDFM PRIM / SIRI Lite                 Contract replay / SIRI Lite
             │                                  │
             └──────── same strict parser ──────┘
                                │
                   passenger estimated calls
                                │
                 source-aware ICC + WebMCP tools
```

## Existing public contract

The connector follows the official PRIM next-passages service:

- per-line request using `LineRef`;
- authentication through the `apikey` request header;
- JSON response rooted at `Siri.ServiceDelivery`;
- `EstimatedTimetableDelivery` → `EstimatedJourneyVersionFrame` →
  `EstimatedVehicleJourney`;
- journey fields including `LineRef`, `FramedVehicleJourneyRef`,
  `VehicleJourneyName`, `DirectionName`, and `DestinationName`;
- call fields including `StopPointRef`, `StopPointName`, `VehicleAtStop`,
  `AimedArrivalTime`, `ExpectedArrivalTime`, `ExpectedDepartureTime`, and
  `DepartureStatus`.

Primary references:

- [IDFM PRIM — service description](https://prim.iledefrance-mobilites.fr/aide-et-contact/documentation/prise-en-main-des-api/prise-en-main-des-api-prochains-passages/description-du-service)
- [IDFM PRIM — object identification](https://prim.iledefrance-mobilites.fr/aide-et-contact/documentation/prise-en-main-des-api/prise-en-main-des-api-prochains-passages/identification-des-objets)
- [IDFM PRIM — request structure](https://prim.iledefrance-mobilites.fr/aide-et-contact/documentation/prise-en-main-des-api/prise-en-main-des-api-prochains-passages/structure-des-requetes-parametres-dappel)
- [IDFM PRIM — response example](https://prim.iledefrance-mobilites.fr/aide-et-contact/documentation/prise-en-main-des-api/prise-en-main-des-api-prochains-passages/exemple-de-reponses-niveau-quai-retour)
- [IDFM PRIM — per-line API](https://prim.iledefrance-mobilites.fr/fr/apis/idfm-ivtr-requete_ligne)

## Runtime modes

| Mode | Values | Contract/parser | Intended use |
| --- | --- | --- | --- |
| `prim-live` | IDFM response | SIRI Lite / production parser | Use the authenticated read-only connector |
| `prim-replay` | Synthetic scenario | SIRI Lite / production parser | Repeatable operational simulation and CI |
| `simulation` | No passenger feed | None | Exercise the ICC simulator alone |

Each line is fetched and validated independently. One failed line produces a
`partial` state instead of hiding successful observations from the other lines.
The UI and `inspect_prim_feed` WebMCP tool expose mode, provider, contract,
official line reference, line-level state, upstream response time, connector
receipt time, observation count, and any bounded error.

## Safety and semantics

PRIM is passenger-information evidence. This project never relabels an expected
arrival as a continuous train position, a CDV occupation or a signalling state.
The schematic is an independent simulation and says so on screen.

The connection is read-only. The server route exposes no generic upstream URL,
accepts only four known line identifiers, never returns the API key, has an
eight-second timeout, and reduces upstream failures to bounded status codes.
Schedule and regulation writes remain guarded local simulation actions with exact
revision/hash checks and human authorization.

## WebMCP decision-support role

`inspect_prim_feed` is available to a WebMCP-capable external assistant and to the
cross-domain shift-brief workflow. That workflow should establish provenance,
freshness, coverage, and limitations before correlating PRIM evidence with the
visible simulation revision, incidents, aggregate D-1 driver capacity, schedule
version, CDV state, and power constraints.

The embedded incident modal intentionally has a narrower contract: its server-side
agent receives only `inspect_incident_decision_context`,
`search_operational_procedures`, and `get_operational_procedure`. It does not use
PRIM to select or execute an incident procedure. No workflow may silently turn
passenger information into a safety-critical command.

This is the WebMCP advantage over a detached chatbot or classic backend-only MCP:
the agent and operator share the same live page, state, review surfaces, typed
actions, version guards, and visible activity trace. See the
[official OpenAI WebMCP documentation](https://learn.chatgpt.com/docs/webmcp).

## Deployment

Run `npm run configure:server` and enable PRIM in the private
`config/server.local.json`. The API key and upstream URL remain server-side. The
same Node server accepts both `/api/prim-line` and the legacy same-origin function
path used by the current browser bundle.

```bash
npm run check
npm test
npm run build
npm run smoke:prim  # requires server-side PRIM_API_KEY
npm run serve
```

The JSON is excluded from Git and remains private on the application host. If environment
references are used inside it, the key must never use a `VITE_` prefix:
Vite-prefixed variables are bundled into browser JavaScript.
