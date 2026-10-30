# 001 — Signal MVP: prevent duplicates at submission and close the decision loop

Status: accepted (2026-10-30). Amended by [006](./006-lean-ledger-ui.md) (web submit checks once in a wizard; tracking links carry forward; visual direction settled; task 08 replaced). Amended by [007](./007-decision-direction.md) (decision briefs run on the decision model, [0006](../decisions/0006-decision-model-fable-gateway-byok.md)).

Product brief: [PRODUCT.md](../../PRODUCT.md). Glossary: [GLOSSARY.md](../../GLOSSARY.md).
Decisions: [0001 Neon Postgres with pgvector](../decisions/0001-neon-postgres-pgvector.md) (Accepted), [0002 Retrieve-then-judge matching, workflow on the hot path](../decisions/0002-retrieve-then-judge-matching.md) (Accepted).

**Bet.** Submitters will add their voice to an existing need instead of filing their own version when the match is accurate and their own words are kept (riskiest assumption 1), and matching is accurate enough to trust (assumption 2). The MVP proves the second with a labeled eval set and makes the first and the PM loop measurable with an event log behind the three MVP metrics.

## Problem Statement

A customer who wants something files it in their own words, unaware that ten others asked for the same thing differently. The PM later reads every copy, merges by hand, and loses who asked and why. Priorities are argued from vote counts, decisions take weeks, and the people who asked never hear back. Agents (support copilots, PM assistants) have no way to take part in that workflow at all.

## Solution

- **Submit with a duplicate check.** While a person or agent describes a need, Signal drafts the underlying need, finds matching needs, and explains each match. They add their voice to an existing need with their own context, or submit a new signal that creates a draft need. A submission with two asks is flagged with an offer to split.
- **Board.** Anyone can browse and search needs by theme and status, see proposed solutions, supporter counts, an approved anonymized use-case summary, demand band, and the decision note.
- **My signals.** After submitting, the submitter gets a private, unguessable link that shows their signals, status changes, and decision notes.
- **PM triage (Operator).** A queue of AI suggestions (draft needs, merges, themes, priority scores, public summaries, splits) to accept, edit, or reject; merges can be undone.
- **PM decide and communicate.** Priority scores against editable criteria with reasons, an AI-drafted decision brief, and publishing a decision with a note supporters see.
- **Agent- and API-first.** Every capability is one operation, exposed as a REST route, an MCP tool (public `/api/mcp` or Operator `/api/mcp/operator`), and an Eve agent tool; the UI is built last on a typed client generated from the same operations.
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
10. As an agent acting for a customer, I want to search needs, preview matches, submit a signal or add support with context, and read a submitter's signals over the public MCP, so that I file requests the same way a person does.
11. As an agent acting for a PM, I want every Operator operation over the Operator MCP (triage suggestions, merge, undo, split, read and set criteria, get a demand summary, draft a decision brief, publish a decision, read metrics), so that I can do a PM's work under the same rules.
12. As a developer integrating Signal, I want the same operations as REST endpoints with the same inputs, outputs, and error codes as the MCP tools, so that every client behaves the same.
13. Failure: when AI is unavailable, submission still works without suggestions and says so; when the database is unavailable, signal endpoints fail with `database_unavailable` and nothing is half-written.

## Implementation Decisions

### Architecture and AI choices

Recorded as [0002](../decisions/0002-retrieve-then-judge-matching.md); summary:

- **Hot path is a deterministic workflow, not an agent loop.** Preview runs three bounded steps: (1) **extract**: a fast model returns the draft need statement ("who needs to do what so that outcome"), a proposed solution if one is named, and any additional asks; (2) **retrieve**: embed the draft need statement and take the top 8 approved or draft needs by cosine similarity (pgvector); (3) **judge**: a fast model scores each candidate with a probability that it is the same underlying need and a one-line reason; matches above a tuned threshold (start 0.6) are returned, at most 3. Bounded steps keep latency and cost predictable and make the step evaluable.
- **Models** via the existing Vercel AI Gateway seam (`lib/ai/models.ts`), each overridable by env and checked by `models.test.ts`:
  - Extract and judge: `anthropic/claude-haiku-5.5` (`SIGNAL_FAST_MODEL`), AI SDK structured output with zod schemas.
  - Priority scoring, theme suggestion, public summaries, decision briefs, demand summaries: `anthropic/claude-sonnet-5.5` (`SIGNAL_REASONING_MODEL`); these run off the hot path.
  - Embeddings: a Gateway embedding model (`SIGNAL_EMBEDDING_MODEL`, default `openai/text-embedding-3-small`, 1536 dimensions). _Assumption: confirm the id against the Gateway model list in the first task._
- **Off-hot-path work** (re-embedding, priority rescoring, theme and summary suggestions after a signal lands) runs with Next.js `after()` so the submit response is not delayed; results land as suggestions.
- **Agents.** The existing Eve **Operator** agent gets Signal tools for open-ended PM questions ("what are enterprise accounts blocked on?"); the Eve **Assistant** agent gets the public tools. Agent tools, MCP tools, and REST routes all call the same operations (below); none reimplements logic.
- **Human judgment is enforced in the domain layer, not the UI:** nothing auto-merges, approves, publishes a summary, or publishes a decision without a PM action. AI output is always a `suggestion` row until resolved.

### Agent- and API-first: one operation registry

Agents and the API are the product's primary interfaces; the UI is a client of the API and comes last. Every capability is defined **once** as an operation in `lib/signal/operations/`:

```ts
// lib/signal/operations/types.ts
type Operation<I extends z.ZodType, O extends z.ZodType> = {
  name: string; // snake_case; the MCP and agent tool name
  description: string; // shared by MCP, agent tool, and OpenAPI
  access: "public" | "operator";
  input: I; // zod; the REST body/query, MCP inputSchema, and agent tool schema
  output: O; // zod; parsed before returning on every surface
  errors: readonly ErrorCode[]; // the only codes this operation may return
  http: { method: "GET" | "POST" | "PUT"; path: string };
  run: (input: z.infer<I>, ctx: OperationContext) => Promise<z.infer<O>>;
};
// OperationContext: { actor: { kind: "human" | "agent"; ref: string; client?: string }, repo, ai, clock }
```

Thin adapters expose the registry and contain no business logic:

- `lib/signal/adapters/http.ts` → Next route handlers (zod validation, error envelope, rate limits).
- `lib/signal/adapters/mcp.ts` → `registerAppTool` on the public or Operator MCP server by `access`.
- `lib/signal/adapters/agent.ts` → Eve tools for the Assistant (public) and Operator (all) agents.
- OpenAPI and public discovery are generated from the same registry; public discovery lists `access: "public"` only.
- `lib/signal/client.ts` → a typed fetch client generated from the registry; the UI uses only this.

| Operation              | Access   | REST                                          | MCP / agent tool       |
| ---------------------- | -------- | --------------------------------------------- | ---------------------- |
| `search_needs`         | public   | `GET /api/needs`                              | `search_needs`         |
| `get_need`             | public   | `GET /api/needs/:id`                          | `get_need`             |
| `preview_signal`       | public   | `POST /api/signals/preview`                   | `preview_signal`       |
| `submit_signal`        | public   | `POST /api/signals`                           | `submit_signal`        |
| `get_my_signals`       | public   | `GET /api/my-signals/:token`                  | `get_my_signals`       |
| `list_suggestions`     | operator | `GET /api/operator/suggestions`               | `list_suggestions`     |
| `resolve_suggestion`   | operator | `POST /api/operator/suggestions/:id/resolve`  | `resolve_suggestion`   |
| `merge_needs`          | operator | `POST /api/operator/needs/:id/merge`          | `merge_needs`          |
| `undo_merge`           | operator | `POST /api/operator/merges/:id/undo`          | `undo_merge`           |
| `split_need`           | operator | `POST /api/operator/needs/:id/split`          | `split_need`           |
| `get_need_detail`      | operator | `GET /api/operator/needs/:id`                 | `get_need_detail`      |
| `get_criteria`         | operator | `GET /api/operator/criteria`                  | `get_criteria`         |
| `set_criteria`         | operator | `PUT /api/operator/criteria`                  | `set_criteria`         |
| `get_demand_summary`   | operator | `GET /api/operator/demand`                    | `get_demand_summary`   |
| `draft_decision_brief` | operator | `POST /api/operator/needs/:id/decision-brief` | `draft_decision_brief` |
| `publish_decision`     | operator | `POST /api/operator/needs/:id/decision`       | `publish_decision`     |
| `get_metrics`          | operator | `GET /api/operator/metrics`                   | `get_metrics`          |

**Build order per operation:** contract (zod input, output, errors) → parity tests (red) → domain tests (red) → domain implementation → adapters (green) → agent tool behaviour → UI. No UI work starts on an operation until its parity suite is green.

### Domain module and ports

`lib/signal/` holds the domain: pure functions over a repository and AI ports, injected like `pingDatabase`'s `query` parameter so AI is faked in tests while the database is real.

- `SignalRepository` (Drizzle; Neon in production and dev, local Docker Postgres or in-process PGlite in tests, see [docs/database.md](../database.md) and [0003](../decisions/0003-local-test-databases.md)).
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

Generated from the operation registry: route handlers validate with the operation's zod schemas, and the UI uses only the generated client in `lib/signal/client.ts`. The same inputs, outputs, and error codes apply to the MCP and agent tools. Every error is `{ error: { code, message, retryable } }` with codes `validation_failed`, `not_found`, `conflict`, `rate_limited`, `ai_unavailable`, `database_unavailable`, `unauthorized`, and `internal` (any unexpected failure; a generic message, never driver text).

Public (no auth, rate limited per IP, body limits):

| Operation        | Method and path              | Input                                                                                                                                       | Output                                                                                                                                                                                                       |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_needs`   | `GET /api/needs`             | `?q&theme&status&cursor`                                                                                                                    | public need list                                                                                                                                                                                             |
| `get_need`       | `GET /api/needs/:id`         | —                                                                                                                                           | public need view (no PII, approved summary only)                                                                                                                                                             |
| `preview_signal` | `POST /api/signals/preview`  | `{ title, body }`                                                                                                                           | `{ previewId, draftNeed: { statement, proposedSolution?, additionalAsks: string[] }, matches: [{ needId, statement, status, supporterCount, demandBand, probability, reason }], ai: "ok" \| "unavailable" }` |
| `submit_signal`  | `POST /api/signals`          | `{ title, body, useCase?, urgency?, email, name?, company?, target: { needId } \| { newNeed: { statement } }, previewId?, idempotencyKey }` | `{ signalId, needId, attachedTo, trackingUrl }`                                                                                                                                                              |
| `get_my_signals` | `GET /api/my-signals/:token` | —                                                                                                                                           | the token holder's signals with need status and decision notes                                                                                                                                               |

Operator (`verifyOperatorRequest`; fail closed when `OPERATOR_SECRET` is unset):

| Operation              | Method and path                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_suggestions`     | `GET /api/operator/suggestions?kind&status`   | triage queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resolve_suggestion`   | `POST /api/operator/suggestions/:id/resolve`  | `{ action: accept \| edit \| reject, edit? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `merge_needs`          | `POST /api/operator/needs/:id/merge`          | `{ intoNeedId }`; `conflict` if either need is already merged                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `undo_merge`           | `POST /api/operator/merges/:id/undo`          | restores signals to the original need                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `split_need`           | `POST /api/operator/needs/:id/split`          | `{ signalIds, statement }`; moves those signals to a new need                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_need_detail`      | `GET /api/operator/needs/:id`                 | full need: verbatim signals, accounts, scores, suggestions                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `get_criteria`         | `GET /api/operator/criteria`                  | `{ criteria: [{ key, weight, description }] }`; weights sum to 1                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `set_criteria`         | `PUT /api/operator/criteria`                  | `{ weights: Record<key, number> }` → same output as `get_criteria`; `validation_failed` unless every key is present, each weight is 0–1, and they sum to 1                                                                                                                                                                                                                                                                                                                                                  |
| `get_demand_summary`   | `GET /api/operator/demand`                    | `?themeId&accountId&since&limit` (all optional; `since` defaults to 90 days ago, `limit` 10, max 50) → `{ window: { since, until }, needs: [{ needId, statement, status, themeId, supporters, accounts, businessValueCents, newSupportersInWindow, trend: rising \| steady \| falling, priorityScore }], summary: { text, model } \| null, ai }`; needs ordered by priority score; `summary` is `null` with `ai: "unavailable"` when the reasoning model is unreachable, and the numbers are still returned |
| `draft_decision_brief` | `POST /api/operator/needs/:id/decision-brief` | creates a `decision_brief` suggestion                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `publish_decision`     | `POST /api/operator/needs/:id/decision`       | `{ status, note }` publishes a decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `get_metrics`          | `GET /api/operator/metrics?from&to`           | the three metrics and supporting counts, human vs. agent                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`trend` compares new supporters in the last 30 days of the window with the 30 days before: `rising` above +20%, `falling` below −20%, otherwise `steady`.

### MCP tools

Tools come from the operation registry above, named after their operation: `access: "public"` operations on `/api/mcp`, all operations on `/api/mcp/operator`. The Eve Assistant agent gets the public operations as tools and the Operator agent gets all of them. MCP and agent calls run with actor kind `agent` and `client` from MCP client info or the agent name; `submit_signal` requires `idempotencyKey` on every surface.

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
- **Public writes are open by design** (no submitter auth in the MVP): `preview_signal` and `submit_signal` (`POST /api/signals/preview`, `POST /api/signals`, and their public MCP and Assistant agent tools) are rate limited per IP, size limited, and never return other customers' PII. Submitter emails are stored and shown only to PMs.
- **PM writes fail closed:** every `access: "operator"` operation returns `unauthorized` over REST and Operator MCP unless `OPERATOR_SECRET` is configured and presented.
- **Without `DATABASE_URL`** every signal endpoint returns `database_unavailable` (503); the board shows an explanatory empty state. **Without AI Gateway access** preview returns `ai: "unavailable"` with no matches and submission still works.
- **Database:** Neon, provisioned with `pnpm neon:setup` (approved 2026-10-30), for dev and Vercel; tests use local Docker or PGlite ([0003](../decisions/0003-local-test-databases.md)); see [docs/database.md](../database.md) and [0001](../decisions/0001-neon-postgres-pgvector.md).

### UI

Built last, on the generated client only, once an operation's parity suite is green; no page calls the domain or database directly. Replaces the template's home stub. Public: `/` (board and search), `/submit` (form with debounced live preview), `/needs/[id]`, `/my/[token]`. Operator: `/operator/triage`, `/operator/needs/[id]`, `/operator/criteria`, `/operator/metrics`, and the existing Operator chat with Signal tools (open-ended demand questions go through `get_demand_summary`). Visual direction is open (`design` can run first).

## Testing Decisions

**Test-driven, surface by surface.** Every operation is built red → green → refactor, starting from the interfaces agents and API clients use, never from the UI. A test is written and seen failing before the code that makes it pass; a bug fix starts with a failing test that reproduces it.

- **Parity suite** (`tests/signal/parity/`, written first for each operation): one table of cases per operation (input, actor, expected output or error code) runs through all three surfaces: the HTTP route handler, the MCP tool (public or Operator server, by access), and the Eve agent tool. Each case asserts the same output (after removing surface envelopes), the same error code, the same events written, and that `access: "operator"` operations return `unauthorized` over HTTP and are absent from public MCP and the Assistant agent. A registry test fails if an operation is missing from any surface or its schemas differ between surfaces.
- **Domain tests** (`tests/signal/domain/`): `lib/signal` against a real Postgres with pgvector (local Docker behind a Neon HTTP proxy, or PGlite) with fake AI ports; cover matching thresholds, attach vs. draft, split, merge and undo, visibility filtering, suggestion resolution, decision publishing, and every metric calculation. Each test file runs in its own schema-reset transaction or truncates its tables. Prior art: the injected `query` in `lib/db/ping.ts` and `tests/db-ping.test.ts`.
- **Contract tests**: HTTP status codes and the error envelope (prior art `tests/genui-compose.route.test.ts`), MCP protocol and isolation (`tests/mcp/route.test.ts`, `tests/mcp/operator-isolation.test.ts`), including that public responses never contain email, company, revenue, or verbatim text of other submitters, and that Operator tools are absent from public discovery.
- **Agent behaviour tests** (`evals/agents/`, prior art `evals/eve-smoke.test.ts`): given a PM or submitter request, the Eve agent picks the expected operation with valid input (for example "add Acme's vote to the PDF need" → `submit_signal` with `target.needId`), and never calls an Operator tool from the Assistant. These run with live models in `pnpm eval`, never in `pnpm test` or CI: run them on demand and whenever agent instructions, agent tools, or operation descriptions change.
- **CI stays light:** lint, types, and `pnpm test` on PGlite only; no live-model evals and no Next.js build in CI (Vercel's preview deploy builds every pull request). The goal is a fast loop and maximum parallel work.
- **Test database:** when `DATABASE_URL_TEST` is set (local Docker Postgres 18 with pgvector behind a Neon HTTP proxy, one database per parallel worker) tests use it through the production driver; when unset they use in-process PGlite with the `vector` extension. CI leaves it unset and runs on PGlite, so CI needs no database service or secret ([0003](../decisions/0003-local-test-databases.md)).
- **Eval**: `evals/matching` thresholds are the kill criterion for the MVP; failing them blocks calling the bet proven, not the build.
- **Model ids**: extend `lib/ai/models.test.ts` to the new ids.

**Acceptance scenario.**

Starting state: seeded workspace. Theme "Reporting" holds the open need N1 "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers" with 11 supporters, proposed solution "PDF export", status `open`. Separate need N2 "Compliance teams need to archive monthly reports so that audits have a fixed record" also lists "PDF export". `OPERATOR_SECRET` is set; AI Gateway is available.

Human journey:

1. Maya (maya@acme.example, Acme, Enterprise) opens `/submit` and types title "Export dashboards to PDF" and body "Our CEO wants the KPI dashboard in the board deck every month." → within 2 s the preview shows N1 first with a reason mentioning sharing with executives, and does not rank N2 first.
2. Maya picks N1, adds use case "monthly board deck" and urgency high, enters her email, and submits → response has `attachedTo: existing` and a `trackingUrl`; N1 shows 12 supporters on the board; the board shows no Acme or Maya details.
3. A retry of the same submit with the same `idempotencyKey` → returns the same `signalId`; N1 still shows 12; one `signal.created` event exists.
4. In `/operator/triage` (`list_suggestions`) the PM sees a pending `priority` suggestion for N1 (business value raised, reason cites Acme's ARR) and a pending `public_summary` update → the PM accepts the score and edits the summary (`resolve_suggestion`) → `suggestion.accepted` and `suggestion.edited` events recorded; the approved summary appears on N1 without Acme's name.
5. The PM requests a decision brief for N1 (`draft_decision_brief`) → a `decision_brief` suggestion with demand, accounts, value, and options appears; the PM accepts it and publishes decision `planned` with note "Targeting Q1" (`publish_decision`) → N1 status is `planned`.
6. Maya opens her `trackingUrl` → she sees N1 as Planned with "Targeting Q1".
7. `/operator/metrics` for this week → prevention rate counts Maya's signal once in the numerator under human; decision latency includes N1 (first signal date to today); suggestion acceptance counts 2 accepted (score, brief) and 1 edited (summary); a submission that failed validation earlier in the week is not counted.

Agent journey (same starting state):

1. A support agent calls `preview_signal` on `/api/mcp` with the same text → N1 is the top match with a reason.
2. It calls `submit_signal` with `target.needId = N1`, Maya's email, and an `idempotencyKey` → returns `attachedTo: existing`; calling again with the same key returns the same `signalId`.
3. A PM agent calls `draft_decision_brief` then `publish_decision` on `/api/mcp/operator` with the bearer secret → N1 is `planned`; the same calls without the secret return `unauthorized`.
4. `get_metrics` → the agent signal is counted once under agent, not human; the decision is attributed `published_by_kind = agent`.

The same steps through the REST API and the Eve agent tools are covered by the parity suite: same outputs, error codes, and events on every surface.

## Tasks

- [x] 01: Operation registry, schema, and public read of needs
- [x] 02: Submit with a duplicate check
- [x] 03: Matching eval set and threshold
- [x] 04: PM triage of AI suggestions
- [x] 05: Prioritization, demand, and decisions
- [x] 06: Metrics from the event log
- [x] 07: Public board, submit, and My signals UI
- [ ] 08: Operator console UI (deferred: API, MCP, and agents first; paused work on `build/t08`)
- [ ] 09: Agent behaviour evals and acceptance run (agent evals and MCP journey done; browser steps wait for 08)

Run for maximum parallelism: after 01, tasks 02, 03, 04, 05, and 06 run at once, each defining its own operations' contracts first; they merge in order 02 → 06 → 03 → 04 → 05. The UI tasks start once the contracts they call are merged: 07 after 02, 08 after 04, 05, and 06. Each operation follows the build order in [Agent- and API-first](#agent--and-api-first-one-operation-registry): contract → failing parity and domain tests → implementation → adapters; the UI tasks come last.

### 01: Operation registry, schema, and public read of needs

**What to build:** the foundation every other task plugs into, proven end to end by the first two operations. Anyone can search and read needs from seeded data over REST, the public MCP, and the Assistant agent, with identical results; Operator-only operations are invisible publicly.

**Area:** lib/signal, lib/db, lib/mcp, lib/agent-tools, agents, app/api, tests, evals, scripts, package.json

**Blocked by:** None (can start immediately)

- [ ] The operation type, registry, error envelope, and actor context exist as specified; HTTP, MCP (public and Operator by access), and Eve agent adapters are generated from the registry with no business logic in them; OpenAPI and public discovery list public operations only.
- [ ] The full spec 001 schema (all tables, pgvector extension) is in Drizzle and pushed to Neon `main`; a test-database harness uses `DATABASE_URL_TEST` (local Docker via `pnpm db:up`) or PGlite when unset, and resets tables per test file; the suite passes both ways.
- [ ] The parity suite runs a case table through REST, public MCP, and the Assistant agent tool and asserts the same output, error code, and events; a registry test fails when an operation is missing from a surface or its schemas differ.
- [ ] `search_needs` and `get_need` are built test-first and pass parity; public output never contains submitter name, email, company, revenue, verbatim signal text, or an unapproved summary.
- [ ] `pnpm db:seed` loads the deterministic demo workspace (8 accounts, 4 themes, about 25 needs, about 150 signals over 90 days) including the acceptance scenario's N1 and N2.
- [ ] New model ids are added to the model seam and checked by its test; `pnpm qa` passes.

### 02: Submit with a duplicate check

**What to build:** a person or agent describes a need, sees likely matching needs with reasons, and either adds their voice to an existing need with their own words kept or submits a new signal that creates a draft need; they can follow it on their private My signals link.

**Area:** lib/signal, lib/ai, app/api, tests

**Blocked by:** 01

- [ ] `preview_signal`, `submit_signal`, and `get_my_signals` are built test-first and pass parity on REST, public MCP, and the Assistant agent.
- [ ] The extract → retrieve → judge workflow runs behind the `NeedExtractor`, `Embedder`, `NeedRetriever`, and `MatchJudge` ports with AI SDK implementations and test fakes; needs are embedded on create and statement change.
- [ ] Choosing a match writes a signal with `attached_to: existing`; "none of these" creates a draft need and a signal with `attached_to: draft`; a second ask is returned in `additionalAsks`.
- [ ] Every write records its event in the same transaction; a retry with the same `idempotencyKey` returns the same signal and writes one event; failed requests write none; actor kind and agent client are recorded.
- [ ] Without AI Gateway access preview returns `ai: "unavailable"` and submit still works; without a database both return `database_unavailable`; public writes are rate limited and size limited.

### 03: Matching eval set and threshold

**What to build:** proof that matching is trustworthy enough to show at submission (the MVP kill criterion): a labeled set scored on every change, and a tuned judge threshold.

**Area:** evals, lib/signal

**Blocked by:** 01 (dataset and runner start now; the live threshold run needs 02's extractor and judge, merged first)

- [ ] At least 120 labeled submissions against a fixture need catalog, covering paraphrases, same solution for different needs, multi-ask, and unrelated cases.
- [ ] The runner reports precision@3, false-match rate, new-need recall, need-statement rubric score, p95 latency, and cost per signal, and joins `pnpm eval`; it skips with a message without Gateway access.
- [ ] The judge threshold is tuned on the set and recorded in the spec; the run meets PRODUCT.md's thresholds (precision@3 ≥ 90%, false-match ≤ 5%) or the shortfall is reported as a kill-criterion result.

**Result (live run, 2026-10-30, 131 cases, `anthropic/claude-haiku-5.5`, extended thinking off, extraction concurrent with judging):** at `MATCH_THRESHOLD` 0.6 (kept; best in the sweep) precision@3 100%, false-match 0%, new-need recall 100%, match recall@3 100%, cost $0.00044 per signal: the kill criterion passes. Two guardrails still miss: p95 latency 4.7 s at 4 concurrent requests (target 2 s; 7.8 s before these two changes) and the need-statement rubric 3.77/5 (target 4). Both are open follow-ups; the slowest step is now the judge writing a verdict and reason for all 8 candidates.

### 04: PM triage of AI suggestions

**What to build:** after signals land, AI proposes draft-need approvals, merges, themes, public summaries, and splits; a PM (or an agent with Operator access) reviews them, accepts, edits, or rejects, merges and undoes merges, and splits needs, without any signal ever being lost.

**Area:** lib/signal, lib/ai, app/api, tests

**Blocked by:** 01 (starts on seeded data; 02 is merged first, then generation hooks into submit)

- [ ] Off-hot-path generation (after the submit response) creates `draft_need`, `merge`, `theme`, `public_summary`, and `split` suggestions with reasons, through the `Reasoner` port with fakes in tests.
- [ ] `list_suggestions`, `resolve_suggestion`, `merge_needs`, `undo_merge`, `split_need`, and `get_need_detail` are built test-first and pass parity on REST, Operator MCP, and the Operator agent; each returns `unauthorized` without the Operator secret and is absent from public MCP and the Assistant agent.
- [ ] Merges move every signal and can be undone exactly; merging an already merged need returns `conflict`.
- [ ] A public summary is never returned publicly until approved; accepted, edited, and rejected resolutions each record their event with the resolver's actor kind.

### 05: Prioritization, demand, and decisions

**What to build:** a PM sees each need scored against editable criteria with reasons, asks for a demand summary, gets an AI-drafted decision brief, and publishes a decision whose note supporters see on their My signals link.

**Area:** lib/signal, lib/ai, app/api, tests

**Blocked by:** 01 (starts on seeded data; 04 is merged first, then briefs and scores resolve through `resolve_suggestion`)

- [ ] `get_criteria`, `set_criteria`, `get_demand_summary`, `draft_decision_brief`, and `publish_decision` are built test-first and pass parity on REST, Operator MCP, and the Operator agent.
- [ ] AI priority scoring produces `priority` suggestions per criterion with reasons; PM overrides are stored with source `pm`; weights validate as specified.
- [ ] `get_demand_summary` returns the numbers and trend as specified, with `summary: null` and `ai: "unavailable"` when the reasoning model is unreachable.
- [ ] Publishing a decision sets the need status, records `decision.published` with actor kind, and the note appears through `get_my_signals` for every supporter.

### 06: Metrics from the event log

**What to build:** a PM or agent reads the three MVP metrics (prevention rate, decision latency, AI suggestion acceptance) and the supporting counts for a window, split human vs. agent, computed exactly as PRODUCT.md defines them.

**Area:** lib/signal, app/api, tests

**Blocked by:** 01

- [ ] `get_metrics` is built test-first and passes parity on REST, Operator MCP, and the Operator agent.
- [ ] Domain tests on hand-built event histories prove each calculation, including: retries counted once, failed requests excluded, undone merges no longer counted as duplicates, needs open past 30 days reported separately, and human vs. agent attribution.
- [ ] Seeded history produces non-empty values for all three metrics.

### 07: Public board, submit, and My signals UI

**What to build:** customers use Signal in the browser: browse and search the board, submit with a live duplicate check that shows matches and reasons as they type, open a need, and follow their signals on the private link.

**Area:** app, components, lib/signal

**Blocked by:** 02

- [ ] The typed client is generated from the registry, and the pages call only the client.
- [ ] `/` (board and search), `/submit` (debounced live preview, add my voice, none of these, split offer), `/needs/[id]`, and `/my/[token]` work on seeded data, replacing the template home stub.
- [ ] AI-unavailable and database-unavailable states are explained, not blank; no PII from other customers appears on any page.
- [ ] Human steps 1–3 and 6 of the acceptance scenario pass in the browser.

### 08: Operator console UI

**What to build:** a PM works entirely in the Operator console: triage queue, need detail with verbatim signals and scores, criteria weights, metrics, decision briefs and publishing, and the Operator chat answering demand questions with Signal tools.

**Area:** app/operator, components, lib/signal, agents

**Blocked by:** 04, 05, 06

- [ ] `/operator/triage`, `/operator/needs/[id]`, `/operator/criteria`, and `/operator/metrics` work on seeded data through the typed client only.
- [ ] The Operator chat answers "what are enterprise accounts blocked on?" through `get_demand_summary`.
- [ ] Human steps 4, 5, and 7 of the acceptance scenario pass in the browser.

### 09: Agent behaviour evals and acceptance run

**What to build:** evidence the MVP works for humans and agents together: live-model agent behaviour checks and the full acceptance scenario on a fresh seed, locally and on the Vercel deployment.

**Area:** evals, tests, docs

**Blocked by:** 03, 07, 08

- [ ] Agent behaviour evals pass: the Assistant agent picks `preview_signal` then `submit_signal` with `target.needId` for "add Acme's vote to the PDF need" and never calls an Operator operation; the Operator agent drafts and publishes a decision when asked.
- [ ] The full acceptance scenario (human journey and agent journey) passes on a fresh seed of a test database, with metrics counted as specified.
- [ ] The deployed preview serves the board and public MCP with the database connected, and Operator surfaces fail closed without the secret.

## Out of Scope

- Ingestion from Intercom, Zendesk, Slack, or email ([002 candidate](./002-feedback-ingestion.md)).
- Email or Slack notifications to supporters ([003 candidate](./003-stakeholder-notifications.md)); updates appear in the app and over MCP only.
- CRM revenue sync (accounts are seeded or edited by a PM).
- Submitter sign-in, SSO, multiple workspaces, granular roles.
- Roadmap or Jira sync; an MCP App UI.

## Further Notes

Where the assignment's required documentation lives:

| Required                                      | Location                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Business problem prioritized and why          | PRODUCT.md → Problem                                                                |
| Who benefits                                  | PRODUCT.md → Who                                                                    |
| Why AI is appropriate                         | PRODUCT.md → Why AI                                                                 |
| How AI changes the workflow                   | PRODUCT.md → Why AI; this spec → Solution                                           |
| Agent, model, framework, architecture and why | This spec → Architecture and AI choices, Agent- and API-first; decisions 0001, 0002 |
| Where human judgment remains                  | PRODUCT.md → Where human judgment stays; enforced in the domain layer here          |
| Measuring business impact                     | PRODUCT.md → Metrics; this spec → Metrics instrumentation                           |
| Assumptions, risks, tradeoffs                 | PRODUCT.md → Riskiest assumptions, Pre-mortem; decisions 0001, 0002 → Consequences  |

Open assumptions: the embedding model id and dimension; the 0.6 judge threshold (tuned on the eval set); PGlite and Postgres 18 behaving the same for the queries used (both run locally to catch drift); Haiku latency meeting 2 s p95 for extract plus judge of 8 candidates.
