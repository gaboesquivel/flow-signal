# Product workflows

Signal turns feature requests into decisions. AI proposes in pencil; people confirm in ink. Source: [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md), specs [001](../specs/001-signal-mvp.md), [006](../specs/006-lean-ledger-ui.md), [007](../specs/007-decision-direction.md).

## The model

```mermaid
flowchart TD
  ST[Strategy<br/>focus themes, revenue focus, capacity per quarter] -.judges.-> N
  T[Theme<br/>PM-defined area] --> N[Need<br/>who needs to do what so that outcome]
  N --> PS[Proposed solutions<br/>AI-extracted]
  N --> SG[Signal × N<br/>verbatim words, email, account, urgency]
  SG --> L[My signals link<br/>carries forward, never grouped by email]
  N -. merge, undoable .-> N2[Another need]
  N --> D[Decision<br/>planned · in progress · shipped · declined]
```

## Lifecycle of a request

```mermaid
stateDiagram-v2
  [*] --> Check: person or agent describes a need
  Check --> AttachExisting: picks a match (add my voice)
  Check --> DraftNeed: none of these (submit new)
  DraftNeed --> Open: PM approves AI statement
  DraftNeed --> Merged: PM accepts merge suggestion
  Open --> Merged: PM merges duplicate
  Merged --> Open: undo merge
  AttachExisting --> Open
  Open --> Ready: supporters or ARR cross the strategy's readiness line
  Ready --> Decided: PM publishes, usually following the recommended direction
  Decided --> [*]: supporters see it on My signals
```

## 1. Submit with a duplicate check (submitter)

The prioritized problem: duplicates and lost context at the moment of submission. Web submit is a four-step wizard at `/submit`.

```mermaid
flowchart LR
  A[Describe<br/>nothing suggested while typing] --> B[Check<br/>preview_signal runs once]
  B --> C{Up to 3 matches<br/>first one read side by side}
  C -->|this is mine| D[Add my voice]
  C -->|none of these| E[New need<br/>signal + draft need]
  C -->|two asks found| F[Offer to split]
  F --> D
  F --> E
  D --> G[Details<br/>contact, how it affects me,<br/>which My signals link it joins]
  E --> G
  G --> H[Done<br/>private link, reused if they hold one]
  B -. AI down .-> E
```

## 2. Discover and support · 3. Track my signals

```mermaid
flowchart LR
  subgraph Public board
    Q[Search + quiet status filter] --> L[Ruled list<br/>statement, status, demand band]
    L --> ND[Need page<br/>solutions, approved summary, decision note]
    ND --> SUB[Add my voice → submit wizard]
  end
  subgraph Private link
    TOK[My signals link] --> MS[Every signal filed under it<br/>status changes, decision notes]
  end
```

Public views never show who asked, emails, companies, revenue, verbatim signals, or unapproved summaries.

## 4. PM triage (`/operator/triage`)

```mermaid
flowchart LR
  SIG[New signal lands] --> GEN[AI drafts suggestions in pencil<br/>draft need · merge · theme · public summary · split · priority]
  GEN --> Q[Triage queue, live count<br/>J/K to move, A/E/R to act]
  Q --> R{PM resolves}
  R -->|accept| AP[Applied as proposed]
  R -->|edit| ED[Applied with PM edit]
  R -->|reject + reason| RJ[Nothing applied]
  AP --> EV[(suggestion.accepted / edited / rejected)]
  ED --> EV
  RJ --> EV
  AP -. wrong merge .-> UN[undo merge]
```

## 5. PM decide and communicate (`/operator/needs`, `/operator/decide`)

```mermaid
flowchart LR
  RDY[Need crosses readiness line<br/>need.ready] --> AB[Brief drafted automatically<br/>recommended status, confidence, strategy fit]
  NE[Needs table<br/>people, accounts, ARR, score] --> ND[Need detail]
  AB --> ND
  ND --> PR[Priority panel<br/>AI scores per criterion, PM override with note]
  ND --> REV{PM reviews brief<br/>pencil until accepted or edited}
  REV --> NOTE[Public note<br/>check_public_text flags names, accounts, emails]
  NOTE --> PUB[Publish decision]
  PUB --> SUP[Supporters see it<br/>public need page, My signals, MCP]
```

## 6. Agents as first-class users

```mermaid
flowchart TB
  subgraph Public[Public MCP / Assistant agent]
    A1[search_needs, get_need] --> A2[preview_signal]
    A2 -->|match| A3[submit_signal target needId<br/>adds a voice to an existing need]
    A2 -->|none of these| A6[submit_signal target newNeed<br/>opens a new request as a draft need]
    A3 --> A5
    A6 --> A5[trackingUrl back to the submitter only<br/>reuse a token only if they gave it]
    A4[get_my_signals]
  end
  subgraph Op[Operator MCP / Operator agent · needs OPERATOR_SECRET]
    B1[list_operator_needs, list_ready_needs,<br/>get_demand_summary, get_metrics] --> B2[draft_decision_brief]
    B2 --> B3[resolve · merge · split · criteria · strategy · publish<br/>Operator agent asks PM approval per write]
  end
  subgraph CH[Console chat · /operator/chat]
    C1[Answers questions from 8 read-only ops<br/>links needs, never changes anything]
  end
```

## 7. PM strategy and criteria (`/operator/criteria`)

```mermaid
flowchart LR
  W[Weights<br/>demand · value · fit · effort, sum 1.00] --> RK[Preview re-ranks needs]
  STR[Strategy<br/>focus themes, revenue focus, capacity] --> V[New version, append-only]
  V --> RC[Readiness rechecked on every live need]
  V --> BR[Later briefs and scores judged against it]
```

## Metrics each journey feeds

```mermaid
flowchart LR
  J1[Submit] -->|signal.created attached_to| M1[Prevention rate ≥ 50%<br/>the one that matters]
  J4[Triage] -->|need.merged| M1
  J4 -->|suggestion.*| M3[Suggestion acceptance ≥ 70%]
  J5[Decide] -->|need.created → decision.published| M2[Decision latency: halve baseline]
  J5 -->|brief recommendedStatus vs published| DX[Direction accuracy ≥ 80%, proposed]
  M1 -. guarded by .-> G[False-match ≤ 5% · unmerge < 5% · no PII public<br/>≤ 2 s p95 · ≤ $0.01 per signal · ≤ $0.25 per brief]
```

Last live measurements (2026-10-30): p95 4.7 s and $0.014 per signal, both over their guardrails.
