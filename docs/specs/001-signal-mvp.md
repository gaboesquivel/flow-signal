# 001 — Signal MVP: prevent duplicates at submission and close the decision loop

Status: draft (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md). Glossary: [GLOSSARY.md](../../GLOSSARY.md).
Decisions: [0001 Neon Postgres with pgvector](../decisions/0001-neon-postgres-pgvector.md) (Proposed), [0002 Retrieve-then-judge matching, workflow on the hot path](../decisions/0002-retrieve-then-judge-matching.md) (Proposed).

**Bet.** Submitters will add their voice to an existing need instead of filing their own version when the match is accurate and their own words are kept (riskiest assumption 1), and matching is accurate enough to trust (assumption 2). The MVP proves the second with a labeled eval set and makes the first and the PM loop measurable with an event log behind the three MVP metrics.

## Problem Statement

A customer who wants something files it in their own words, unaware that ten others asked for the same thing differently. The PM later reads every copy, merges by hand, and loses who asked and why. Priorities are argued from vote counts, decisions take weeks, and the people who asked never hear back. Agents (support copilots, PM assistants) have no way to take part in that workflow at all.

## Solution

- **Submit with a duplicate check.** While a person or agent describes a need, Signal drafts the underlying need, finds matching needs, and explains each match. They add their voice to an existing need with their own context, or submit a new signal that creates a draft need. A submission with two asks is flagged with an offer to split.
- **Board.** Anyone can browse and search needs by theme and status, see proposed solutions, supporter counts, an approved anonymized use-case summary, demand band, and the decision note.
- **My signals.** After submitting, the submitter gets a private, unguessable link that shows their signals, status changes, and decision notes.
- **PM triage (Operator).** A queue of AI suggestions (draft needs, merges, themes, priority scores, public summaries, splits) to accept, edit, or reject; merges can be undone.
- **PM decide and communicate.** Priority scores against editable criteria with reasons, an AI-drafted decision brief, and publishing a decision with a note supporters see.
- **Agents.** The same capabilities over MCP: public tools for submitters, protected tools for PMs.
- **Metrics.** An append-only event log; the Operator shows prevention rate, decision latency, and suggestion acceptance, split human vs. agent.
- **Seed and eval.** A realistic seeded workspace for the demo, and a labeled eval set that gates matching quality in `pnpm eval`.

## User Stories

1. As a customer, I want to see existing needs that match what I am typing, with why they match, so that I can add my voice instead of filing a duplicate.
   - Suggestions appear within 2 s at p95 after I pause typing (debounced preview).
   - Each match shows the need statement, status, supporter count, and a one-line reason.
   - Choosing a match keeps my title, description, use case, and urgency verbatim as my signal.
2. As a customer whose need is genuinely new, I want to submit it without fighting the system, so that I am not forced onto the wrong need.
   - "None of these" is always one click; my signal creates a draft need shown publicly as "new".
3. As a customer who wrote two asks in one submission, I want Signal to offer to split them, so that each is counted where it belongs.
4. As a customer, I want a private link to my signals, so that I see status changes and decision notes without an account.
5. As a visitor, I want to search and browse needs by theme and status, so that I understand what is being asked, how it is grouped, and how it is prioritized.
   - I never see submitter names, emails, companies, revenue, or verbatim text from other customers.
6. As a PM, I want a triage queue of AI suggestions with their reasons, so that I review and decide instead of organizing.
   - I can accept, edit, or reject each; edits are recorded as edits.
   - I can merge two needs and undo a merge; no signal is ever deleted.
   - I can split signals out of a need into a new need.
   - A public use-case summary is never public until I approve it.
7. As a PM, I want priority scores per criterion with reasons and editable weights, so that prioritization is consistent and explainable; I can override any score.
8. As a PM, I want an AI-drafted decision brief for a need, so that I can decide and publish a decision with a note quickly.
9. As a PM, I want the three MVP metrics with human vs. agent split, so that I can see whether Signal works.
10. As an agent acting for a customer, I want to preview matches, submit a signal, and add support with context over MCP, so that I file requests the same way a person does.
11. As an agent acting for a PM, I want to list and resolve suggestions, get a demand summary, draft a decision brief, publish a decision, and read metrics over the protected MCP.
12. Failure: when AI is unavailable, submission still works without suggestions and says so; when the database is unavailable, signal endpoints fail with `database_unavailable` and nothing is half-written.

## Implementation Decisions

### Architecture and AI choices

Recorded as [0002](../decisions/0002-retrieve-then-judge-matching.md); summary:

- **Hot path is a deterministic workflow, not an agent loop.** Preview runs three bounded steps: (1) **extract**: a fast model returns the draft need statement ("who needs to do what so that outcome"), a proposed solution if one is named, and any additional asks; (2) **retrieve**: embed the draft need statement and take the top 8 approved or draft needs by cosine similarity (pgvector); (3) **judge**: a fast model scores each candidate with a probability that it is the same underlying need and a one-line reason; matches above a tuned threshold (start 0.6) are returned, at most 3. Bounded steps keep latency and cost predictable and make the step evaluable.
- **Models** via the existing Vercel AI Gateway seam (`lib/ai/models.ts`), each overridable by env and checked by `models.test.ts`:
  - Extract and judge: `anthropic/claude-haiku-5.5` (`SIGNAL_FAST_MODEL`), AI SDK structured output with zod schemas.
  - Priority scoring, theme suggestion, public summaries, decision briefs, demand summaries: `anthropic/claude-sonnet-5.5` (`SIGNAL_REASONING_MODEL`); these run off the hot path.
  - Embeddings: a Gateway embedding model (`SIGNAL_EMBEDDING_MODEL`, default `openai/text-embedding-3-small`, 1536 dimensions). _Assumption: confirm the id against the Gateway model list in the first task._
- **Off-hot-path work** (re-embedding, priority rescoring, theme and summary suggestions after a signal lands) runs with Next.js `after()` so the submit response is not delayed; results land as suggestions.
- **Agents.** The existing Eve **Operator** agent gets Signal tools for open-ended PM questions ("what are enterprise accounts blocked on?"); the Eve **Assistant** agent gets the public tools. Agents call the same domain functions as the UI and MCP; they do not reimplement logic.
- **Human judgment is enforced in the domain layer, not the UI:** nothing auto-merges, approves, publishes a summary, or publishes a decision without a PM action. AI output is always a `suggestion` row until resolved.

### Domain module and ports

`lib/signal/` holds the domain: pure functions over a repository and AI ports, injected like `pingDatabase`'s `query` parameter so tests run without network.

- `SignalRepository` (Drizzle on Neon in production, PGlite with the `vector` extension in tests).
- `NeedExtractor`, `NeedRetriever`, `MatchJudge`, `Reasoner` (scores, summaries, briefs), `Embedder` — AI SDK implementations plus test fakes.
- `recordEvent` writes every metric-relevant event in the same transaction as the change it describes.

### Schema (Drizzle, `lib/db/schema.ts`)

- `accounts` (id, name, plan, arr_cents, open_deal_cents) — seeded.
- `submitters` (id, email unique, name, account_id nullable).
- `themes` (id, name, description, strategic_weight 0–1).
- `needs` (id, statement, status `draft | open | planned | in_progress | shipped | declined | merged`, merged_into_id, theme_id, public_summary, public_summary_status `none | pending | approved`, embedding vector(1536), created_at, approved_at).
- `proposed_solutions` (id, need_id, text, source_signal_id).
- `signals` (id, need_id, original_need_id, submitter_id, title, body, use_case, urgency `low | medium | high`, channel `web | mcp`, actor_kind `human | agent`, agent_client, attached_to `existing | draft`, tracking_token unique, idempotency_key unique, created_at).
- `merges` (id, from_need_id, into_need_id, moved_signal_ids, created_at, undone_at).
- `priority_criteria` (key `demand | business_value | strategic_fit | effort`, weight) and `priority_scores` (need_id, criterion, score 0–5, reason, source `ai | pm`, updated_at).
- `suggestions` (id, kind `draft_need | merge | theme | priority | public_summary | split | decision_brief`, subject ids, payload jsonb, status `pending | accepted | edited | rejected`, model, created_at, resolved_at, resolved_by_kind `human | agent`).
- `decisions` (id, need_id, status, note, brief_markdown, published_at, published_by_kind).
- `events` (id, type, occurred_at, actor_kind, actor_ref, need_id, signal_id, suggestion_id, payload jsonb, dedupe_key unique) — append-only.

### Typed API contract (before any UI)

Route handlers validate with zod and share types with the UI. Every error is `{ error: { code, message, retryable } }` with codes `validation_failed`, `not_found`, `conflict`, `rate_limited`, `ai_unavailable`, `database_unavailable`, `unauthorized`.

Public (no auth, rate limited per IP, body limits):

| Method and path              | Input                                                                                                                                       | Output                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/signals/preview`  | `{ title, body }`                                                                                                                           | `{ previewId, draftNeed: { statement, proposedSolution?, additionalAsks: string[] }, matches: [{ needId, statement, status, supporterCount, demandBand, probability, reason }], ai: "ok" \| "unavailable" }` |
| `POST /api/signals`          | `{ title, body, useCase?, urgency?, email, name?, company?, target: { needId } \| { newNeed: { statement } }, previewId?, idempotencyKey }` | `{ signalId, needId, attachedTo, trackingUrl }`                                                                                                                                                              |
| `GET /api/needs`             | `?q&theme&status&cursor`                                                                                                                    | public need list                                                                                                                                                                                             |
| `GET /api/needs/:id`         | —                                                                                                                                           | public need view (no PII, approved summary only)                                                                                                                                                             |
| `GET /api/my-signals/:token` | —                                                                                                                                           | the token holder's signals with need status and decision notes                                                                                                                                               |

Operator (`verifyOperatorRequest`; fail closed when `OPERATOR_SECRET` is unset):

| Method and path                               | Purpose                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/operator/suggestions?kind&status`   | triage queue                                                  |
| `POST /api/operator/suggestions/:id/resolve`  | `{ action: accept \| edit \| reject, edit? }`                 |
| `POST /api/operator/needs/:id/merge`          | `{ intoNeedId }`; `conflict` if either need is already merged |
| `POST /api/operator/merges/:id/undo`          | restores signals to the original need                         |
| `POST /api/operator/needs/:id/split`          | `{ signalIds, statement }`                                    |
| `GET /api/operator/needs/:id`                 | full need: verbatim signals, accounts, scores, suggestions    |
| `PUT /api/operator/criteria`                  | `{ weights }`                                                 |
| `POST /api/operator/needs/:id/decision-brief` | creates a `decision_brief` suggestion                         |
| `POST /api/operator/needs/:id/decision`       | `{ status, note }` publishes a decision                       |
| `GET /api/operator/metrics?from&to`           | the three metrics and supporting counts, human vs. agent      |

### MCP tools

Public `/api/mcp` (same domain functions; actor_kind `agent`, `agent_client` from MCP client info):

- `search_needs`, `get_need`, `preview_signal`, `submit_signal` (requires `idempotencyKey`), `get_my_signals`.

Operator `/api/mcp/operator`:

- `list_suggestions`, `resolve_suggestion`, `merge_needs`, `undo_merge`, `get_need_detail`, `get_demand_summary`, `draft_decision_brief`, `publish_decision`, `get_metrics`.

Public discovery (OpenAPI, `.well-known`, server card) lists public tools only, as today. No MCP App: plain tools cover the agent journeys.

### Metrics instrumentation

Definitions are in [PRODUCT.md → Metrics](../../PRODUCT.md#metrics); calculations live in `lib/signal/metrics.ts` as SQL over `events`.

- **Prevention rate:** numerator `signal.created` with `attached_to = existing`; denominator adds `signal.created` with `attached_to = draft` whose need has a `need.merged` event not followed by `merge.undone`. Weekly, human and agent reported separately.
- **Decision latency:** median of `decision.published.occurred_at − need.created.occurred_at` for the first published decision per need; needs open past 30 days reported separately.
- **Suggestion acceptance:** `suggestion.accepted ÷ (accepted + edited + rejected)`, per kind.
- **Counting rules:** events write in the same transaction as the change; `dedupe_key` (from `idempotencyKey`) makes retries count once; failed or rejected requests write no event.

### Seed and eval

- `pnpm db:seed`: 8 accounts, 4 themes, ~25 needs, ~150 signals over 90 days of history (including decisions, merges, and suggestions) so all journeys and metrics have data. Uses `@faker-js/faker` with a fixed seed plus hand-written realistic needs.
- `evals/matching/`: a labeled set of at least 120 submissions against a fixture need catalog, including paraphrases, same-solution-different-need, multi-ask, and unrelated cases. The runner reports precision@3, false-match rate, new-need recall, and a need-statement rubric (model grader, spot-checked). Thresholds from PRODUCT.md; joins `pnpm eval`; skips with a clear message without Gateway access.

### Exposure

- Runs on the existing Vercel deployment (public, `flow-signal-eta.vercel.app`) and locally at `signal.localhost`.
- **Public writes are open by design** (no submitter auth in the MVP): `POST /api/signals*` and the public MCP write tool are rate limited per IP, size limited, and never return other customers' PII. Submitter emails are stored and shown only to PMs.
- **PM writes fail closed:** every Operator route and Operator MCP tool returns `unauthorized` unless `OPERATOR_SECRET` is configured and presented.
- **Without `DATABASE_URL`** every signal endpoint returns `database_unavailable` (503); the board shows an explanatory empty state. **Without AI Gateway access** preview returns `ai: "unavailable"` with no matches and submission still works.
- **Database provisioning requires the user's explicit yes** before running setup with the `neon` preset ([0001](../decisions/0001-neon-postgres-pgvector.md)).

### UI

Replaces the template's home stub. Public: `/` (board and search), `/submit` (form with debounced live preview), `/needs/[id]`, `/my/[token]`. Operator: `/operator/triage`, `/operator/needs/[id]`, `/operator/criteria`, `/operator/metrics`, and the existing Operator chat with Signal tools. Visual direction is open (`design` can run first).

## Testing Decisions

- **Domain tests** (`tests/signal/`): run `lib/signal` against PGlite with fake AI ports; cover matching thresholds, attach vs. draft, split, merge and undo, visibility filtering, suggestion resolution, decision publishing, and every metric calculation. Prior art: the injected `query` in `lib/db/ping.ts` and `tests/db-ping.test.ts`.
- **Contract tests**: route handlers (prior art `tests/genui-compose.route.test.ts`) and MCP tools (`tests/mcp/route.test.ts`, `tests/mcp/operator-isolation.test.ts`), including that public responses never contain email, company, revenue, or verbatim text of other submitters, and that Operator tools are absent from public discovery.
- **Eval**: `evals/matching` thresholds are the kill criterion for the MVP; failing them blocks calling the bet proven, not the build.
- **Model ids**: extend `lib/ai/models.test.ts` to the new ids.

**Acceptance scenario.**

Starting state: seeded workspace. Theme "Reporting" holds the open need N1 "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers" with 11 supporters, proposed solution "PDF export", status `open`. Separate need N2 "Compliance teams need to archive monthly reports so that audits have a fixed record" also lists "PDF export". `OPERATOR_SECRET` is set; AI Gateway is available.

Human journey:

1. Maya (maya@acme.example, Acme, Enterprise) opens `/submit` and types title "Export dashboards to PDF" and body "Our CEO wants the KPI dashboard in the board deck every month." → within 2 s the preview shows N1 first with a reason mentioning sharing with executives, and does not rank N2 first.
2. Maya picks N1, adds use case "monthly board deck" and urgency high, enters her email, and submits → response has `attachedTo: existing` and a `trackingUrl`; N1 shows 12 supporters on the board; the board shows no Acme or Maya details.
3. A retry of the same submit with the same `idempotencyKey` → returns the same `signalId`; N1 still shows 12; one `signal.created` event exists.
4. In `/operator/triage` the PM sees a pending `priority` suggestion for N1 (business value raised, reason cites Acme's ARR) and a pending `public_summary` update → the PM accepts the score and edits the summary → `suggestion.accepted` and `suggestion.edited` events recorded; the approved summary appears on N1 without Acme's name.
5. The PM requests a decision brief for N1 → a `decision_brief` suggestion with demand, accounts, value, and options appears; the PM accepts it and publishes decision `planned` with note "Targeting Q1" → N1 status is `planned`.
6. Maya opens her `trackingUrl` → she sees N1 as Planned with "Targeting Q1".
7. `/operator/metrics` for this week → prevention rate counts Maya's signal once in the numerator under human; decision latency includes N1 (first signal date to today); suggestion acceptance counts 2 accepted (score, brief) and 1 edited (summary); a submission that failed validation earlier in the week is not counted.

Agent journey (same starting state):

1. A support agent calls `preview_signal` on `/api/mcp` with the same text → N1 is the top match with a reason.
2. It calls `submit_signal` with `target.needId = N1`, Maya's email, and an `idempotencyKey` → returns `attachedTo: existing`; calling again with the same key returns the same `signalId`.
3. A PM agent calls `draft_decision_brief` then `publish_decision` on `/api/mcp/operator` with the bearer secret → N1 is `planned`; the same calls without the secret return `unauthorized`.
4. `get_metrics` → the agent signal is counted once under agent, not human; the decision is attributed `published_by_kind = agent`.

## Out of Scope

- Ingestion from Intercom, Zendesk, Slack, or email ([002 candidate](./002-feedback-ingestion.md)).
- Email or Slack notifications to supporters ([003 candidate](./003-stakeholder-notifications.md)); updates appear in the app and over MCP only.
- CRM revenue sync (accounts are seeded or edited by a PM).
- Submitter sign-in, SSO, multiple workspaces, granular roles.
- Roadmap or Jira sync; an MCP App UI.

## Further Notes

Where the assignment's required documentation lives:

| Required                                      | Location                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Business problem prioritized and why          | PRODUCT.md → Problem                                                               |
| Who benefits                                  | PRODUCT.md → Who                                                                   |
| Why AI is appropriate                         | PRODUCT.md → Why AI                                                                |
| How AI changes the workflow                   | PRODUCT.md → Why AI; this spec → Solution                                          |
| Agent, model, framework, architecture and why | This spec → Architecture and AI choices; decisions 0001, 0002                      |
| Where human judgment remains                  | PRODUCT.md → Where human judgment stays; enforced in the domain layer here         |
| Measuring business impact                     | PRODUCT.md → Metrics; this spec → Metrics instrumentation                          |
| Assumptions, risks, tradeoffs                 | PRODUCT.md → Riskiest assumptions, Pre-mortem; decisions 0001, 0002 → Consequences |

Open assumptions: the embedding model id and dimension; the 0.6 judge threshold (tuned on the eval set); PGlite's `vector` extension covering the queries used in production; Haiku latency meeting 2 s p95 for extract plus judge of 8 candidates.
