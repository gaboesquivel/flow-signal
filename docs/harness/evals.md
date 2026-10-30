# Tests and evals

Source: [lib/signal/README.md](../../lib/signal/README.md) → Tests, Parity, Agent behaviour evals; [spec 004](../specs/004-crewday-outcome-eval.md); [decision 0004](../decisions/0004-simulated-world-outcome-eval.md).

## Layers

```mermaid
flowchart TB
  subgraph CI[pnpm qa · CI on every PR · never calls a model]
    L[lint + types]
    U[domain tests<br/>fake AI, PGlite or Docker]
    PA[parity suite<br/>every op × REST, MCP, Eve]
    RG[registry test<br/>spec table, isolation, parity file per op]
    CS[Crewday offline smoke<br/>50 signals, fake AI]
  end
  subgraph EV[pnpm eval · on demand, live models, never CI]
    G[GenUI offline eval]
    ES[Eve tool smoke]
    M[eval:matching<br/>precision@3, false-match, recall, cost, p95]
    AG[eval:agents<br/>~15 scripted requests to real agents]
  end
  subgraph OUT[Outcome evals]
    CD[eval:crewday · Signal vs vote board<br/>task 04 planned]
    AO[Agent outcome eval<br/>spec 005 candidate]
  end
  CI --> EV --> OUT
```

Rule of thumb: change agent instructions, agent tools, or operation descriptions → run `pnpm eval:agents`. Change matching prompts, models, or threshold → run `pnpm eval:matching`.

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

## Crewday outcome simulation (spec 004)

```mermaid
flowchart TD
  REC[Hand-written recipe<br/>company, strategy, themes, personas] --> W1[crewday-dev world<br/>tuning]
  REC --> W2[crewday-test world<br/>held out]
  W1 --> ENG[Discrete-event engine<br/>simulated clock via configureSignalRuntime]
  ENG --> SUBP[Submitter policy<br/>oracle + noise: p_attach, p_wrong]
  ENG --> PMP[PM policy<br/>weekly action budget, triage by ground truth,<br/>manual dedup, decide when ready]
  SUBP & PMP --> SURF[REST · public MCP · Operator MCP]
  SURF --> ARMS{Arm}
  ARMS --> SA[Signal: production AI ports]
  ARMS --> BA[Vote board: keyword search, no suggestions]
  SA & BA --> SCORE[Scorer: get_metrics + hidden ground truth<br/>bootstrap 95% CIs]
  SCORE --> RPT[True prevention · decision quality ·<br/>revenue coverage · PM organizing share · guardrails]
```

Status: world format, fixture world, engine, policies, arms, and offline scorer are done; generating full worlds (task 02) and the live lift run (task 04) are open; sweep, history, and harder matching set are deferred.

**Kill signal:** if Signal does not beat the vote board on true prevention by 20 points on `crewday-test`, the bet is flagged before any pilot.
