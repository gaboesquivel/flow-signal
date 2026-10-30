# Design round 3 — PM console prototypes

Direction chosen: **Compare** (`../round-2/3-compare.html`) — minimal Ledger: warm paper, indigo, hairline rules, serif statements, Inter UI, mono numbers, AI in pencil until a person confirms it (then ink), one ruled list where one row expands inline, side-by-side reading when comparing two things. Copy its tokens, fonts, mark, shell (top bar: mark, Triage n · Needs · Criteria · Metrics · Chat, "Operator" at right) and components exactly; no new visual vocabulary unless a flow needs it.

Principles: minimalist, helps the PM get things done, one primary action per screen, no boxed cards, few pills. "AI proposes, people decide": nothing changes until the PM accepts; every AI output is pencil until then.

## Content: real seed data only

Use the seeded workspace, not invented content: `lib/signal/seed/demo-data.ts` and `lib/signal/seed/demo-workspace.ts` (accounts, themes, needs, verbatim asks, use cases, scores, decisions, merges). Where a flow needs something the seed lacks (e.g. Dana's new signal from Acme: title "Monthly PDF of the revenue dashboard", body "Our CFO wants a PDF of the revenue dashboard every month for the board pack. Today I screenshot six charts and paste them into slides."), keep it consistent across all files.

Operation shapes to respect (read the files): `lib/signal/operations/list-suggestions.ts`, `resolve-suggestion.ts`, `merge-needs.ts`, `undo-merge.ts`, `split-need.ts`, `get-need-detail.ts`, `get-criteria.ts`, `set-criteria.ts`, `draft-decision-brief.ts`, `publish-decision.ts`, `get-metrics.ts`, `get-demand-summary.ts`. Do not design actions the operations don't support; if a flow obviously needs one, show it and mark it "not in API" in the header's notes.

Visibility (PRODUCT.md): PMs see every signal verbatim, people, accounts, plans, ARR, open deals, full score breakdown. The public sees statement, status, decision note, proposed solutions, people count, demand band, PM-approved anonymized summary.

## Prototype format

Each file is a **clickable prototype**: one self-contained HTML page, desktop 1280 frame, that walks a flow with real state changes in plain JS (click Accept → item resolves, Undo appears; click Generate brief → pencil draft appears; etc.). Above the frame: a short header (flow name, steps, notes/risks) and a step strip that jumps to each state. Also render a static **dark** frame of the flow's key screen and a **phone (390)** frame of the key screen. Self-contained; Google Fonts only; inline SVG icons (Lucide style).

## Flows

- **4a Triage** (`4a-triage.html`): review the queue — accept a merge (signals move, "Undo merge" available for the session and on the need), edit-then-accept a draft need statement, accept a split, approve a public summary (with the PII check line), reject a theme with an optional reason. Queue empties to a calm "All caught up" state.
- **4b Need → decide → publish** (`4b-decide.html`): open a need from the Needs board → need detail (statement, proposed solutions, every signal verbatim with person, account, plan, ARR, use case, urgency; merge history with Undo) → priority breakdown (AI score per criterion with reasons, PM overrides one with a note) → Draft decision brief (AI, pencil: summary of demand, who's blocked, options, recommendation) → PM edits → choose status (Planned / In progress / Shipped / Declined) and the public note → Publish → confirmation showing what supporters see on their My signals page.
- **4c Board, criteria, metrics, chat** (`4c-overview.html`): Needs board (ruled table sorted by priority; filter by theme/status; pending-suggestion marker) → Criteria (four weights, AI explains impact on ranking, Save) → Metrics (prevention rate, decision latency, suggestion acceptance with edited/rejected split, guardrails: unmerge rate, false matches; human vs agent separated) → Chat (Operator asks "What are enterprise accounts blocked on?"; answer cites needs and accounts via `get_demand_summary`, quiet, no chat-bubble bloat).
