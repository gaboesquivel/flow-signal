# AI pipelines

Fixed workflows, not agent loops, wherever the question is narrow ([decision 0002](../decisions/0002-retrieve-then-judge-matching.md)). Source: `lib/signal/domain/`, `lib/signal/ai/`.

## Ports

```mermaid
flowchart LR
  subgraph Ports[ctx.ai · ai/ports.ts]
    X[extractor]
    E[embedder]
    R[retriever]
    J[judge]
    RS[reasoner]
  end
  X & J --> HK[Haiku via Gateway<br/>structured output]
  E --> EMB[Gateway embeddings]
  R --> PGV[(pgvector)]
  RS --> SN[Sonnet via Gateway<br/>one task-agnostic call per ReasonerTask]
  Ports -. tests .-> FK[createFakeAi / createUnavailableAi]
  Ports -. sim board arm .-> BA[boardAi: keyword search, no suggestions]
```

## Hot path: preview → submit

```mermaid
sequenceDiagram
  participant C as Caller (UI / MCP / agent)
  participant P as preview_signal
  participant X as extractor (Haiku)
  participant E as embedder
  participant R as retriever (pgvector)
  participant J as judge (Haiku)
  participant S as submit_signal
  C->>P: title, body
  par concurrently
    P->>X: draft need statement, solution, additional asks
  and
    P->>E: embed text
    E->>R: top 8 needs with an embedding
    R->>J: judge each candidate
    J-->>P: probability + reason
  end
  P-->>C: ≤ 3 matches ≥ 0.6, draftNeed, previewId (hash, no state)
  Note over P,C: any AI failure → ai: "unavailable", no matches
  C->>S: target.needId or target.newNeed, previewId, idempotencyKey
  S-->>C: signal + My signals token
  S-)S: after(): embed draft need, schedule suggestion generation
```

Budgets: ≤ 2 s p95, ≤ $0.01 per signal, false-match ≤ 5%.

## Off the hot path: suggestion generation

```mermaid
flowchart TD
  SIG[fresh signal, not a replay] --> SCH[scheduleSuggestionGeneration<br/>Next.js after]
  SCH --> GEN[generateSuggestionsForSignal]
  GEN --> K1[draft_need: approved statement]
  GEN --> K2[merge: among top 5 vector neighbours<br/>draft-created needs only]
  GEN --> K3[theme: for unthemed need]
  GEN --> K4[public_summary: anonymized<br/>dropped if it leaks name, email, company]
  GEN --> K5[split: signals asking for something else]
  GEN --> K6[priority: 0–5 per criterion with reasons]
  K1 & K2 & K3 & K4 & K5 & K6 --> PEND[(pending suggestion<br/>suggestion.created by signal:ai)]
  GEN -. kind already pending or AI fails .-> SKIP[skip that kind; never throws]
```

## Resolving a suggestion

```mermaid
flowchart TD
  RS[resolve_suggestion id, action, edit?] --> LOCK{pending?}
  LOCK -->|no| CF[conflict]
  LOCK -->|yes| ACT{action}
  ACT -->|edit| VAL{kind's edit schema}
  VAL -->|bad| VF[validation_failed]
  VAL -->|ok| APPLY
  ACT -->|accept| APPLY[kind handler apply<br/>suggestion-kinds.ts]
  ACT -->|reject| REJ[kind handler reject]
  APPLY --> MARK[status, resolved_at, resolver kind<br/>+ suggestion.accepted / edited event]
  REJ --> MARK2[+ suggestion.rejected event]
  MARK --> EMB[after commit: re-embed changed needs]
```

| Kind           | Accept / edit applies                         |
| -------------- | --------------------------------------------- |
| draft_need     | draft → open, statement                       |
| merge          | `mergeNeeds`: move signals, `need.merged`     |
| theme          | set or create theme                           |
| public_summary | approve text; only now public                 |
| split          | `splitNeed`: new need, `need.split`           |
| priority       | upsert scores; PM edits stored with source pm |
| decision_brief | keep or replace markdown for publishing       |

## Decide

```mermaid
flowchart LR
  F[need-facts: supporters, ARR, use cases,<br/>scores, trend · no PII] --> DB[draftDecisionBrief<br/>reasoner task decision_brief]
  DB --> SUGG[decision_brief suggestion]
  SUGG --> RES[PM accept / edit]
  RES --> PUB[publishDecision · one transaction<br/>need status + decisions row + decision.published]
  PUB --> MY[get_my_signals and public need view]
```
