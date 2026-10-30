# Signal

## Definition

Signal is an AI-first feature intelligence system. It turns unstructured feature requests into clear, actionable product decisions: it prevents duplicates at the moment of submission without losing the customer's context, and it moves product managers from organizing feedback to reviewing and deciding.

This document describes **this product only**. It is not Flow's methodology identity from flow-skills.

## Problem

Product teams receive feature requests from customers, prospects, support teams, and internal stakeholders. As volume grows, the same need arrives many times in different words, and the context that makes a request useful (who asked, why, how much it matters) is scattered or lost. PMs spend hours merging, tagging, and summarizing by hand; popular requests drown out strategically valuable ones; decisions are slow and inconsistent; and requesters rarely hear back.

**Prioritized problem:** duplicates are created, and context is lost, at the moment of submission. Fixing it there means every later step (grouping, prioritizing, deciding, communicating) works from consolidated, context-rich demand instead of a pile of near-copies.

## Who

- **Submitters (primary):** customers, prospects, and support or sales staff filing on a customer's behalf. They want to be heard and to see what happens. No sign-in: they identify by email (and company).
- **Product managers (primary):** triage, group, prioritize, decide, and communicate decisions, in the protected Operator console. They also generate reports on demand: they describe a report in plain words, refine it, save it, and share it. They can also run the console through the Operator assistant: ask for data and get charts and tables, and have it propose actions they confirm before anything changes (experimental).
- **Agent users (first-class, alongside humans):** AI assistants and agents use the same workflow over MCP: search needs, submit through the same duplicate check, add support with context on a customer's behalf (public MCP); review suggestions, get demand summaries and decision briefs, publish decisions, and generate or re-run saved reports (Operator MCP).
- **Stakeholders:** leadership and go-to-market teams consume decision briefs, status, and shared PM reports (read-only link; no sign-in).

## Product model

```
Theme   — PM-defined area (e.g. "Reporting")
  └─ Need   — the underlying problem; AI-drafted, PM-edited; what people support and PMs decide on
       ├─ Proposed solutions — extracted by AI from signals ("PDF export", "scheduled digest")
       └─ Signal × N — one person's submission, kept verbatim (their words, email, account, urgency, date)
Strategy — PM-written focus themes, revenue focus, and capacity per quarter; priority scores and decision briefs read it
```

- **Add my voice** creates a signal on an existing need. **Submit new** creates a signal and a draft need awaiting PM approval; draft needs appear publicly marked "new".
- A **merge** moves all of one need's signals onto another need; nothing is lost and merges can be undone.
- Matching is on the **problem, not the named solution**: "PDF export to share with execs" and "PDF export for compliance archiving" are two needs sharing a proposed solution.
- Needs are written as "_who_ needs to _do what_ so that _outcome_"; anything broader is a theme. PM edits are final.
- A submission containing two asks is flagged at submission with an offer to split; otherwise it attaches to the primary need and a PM can split it later.

## Why AI, and how it changes the workflow

Recognizing that differently worded requests describe the same underlying need is a judgment about meaning that keyword search misses and humans do slowly. AI moves that work to where it is cheapest and most valuable:

- **Today:** submit → pile up → PM reads everything later → merges by hand → context lost.
- **With Signal:** as a request is submitted, AI states the underlying need, finds matching needs and explains why; the submitter adds their voice with their context, or files something genuinely new. Behind that, AI proposes merges and themes, scores priority against the team's criteria, flags needs ready for a decision with a recommended direction against the PM's strategy, and drafts decision briefs and stakeholder updates.

The PM's job shifts from **organizing** feedback to **reviewing and deciding**.

## Where human judgment stays

AI proposes; people decide.

- Submitters choose whether to support an existing need or submit a new one. Nothing is auto-merged against their will.
- PMs approve every draft need, merge, theme, and public use-case summary, and can undo merges.
- PMs own the priority criteria and weights. AI scores each criterion with reasons; PMs can override any score.
- PMs make and publish every decision. AI drafts the brief and the update.
- The Operator assistant only proposes write actions. Each one shows a preview of its effect, computed on the server, which the PM can edit or reject; it runs only after the PM confirms, and once. Text from tools or customers never triggers an action.

## Prioritization

Default criteria, with PM-editable weights; AI scores each with reasons, PMs override:

- **Demand:** supporters, weighted by account.
- **Business value:** revenue of requesting accounts and deals in progress.
- **Strategic fit:** match to PM-set themes.
- **Effort:** rough PM estimate, or AI-suggested and PM-approved.

## Visibility

| Data                                  | Public (board, public MCP)               | PM (Operator, Operator MCP) |
| ------------------------------------- | ---------------------------------------- | --------------------------- |
| Need statement, status, decision note | Yes                                      | Yes                         |
| Proposed solutions                    | Yes                                      | Yes                         |
| Supporters                            | People count only                        | People, accounts, revenue   |
| Use cases                             | Anonymized AI summary, after PM approval | Every signal, verbatim      |
| Submitter name, email, company        | No                                       | Yes                         |
| Priority                              | Demand band only (high / medium / low)   | Full score breakdown        |

Submitters track their own signals through a private, unguessable "My signals" link shown after submission (no email is sent); status changes and decision notes appear there and over MCP. The link carries forward: a submitter who already holds one files new signals onto it, so their signals collect on one page; links are never grouped by email ([0005](./docs/decisions/0005-my-signals-link-carries-forward.md)).

## Why now

Language models make meaning-based matching, summarization, and reasoning cheap enough to run on every submission, and MCP lets agents act as real users of the same workflow.

## Metrics

Metrics come in three tiers: the three MVP metrics below (prevention rate is the one that matters), guardrails, and diagnostics. All are collected by Signal's own event log, which the MVP adds; baselines are unknown, and targets are hypotheses.

### 1. Prevention rate (one metric that matters)

Duplicates stopped at the source, with the customer's words kept.

- **Counts:** signals attached to an existing need at submission ÷ (those + signals whose draft need was later merged into an existing need).
- **Population:** all signals, human and agent, reported separately. **Window:** weekly.
- **Source:** `signal.created` (`attached_to: existing | draft`) and `need.merged`.
- **Baseline:** unknown; a plain vote board is the comparison. **Target:** ≥ 50% (hypothesis, low confidence).

### 2. Decision latency

Product decisions get made faster.

- **Counts:** median days from a need's first signal to its published decision (planned, in progress, shipped, or declined); needs open past 30 days are reported separately.
- **Source:** `need.created` → `decision.published`.
- **Baseline:** unknown; in the demo it comes from seeded history. **Target:** halve the baseline (hypothesis).

### 3. AI suggestion acceptance

PMs trust the AI enough that their work shifts from organizing to deciding.

- **Counts:** share of AI proposals (need statements, merges, splits, themes, priority scores, public summaries, decision briefs) a PM accepts as-is; edited and rejected are counted separately, by suggestion type.
- **Source:** `suggestion.accepted | edited | rejected`.
- **Target:** ≥ 70% accepted as-is (hypothesis). High acceptance with a rising unmerge rate means rubber-stamping.

### Guardrails

Decision-model spend under $0.25 per brief (hypothesis); unmerge rate < 5%; zero identifying details in public summaries; suggestions within 2 s at p95; under $0.01 of model spend per signal. Over-eager matching would inflate prevention rate; false-match and unmerge rates hold it in check. Live, taken matches that a PM later splits off their need stand in for the false-match rate ([spec 012](./docs/specs/012-match-exposure.md)). Last live measurements (2026-10-30): p95 4.7 s and $0.014 per signal, both over.

### Diagnostics

- **Supporting:** context rate (signals with the submitter's own use-case text, ≥ 70%), time to triage, review load, close-the-loop rate (signals whose submitter saw a decision on their My signals link ÷ signals on needs with that decision; source: `signal.decision_seen`, recorded when `get_my_signals` returns a decision published after the signal, plus `decision.published`; baseline unknown), match take-up: submissions shown a match that joined a shown need, the direct read on riskiest assumption 1 ([spec 012](./docs/specs/012-match-exposure.md)), and skip rate: submissions sent without a preview, which only the post-submission duplicate backstop can catch ([spec 009](./docs/specs/009-duplicate-backstop.md)).
- **AI quality (offline eval set, `pnpm eval:matching`):** match precision@3 ≥ 90%, false-match rate ≤ 5%, new-need recall ≥ 90%, need-statement rubric ≥ 4/5.
- **Simulated outcomes (Crewday worlds, [spec 004](./docs/specs/004-crewday-outcome-eval.md)):** true prevention rate (includes duplicates nobody merged), decision quality against the strategy memo, ARR-weighted revenue coverage, and acceptance precision (accepted suggestions that ground truth says are correct), each measured against a plain vote board with confidence intervals (`pnpm eval:crewday`, on demand). Decision quality is a non-inferiority check: both arms publish through the same noisy PM, so it mostly measures that noise. The simulation takes submitter behaviour as an input, so it cannot test riskiest assumption 1.
- **Direction accuracy:** decision briefs whose recommended status matches the published decision ÷ published decisions that had a brief; weekly; source: the `decision_brief` payload + `decision.published`. On Crewday it is also scored against the strategy-implied decision. Baseline unknown; target ≥ 80% (hypothesis, low confidence).
- **Readiness lead time:** median days from `need.ready` (a new event) to `decision.published`. Baseline unknown.
- **Report reuse:** saved reports re-opened, re-run, or shared within 14 days ÷ reports saved; PMs and agents counted separately; weekly. Source: `report.saved | report.viewed | report.shared` events. Baseline unknown; target ≥ 40% (hypothesis, low confidence). Guardrail: zero report figures that don't trace to a record.
- **Assistant action share (experimental):** PM write actions done through the Operator assistant ÷ all PM write actions; weekly; also the share of proposed actions confirmed unchanged, edited, or rejected. Source: `client: console:assistant` on write events plus `assistant.action_proposed | confirmed | rejected` events. Baseline unknown; measure first, no target yet. Guardrail: zero writes without a confirmed preview.

## Riskiest assumptions

1. Submitters will add their voice to an existing need rather than file their own version, as long as their context is kept and visible. _Confidence: medium._ The main bet.
2. Matching is accurate enough to trust; wrong matches feel dismissive. _Confidence: medium._
3. PMs will trust and act on AI-proposed merges, scores, and briefs instead of redoing the work. _Confidence: low to medium._
4. A duplicate check on every submission is fast and cheap enough (under 2 s, under $0.01). _Confidence: medium:_ the last live runs measured p95 4.7 s and $0.014 per signal ([spec 010](./docs/specs/010-retro-remediation.md)).
5. A recommended direction grounded in a written strategy is right often enough that PMs follow it instead of redoing the analysis. _Confidence: low._
6. A fixed set of read-only data tools covers most report requests PMs actually ask, so "any report" holds up without free-form SQL. _Confidence: low to medium._
7. PMs will trust confirmed chat actions enough to use them instead of the dashboard pages, and the previews catch wrong actions before they run. _Confidence: low._

## Kill criterion

- **MVP (build exercise):** the offline eval set misses its thresholds (precision@3 < 90% or false-match rate > 5%) after tuning; then submission-time matching is not trustworthy and the bet is rethought.
- **Simulated (before a pilot):** on the held-out Crewday world at default behaviour, Signal does not beat a plain vote board on true prevention rate by 20 points after tuning ([spec 004](./docs/specs/004-crewday-outcome-eval.md)).
- **With real users:** over at least 200 submissions where Signal showed a match, prevention rate stays under 30% or unmerge rate exceeds 10%. "Showed a match" comes from the exposure recorded on each signal, and `get_metrics` reports the count and verdict ([spec 012](./docs/specs/012-match-exposure.md)).

## Core journeys

1. **Submit with a duplicate check:** a person or agent describes a need; Signal shows likely matching needs with reasons; they add their voice with context, or submit a new signal and draft need.
2. **Discover and support:** browse or search needs by theme and status; see how they are grouped and their demand band.
3. **Track my signals:** follow status changes and decision notes through the private "My signals" link or MCP.
4. **PM triage:** review AI-proposed draft needs, merges, themes, and public summaries; accept, edit, or reject; undo merges.
5. **PM decide and communicate:** Signal flags needs ready to decide with a recommended direction and brief; the PM reviews it against the strategy, publishes a decision; supporters see the update.
6. **Agent:** over MCP, search, submit, and add support with context; with PM access, review suggestions and get demand summaries and decision briefs.
7. **PM strategy:** write and update the strategy that scores and recommendations are judged against.
8. **PM reports:** a PM describes any report in plain words (e.g. "ARR-weighted demand by theme this quarter", "decision latency trend", "top unmet needs for enterprise accounts"); Signal composes it from Signal's own data with charts and tables, and every figure traces to real records. The model never invents data. The PM refines, saves, re-runs it on fresh data, and shares a read-only link.
9. **PM operator assistant (experimental):** in Chat, a PM asks for data and gets an answer with KPIs, charts, and tables from report datasets plus linked needs; asks for a change ("merge these two", "publish planned on X"); reviews a preview card (needs affected, signals moved, the note after the identifying-text check), edits or confirms; the action runs once and the answer shows the result.

## Alternatives

- **Status quo:** a spreadsheet, a Slack channel, and Jira tickets.
- **Feedback tools:** Canny (AI duplicate detection), Productboard (AI insights), UserVoice, Jira Product Discovery.

Signal's angle: prevention at submission that keeps every customer's own words, matching on the underlying problem rather than the requested solution, agents as first-class users, and the PM decision loop built in. Competitors already ship AI duplicate detection, so that alone is not the differentiator.

## Out of scope (MVP)

- Ingestion from Intercom, Zendesk, Slack, or email.
- CRM revenue data (account context is seeded or entered by hand).
- Roadmap or Jira sync.
- Multiple customer organizations, SSO, submitter sign-in, granular permissions.
- Email or Slack notifications (updates appear in the app and over MCP only).

## Pre-mortem

Six months from now it failed because:

- Wrong matches made customers feel brushed off, and they stopped using the board.
- PMs did not trust the scores and returned to spreadsheets; the AI became decoration.
- The pilot had too few submissions to show anything.
- Competitors' AI duplicate detection was good enough, and kept context was not visible enough to switch for.

## Technical baseline

- Package / Portless slug: `signal`
- Local dev host: `signal.localhost`
- Template: `flow-next` at `4dcbf0f`
- Database: Neon Postgres with pgvector; `main` and `test` branches ([docs/database.md](./docs/database.md))
- Agent- and API-first: every capability is one operation in a registry, exposed as REST, MCP, and agent tools, built test-first; the UI comes last ([spec 001](./docs/specs/001-signal-mvp.md))
