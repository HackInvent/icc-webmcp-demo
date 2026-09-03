# Paris ICC documentation

Paris ICC is a complete, runnable railway decision-support application. It
reproduces an end-to-end operational workflow in a simulated environment.

> **Simulated environment — no real railway system connected.**

This directory contains the maintained public documentation. The source code and
executable validation reports remain the authority when a historical design
document differs from the current implementation.

## Recommended reading paths

### Product reviewer

1. [Project overview](../README.md)
2. [Operator guide](operator-guide.md)
3. [Data sources and boundaries](data-sources-boundaries.md)

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
| [architecture.md](architecture.md) | Runtime components, state ownership, server routes, and trust boundaries |
| [rail-interdependence-graph.md](rail-interdependence-graph.md) | Complete station-line graph, transfers, audited cross-station connections, routing, impact analysis, and SVG projection |
| [operator-guide.md](operator-guide.md) | How to run the operational simulation and operate every workspace |
| [webmcp-agent.md](webmcp-agent.md) | WebMCP transport, all 22 tools, incident and Shift Report protocols, and approval controls |
| [simulation-procedures.md](simulation-procedures.md) | Simulation models, incident coding, procedure lifecycle, and import/export |
| [data-sources-boundaries.md](data-sources-boundaries.md) | Live/replay/static sources, privacy, licensing, and claims |
| [deployment.md](deployment.md) | Local and Ubuntu/Nginx deployment without Docker or systemd |
| [development-validation.md](development-validation.md) | Contributor commands, tests, and browser validation |
| [prim-connector.md](prim-connector.md) | IDFM PRIM SIRI Lite integration contract |
| [rail-reference-sources.md](rail-reference-sources.md) | Dated railway facts used by the four-line reference model |

When evaluating or deploying the current application, use the maintained
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
