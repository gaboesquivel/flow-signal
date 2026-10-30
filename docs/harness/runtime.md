# Runtime: one registry, many surfaces

Source: [lib/signal/README.md](../../lib/signal/README.md), [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Request path

```mermaid
flowchart TD
  subgraph Surfaces
    UI[Pages<br/>signalServerClient / createSignalClient] --> REST
    REST[REST adapter<br/>app/api/...path/route.ts]
    MCP[MCP adapter<br/>adapters/mcp.ts]
    EVE[Eve adapter<br/>adapters/agent.ts]
  end
  REST -->|actor human, or agent with X-Signal-Agent| GATE
  MCP -->|actor agent, MCP client name| GATE
  EVE -->|actor agent, eve:assistant / eve:operator| GATE
  GATE{access + rate limit<br/>120/min per IP and op, 16 KB body}
  GATE -->|public or authorized| EX[executeOperation]
  GATE -->|denied| ERR[error envelope]
  EX --> V[zod input parse] --> CTX[OperationContext<br/>actor · db · ai · clock]
  CTX --> RUN[operation.run] --> OUT[zod output parse<br/>plain JSON]
  RUN -->|SignalError| ERR
  RUN -->|DB down: SQLSTATE 08/53/57| ERR
  RUN -->|anything else| INT[internal, sanitized log line]
  OUT --> RES[same bytes on every surface]
```

Error envelope: `{ error: { code, message, retryable } }`.

## Operations (17)

```mermaid
flowchart LR
  subgraph Public[access: public]
    search_needs
    get_need
    preview_signal
    submit_signal
    get_my_signals
  end
  subgraph Read[access: operator · read]
    list_suggestions
    get_need_detail
    get_criteria
    get_demand_summary
    draft_decision_brief
    get_metrics
  end
  subgraph Write[access: operator · effects: write]
    resolve_suggestion
    merge_needs
    undo_merge
    split_need
    set_criteria
    publish_decision
  end
```

| Surface                             | Public ops | Operator ops  | Notes                                                          |
| ----------------------------------- | ---------- | ------------- | -------------------------------------------------------------- |
| REST                                | yes        | bearer secret | `/api/...`, `/api/operator/...`; also OpenAPI                  |
| Public MCP                          | yes        | absent        | plus `health`, `list_component_catalog`, `compose_ui`          |
| Operator MCP                        | yes        | yes           | plus `operator_health`, `config_status`, `public_tool_catalog` |
| Eve Assistant                       | yes        | absent        | plus GenUI tools                                               |
| Eve Operator                        | yes        | yes           | write ops require PM approval (`always()`)                     |
| OpenAPI, `.well-known`, server card | yes        | never         | discovery lists public only                                    |

## Write path and events

```mermaid
sequenceDiagram
  participant Op as operation.run
  participant Tx as db.transaction
  participant Ev as events table
  participant After as after()
  Op->>Tx: begin
  Tx->>Tx: domain writes
  Tx->>Ev: recordEvent(dedupeKey from idempotencyKey)
  Note over Tx,Ev: rollback writes no event, and a retry counts once
  Tx-->>Op: commit
  Op->>After: embed changed needs, schedule suggestion generation
```

## Context seam

```mermaid
flowchart LR
  RT[runtime.ts<br/>createOperationContext] --> PROD[Production<br/>DATABASE_URL + Gateway ports + wall clock]
  RT --> TEST[Tests<br/>PGlite or Docker + createFakeAi]
  RT --> SIM[Crewday sim<br/>simulated clock + Signal or board ports]
```

`configureSignalRuntime({ db, ai, clock })` is the one seam tests, parity, and the simulator use. Operations must never read wall-clock time directly.

## Data

```mermaid
flowchart LR
  APP[Drizzle · lib/db/schema.ts] --> NEON[(Neon Postgres + pgvector<br/>main / test branches)]
  APP --> DOCK[(Docker Postgres 18 + pgvector<br/>via local Neon proxy)]
  APP --> PGL[(PGlite + pgvector<br/>CI and fallback)]
```

Production builds on Vercel apply the schema (`scripts/vercel-build.mjs`); previews never change the shared database.
