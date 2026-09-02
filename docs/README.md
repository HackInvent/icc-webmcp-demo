# Paris ICC documentation

This directory contains the maintained public documentation for Paris ICC. The
source code and executable validation reports remain the authority when a
historical design document differs from the current implementation.

## Recommended reading paths

### Jury or product reviewer

1. [Project overview](../README.md)
2. [Competition narrative and functional description](competition-narrative.md)
3. [60-second jury walkthrough](jury-walkthrough.md)
4. [Operator guide](operator-guide.md)
5. [Data sources and boundaries](data-sources-boundaries.md)

### Technical reviewer

1. [Architecture](architecture.md)
2. [Rail interdependence graph](rail-interdependence-graph.md)
3. [WebMCP and embedded agent](webmcp-agent.md)
4. [Simulation and procedures](simulation-procedures.md)
5. [Development and validation](development-validation.md)

### Deployment operator

1. [Deployment](deployment.md)
2. [Server configuration example](../config/server.example.json)
3. [Server configuration schema](../config/server.schema.json)
4. [PRIM connector](prim-connector.md)

## Maintained reference documents

| Document | Purpose |
| --- | --- |
| [competition-narrative.md](competition-narrative.md) | Canonical product positioning, complete functional description, proof points, reusable copy, and media storyline |
| [architecture.md](architecture.md) | Runtime components, state ownership, server routes, and trust boundaries |
| [rail-interdependence-graph.md](rail-interdependence-graph.md) | Complete station-line graph, transfers, audited cross-station connections, routing, impact analysis, and SVG projection |
| [operator-guide.md](operator-guide.md) | How to run the demonstration and operate every workspace |
| [webmcp-agent.md](webmcp-agent.md) | WebMCP transport, all 21 tools, incident protocol, and approval controls |
| [simulation-procedures.md](simulation-procedures.md) | Simulation models, incident coding, procedure lifecycle, and import/export |
| [data-sources-boundaries.md](data-sources-boundaries.md) | Live/replay/static sources, privacy, licensing, and claims |
| [deployment.md](deployment.md) | Local and Ubuntu/Nginx deployment without Docker or systemd |
| [development-validation.md](development-validation.md) | Contributor commands, tests, and browser validation |
| [ratp-network-atlas.md](ratp-network-atlas.md) | Lightweight native-map smoke retained under the legacy `test:atlas` command name |
| [prim-connector.md](prim-connector.md) | IDFM PRIM SIRI Lite integration contract |
| [rail-reference-sources.md](rail-reference-sources.md) | Dated railway facts used by the four-line reference model |
| [jury-walkthrough.md](jury-walkthrough.md) | Short, deterministic demonstration script |

## Research and historical material

The following files record earlier exploration or intermediate asset pipelines.
They are not the current product contract:

- `hackathon-build/`: scope, PRD, specification, checklist, and build notes from
  earlier implementation stages;
- `ratp-network-faithful-svg.md` and `ratp-network-transparent-svg.md`: historical
  asset-pipeline notes whose source-provenance statements require reconciliation;
- `idfm-europe-opportunity.md`: product research and opportunity analysis.

When demonstrating or deploying the current application, use the maintained
reference documents above and the machine-generated reports in `../artifacts/`.

## Documentation rules

- Clearly label simulation, replay, live passenger information, and static
  reference data.
- Never call the synthetic procedure catalogue official.
- Never call the in-page compatibility bridge native WebMCP.
- Never describe a proposed or approved step as applied without a successful
  simulation receipt.
- Keep secrets, access codes, private deployment scripts, and local logs outside
  this public documentation tree.
