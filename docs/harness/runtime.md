# Runtime: one registry, many surfaces

Source: [lib/signal/README.md](../../lib/signal/README.md), [ARCHITECTURE.md](../../ARCHITECTURE.md), [docs/database.md](../database.md).

## Request path

```mermaid
flowchart TD
  subgraph Surfaces
    UI[Pages<br/>signalServerClient / createSignalClient] --> REST
    REST[REST adapter<br/>app/api/...path/route.ts]
    MCP[MCP adapter<br/>adapters/mcp.ts]
    EVE[Eve adapter<br/>adapters/agent.ts]
    CC[Console chat<br/>api/operator/chat/answer.ts]
  end
  REST -->|actor human, or agent with X-Signal-Agent| GATE
  MCP -->|actor agent, MCP client name| GATE
  EVE -->|actor agent, eve:assistant / eve:operator| GATE
  CC -->|read-only ops| GATE
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

## Operations (23)

```mermaid
flowchart LR
  subgraph Public[access: public · 5]
    search_needs
    get_need
    preview_signal
    submit_signal
    get_my_signals
  end
  subgraph Read[access: operator · read · 11]
    list_suggestions
    get_need_detail
    list_operator_needs
    list_ready_needs
    list_themes
    get_criteria
    get_strategy
    get_demand_summary
    draft_decision_brief
    check_public_text
    get_metrics
  end
  subgraph Write[access: operator · effects: write · 7]
    resolve_suggestion
    merge_needs
    undo_merge
    split_need
    set_criteria
    set_strategy
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
| Console chat                        | 2 reads    | 6 reads       | never writes                                                   |
| OpenAPI, `.well-known`, server card | yes        | never         | discovery lists public only                                    |

## Write path, events, and the off-hot-path scheduler

```mermaid
sequenceDiagram
  participant Op as operation.run
  participant Tx as db.transaction
  participant Ev as events table
  participant Sch as scheduleOffHotPath
  Op->>Tx: begin
  Tx->>Tx: domain writes
  Tx->>Ev: recordEvent(dedupeKey from idempotencyKey)
  Note over Tx,Ev: rollback writes no event, and a retry counts once
  Tx-->>Op: commit
  Op->>Sch: embed changed needs, suggestion generation,<br/>readiness check, auto briefs
  Note over Sch: after() in route handlers, a recorder in tests
```

## Context seam

```mermaid
flowchart LR
  RT[runtime.ts<br/>createOperationContext] --> PROD[Production<br/>DATABASE_URL + Gateway ports + wall clock]
  RT --> TEST[Tests<br/>PGlite or Docker + createFakeAi]
  RT --> SIM[Crewday sim<br/>simulated clock + Signal or board ports]
```

`configureSignalRuntime({ db, ai, clock })` is the one seam tests, parity, and the simulator use. Operations must never read wall-clock time directly.

## Data and migrations

```mermaid
flowchart LR
  SC[lib/db/schema.ts] -->|pnpm db:generate| MG[drizzle/ versioned SQL migrations]
  MG -->|pnpm db:migrate<br/>never destructive| NEON[(Neon Postgres + pgvector<br/>main / dev branches)]
  MG --> VB[vercel-build.mjs<br/>production builds only]
  VB --> NEON
  SC -->|schema hash, rebuilt per run| DOCK[(Docker Postgres 18 + pgvector<br/>via local Neon proxy)]
  SC --> PGL[(PGlite + pgvector<br/>CI and fallback)]
```

Previews never change the shared database. `pnpm db:seed` refuses on Vercel, in CI, and on a database that already has needs unless `--replace` is passed.
