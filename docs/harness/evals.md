# Tests and evals

Source: [ARCHITECTURE.md](../../ARCHITECTURE.md) → Testing, [lib/signal/README.md](../../lib/signal/README.md), [spec 004](../specs/004-crewday-outcome-eval.md), [spec 010](../specs/010-retro-remediation.md), [decision 0004](../decisions/0004-simulated-world-outcome-eval.md).

## Layers

```mermaid
flowchart TB
  subgraph CI[pnpm qa · CI on every PR · never calls a model]
    L[lint + types<br/>lint rejects direct provider SDKs]
    U[domain tests<br/>fake AI, PGlite or Docker]
    PA[parity suite<br/>every op × REST, MCP, Eve]
    RG[registry test<br/>spec table, isolation, parity file per op]
    MS[migration and deploy safety]
    CS[Crewday offline tests<br/>fixture world, fake AI]
    GD[ci-contract: live evals refuse to run in CI]
  end
  subgraph EV[pnpm eval · cheap tier, live models, on demand]
    G[GenUI offline eval]
    ES[Eve tool smoke]
    M[eval:matching<br/>precision@3, false-match, recall, cost, p95]
    AG[eval:agents<br/>~15 scripted requests to real agents]
  end
  subgraph OUT[Outcome evals · dollars, only when asked]
    CD[eval:crewday<br/>Signal vs vote board]
    AO[Agent outcome eval<br/>spec 005, later]
  end
  CI --> EV --> OUT
```

No UI tests: pages are checked by hand in a browser against DESIGN.md.

## Which eval a change needs

```mermaid
flowchart LR
  C[Changed path] --> A{where?}
  A -->|lib/signal/ai/**, domain/matching*| M[pnpm eval:matching]
  A -->|agents/**, lib/mcp/**| AG[pnpm eval:agents]
  A -->|evals/crewday/**, policy or metric code| CD[pnpm eval:crewday, when asked]
  A -->|anything| T[pnpm test:changed + lint + types<br/>full suite runs once, in CI]
```

## Parity

```mermaid
flowchart LR
  T[case table<br/>input, expect or check] --> FX[fixture db]
  FX --> R1[REST route handler]
  FX --> R2[MCP server<br/>public or operator]
  FX --> R3[Eve tool<br/>assistant or operator]
  R1 & R2 & R3 --> N[normalize ids, timestamps]
  N --> EQ{output, error code,<br/>events identical?}
```

## Test databases

```mermaid
flowchart LR
  ENV{DATABASE_URL_TEST set?} -->|yes| DK[(Docker Postgres + pgvector<br/>per-worktree database name)]
  ENV -->|no| PG[(PGlite, fresh per file)]
  DK & PG --> H[harness: truncate tables,<br/>configureSignalRuntime with fake AI]
  H -. never .-> DEV[(dev / prod DATABASE_URL)]
```

## Agent behaviour eval (`pnpm eval:agents`)

```mermaid
sequenceDiagram
  participant Run as evals/agents/run.ts
  participant H as harness.ts
  participant DB as seeded test DB
  participant M as model (Gateway, or --fake script)
  Run->>DB: fresh seed
  Run->>H: load agent like eve compiles it<br/>instructions.md + tools/ + dynamic Signal tools
  loop each scenario
    H->>M: generateText with tools
    M-->>H: tool calls
    H->>DB: executeOperation (real path)
    H->>Run: check tool calls, key args, DB state
  end
  Run-->>Run: report: checks, traces, latency, spend<br/>evals/agents/results/latest.json
```

Not reproduced: eve's durable runtime, built-in `eve__*` tools, compaction.

## Crewday outcome simulation (`pnpm eval:crewday`)

```mermaid
flowchart TD
  REC[Hand-written recipe<br/>company, strategy, themes, personas] --> GENW[crewday:generate<br/>LLM signals from personas, leakage check]
  GENW --> W1[crewday-dev v1<br/>~600 signals, tuning]
  GENW --> W2[crewday-test v1<br/>held out, acceptance only]
  W1 --> ENG[Discrete-event engine<br/>simulated clock via configureSignalRuntime]
  ENG --> SUBP[Submitter policy<br/>oracle + noise: p_attach, p_wrong]
  ENG --> PMP{PM policy}
  PMP --> OR[oracle: weekly budget, triage by ground truth,<br/>manual dedup, strategy-implied decisions]
  PMP --> FS[follows_signal: publishes Signal's<br/>recommendation, overrides 20%]
  SUBP & OR & FS --> SURF[REST · public MCP · Operator MCP]
  SURF --> ARMS{Arm}
  ARMS --> SA[Signal: production AI ports]
  ARMS --> BA[Vote board: keyword search, no suggestions]
  SA & BA --> SCORE[Scorer: get_metrics + hidden ground truth<br/>bootstrap 95% CIs, spend meter]
  SCORE --> RPT[True prevention · decision quality ·<br/>revenue coverage · PM organizing share ·<br/>guardrails · planted-PII check]
```

Status: worlds generated and runner merged; the first recorded live lift run on `crewday-dev` (task 04) is still open, and the sweep, tagged history, and harder matching set are deferred. Runs refuse any database that is not local Docker or PGlite.

**Kill signal:** if Signal does not beat the vote board on true prevention by 20 points on `crewday-test`, the bet is flagged before any pilot.
