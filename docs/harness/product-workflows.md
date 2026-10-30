# Product workflows

Signal turns feature requests into decisions. AI proposes; people decide. Source: [PRODUCT.md](../../PRODUCT.md), [spec 001](../specs/001-signal-mvp.md), [spec 006](../specs/006-lean-ledger-ui.md).

## The model

```mermaid
flowchart TD
  T[Theme<br/>PM-defined area] --> N[Need<br/>who needs to do what so that outcome]
  N --> PS[Proposed solutions<br/>AI-extracted]
  N --> SG[Signal × N<br/>verbatim words, email, account, urgency]
  N -. merge, undoable .-> N2[Another need]
  N --> D[Decision<br/>planned · in progress · shipped · declined]
```

## Lifecycle of a request

```mermaid
stateDiagram-v2
  [*] --> Preview: person or agent describes a need
  Preview --> AttachExisting: picks a match (add my voice)
  Preview --> DraftNeed: none of these (submit new)
  DraftNeed --> Open: PM approves AI statement
  DraftNeed --> Merged: PM accepts merge suggestion
  Open --> Merged: PM merges duplicate
  Merged --> Open: undo merge
  AttachExisting --> Open
  Open --> Decided: PM publishes decision
  Decided --> [*]: supporters see it on My signals
```

## 1. Submit with a duplicate check (submitter)

The prioritized problem: duplicates and lost context at the moment of submission.

```mermaid
flowchart LR
  A[Describe the problem] --> B[Check: preview_signal]
  B --> C{Up to 3 matches<br/>with reasons}
  C -->|this is mine| D[Add my voice<br/>signal on existing need]
  C -->|none of these| E[Submit new<br/>signal + draft need]
  C -->|two asks found| F[Offer to split]
  F --> D
  F --> E
  D --> G[Details: email, company, how it affects me]
  E --> G
  G --> H[Done: private My signals link]
  B -. AI down .-> E
```

Spec 006 changes the UI to a wizard (Describe → Check → Details → Done) with no suggestions while typing, and makes the My signals link carry forward across submissions (decision 0005).

## 2. Discover and support · 3. Track my signals

```mermaid
flowchart LR
  subgraph Public board
    Q[Search / filter by theme, status] --> L[Ruled list<br/>statement, status, demand band]
    L --> ND[Need page<br/>solutions, approved summary, decision note]
    ND --> SUB[Add my voice → submit flow]
  end
  subgraph Private link
    TOK[/my/token/] --> MS[My signals<br/>status changes, decision notes]
  end
```

Public views never show who asked, emails, companies, revenue, verbatim signals, or unapproved summaries.

## 4. PM triage

```mermaid
flowchart LR
  SIG[New signal lands] --> GEN[AI drafts suggestions<br/>draft need · merge · theme · public summary · split · priority]
  GEN --> Q[Triage queue: list_suggestions]
  Q --> R{PM resolves}
  R -->|accept| AP[Applied as proposed]
  R -->|edit| ED[Applied with PM edit]
  R -->|reject| RJ[Nothing applied]
  AP --> EV[(suggestion.accepted / edited / rejected)]
  ED --> EV
  RJ --> EV
  AP -. wrong merge .-> UN[undo_merge]
```

## 5. PM decide and communicate

```mermaid
flowchart LR
  C[Criteria + weights<br/>demand · value · fit · effort] --> SC[AI scores each criterion<br/>with reasons; PM overrides]
  SC --> RANK[Priority = Σ score × weight]
  RANK --> DS[get_demand_summary<br/>numbers + AI narrative]
  DS --> BR[draft_decision_brief<br/>AI options + recommendation]
  BR --> REV{PM reviews brief}
  REV --> PUB[publish_decision<br/>status + note]
  PUB --> SUP[Every supporter sees it<br/>My signals, MCP]
```

## 6. Agents as first-class users

```mermaid
flowchart TB
  subgraph Public[Public MCP / Assistant agent]
    A1[search_needs, get_need] --> A2[preview_signal] --> A3[submit_signal<br/>on a customer's behalf]
    A4[get_my_signals]
  end
  subgraph Op[Operator MCP / Operator agent · needs OPERATOR_SECRET]
    B1[list_suggestions, get_need_detail,<br/>get_demand_summary, get_metrics] --> B2[draft_decision_brief]
    B2 --> B3[resolve · merge · split · set_criteria · publish<br/>Operator agent asks PM approval per write]
  end
```

## Metrics each journey feeds

```mermaid
flowchart LR
  J1[Submit] -->|signal.created attached_to| M1[Prevention rate ≥ 50%]
  J4[Triage] -->|need.merged| M1
  J4 -->|suggestion.*| M3[Suggestion acceptance ≥ 70%]
  J5[Decide] -->|need.created → decision.published| M2[Decision latency: halve baseline]
  M1 -. guarded by .-> G[False-match ≤ 5% · unmerge < 5%<br/>≤ 2 s p95 · ≤ $0.01 per signal]
```
