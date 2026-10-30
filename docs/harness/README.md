# Agent harness — visual docs

Snapshot of how Signal's agents, surfaces, AI pipelines, evals, and delivery loop fit together, as of **2026-10-30** (`main`, after specs 006, 007, and 010). Diagrams are Mermaid; GitHub and most editors render them.

| Doc                                            | Perspective | What it shows                                                                     |
| ---------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| [product-workflows.md](./product-workflows.md) | Product     | The seven core journeys: submit, discover, track, triage, decide, agent, strategy |
| [runtime.md](./runtime.md)                     | Tech        | Surfaces → adapters → one operation registry → domain → AI ports and database     |
| [agents.md](./agents.md)                       | Tech        | Eve Assistant and Operator agents, console chat, MCP servers, auth, models, GenUI |
| [ai-pipelines.md](./ai-pipelines.md)           | Tech        | Matching hot path, suggestion generation, triage, readiness, decision briefs      |
| [evals.md](./evals.md)                         | Tech        | Test and eval layers: parity, domain, migrations, matching, agents, Crewday       |
| [dev-loop.md](./dev-loop.md)                   | Process     | Flow skills from idea to merged PR, hooks, permissions, CI, migrations, deploy    |

## The whole harness on one page

```mermaid
flowchart LR
  subgraph People
    S[Submitter]
    PM[Product manager]
  end
  subgraph Agents
    EXT[External agents<br/>support copilots, PM assistants]
    AST[Eve Assistant]
    OPA[Eve Operator]
    CC[Console chat<br/>Operator instructions, read-only ops]
  end
  subgraph Surfaces
    UI[Public board + PM console<br/>typed client]
    REST[REST /api/*]
    PMCP[Public MCP /api/mcp]
    OMCP[Operator MCP<br/>/api/mcp/operator]
  end
  REG[[Operation registry<br/>23 operations]]
  EXEC[executeOperation<br/>validate · run · envelope]
  DOM[Domain rules<br/>lib/signal/domain]
  AI[(AI ports via AI Gateway<br/>extract · embed · retrieve · judge · reason)]
  DB[(Postgres + pgvector<br/>append-only events)]

  S --> UI --> REST
  PM --> UI
  PM --> CC
  EXT --> PMCP
  EXT -->|secret| OMCP
  REST --> REG
  PMCP --> REG
  OMCP --> REG
  AST -->|public ops| REG
  OPA -->|all ops, writes need approval| REG
  CC -->|8 read ops| REG
  REG --> EXEC --> DOM
  DOM --> AI
  DOM --> DB
```

**The one rule:** every capability is one operation, defined once in `lib/signal/operations/`. REST, MCP, and Eve tools are generated from it, so no surface holds business logic, and the parity suite proves every surface returns the same output, errors, and events.

**What is not done yet:** a recorded live Crewday lift run (spec 004 task 04; the runner is built), its behaviour sweep and run history (tasks 05–07, deferred), agent outcome evals (spec 005), and the candidate specs 002, 003, 008, and 009. Diagrams mark these as _planned_.
