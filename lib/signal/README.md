# lib/signal

Signal's domain and its one operation registry ([spec 001](../../docs/specs/001-signal-mvp.md) → Agent- and API-first). Every capability is an **operation**; REST, MCP, and Eve agent tools are generated from it, so no surface holds business logic.

```
operations/   one file per operation + registry.ts, types.ts, execute.ts
adapters/     http.ts (REST), mcp.ts (MCP tools), agent.ts (Eve tools), openapi.ts, schema.ts
domain/       queries and rules shared by operations (public-needs.ts: the public need view)
ai/           ports.ts (interfaces), gateway.ts (AI SDK), fakes.ts (tests)
seed/         deterministic demo workspace for `pnpm db:seed`
events.ts     recordEvent: the append-only event log behind the metrics
metrics.ts    get_metrics calculations: SQL over events (which fields each metric reads)
errors.ts     error codes, SignalError, the { error: { code, message, retryable } } envelope
context.ts    OperationContext: { actor, db, ai, clock }
runtime.ts    builds the context from DATABASE_URL and the Gateway; test overrides
```

## Add an operation

Every spec 001 operation already has a file in `operations/` and a line in `registry.ts`. A planned one is a `plannedOperation({...})` stub that no surface exposes. **Replace that file**; do not edit `registry.ts` (a new operation outside the spec adds one import and one entry there).

1. **Contract.** In `operations/<name>.ts`, `defineOperation({ name, description, access, http, input, output, errors, run })`. Write `description` for an agent. `input` is a `z.object` (REST query or body plus `:path` params; use `z.coerce` for numbers read from a GET query). `output` must be plain JSON: ISO strings, not `Date`. `errors` lists the codes `run` may throw; `validation_failed`, `database_unavailable`, `rate_limited`, and `internal` are implicit, plus `unauthorized` for `access: "operator"`. Anything else `run` throws (a driver error, an output that fails its schema) becomes `internal` (500, retryable, message "Something went wrong.") on every surface; `executeOperation` logs one line with the operation, the error class, and the SQLSTATE, never the message or params (they can hold submitter PII). SQLSTATE classes 08, 53, and 57 (including 57014 statement timeout) are `database_unavailable`. Set `effects: "write"` on an Operator operation that changes PM-owned state: the Operator agent then requires user approval (eve `always()`) for each call.
2. **Parity table (red).** Add `tests/signal/parity/<name-with-dashes>.parity.test.ts` (the registry test fails without it). See below.
3. **Domain tests (red).** Add `tests/signal/domain/<topic>.test.ts` for the rules.
4. **Implement `run`.** Put queries and rules in `domain/` and call them from `run(input, ctx)`. Throw `new SignalError(code, message)` for expected failures. Writes go in `ctx.db.transaction(async (tx) => ...)`, with `recordEvent(tx, ...)` in the same transaction.
5. **Green.** The adapters pick it up: REST via `app/api/[...path]/route.ts`, MCP on `/api/mcp` (public) or `/api/mcp/operator` (all), the Assistant (public) and Operator (all) Eve agents, plus OpenAPI and the MCP server card (public only). No route files or tool files to add.

Actors: REST callers are `human` unless they send `X-Signal-Agent: <client>`; MCP calls are `agent` with the MCP client name; Eve tools are `agent` with client `eve:<agent>`. Operator access over REST is checked by the adapter (`verifyOperatorRequest`); the Operator MCP route checks it before the server starts.

Limits: public operations are rate limited per client IP and operation (120/min) on REST and the MCP servers, sharing one budget (`adapters/rate-limit.ts`; the MCP route also keeps its global 120/min per IP); REST bodies are capped at 16 KB. Override per operation with `limits: { requestsPerMinute, maxBodyBytes }`. The limiter is in memory, so each server instance counts on its own (a shared store such as KV is not built).

## Typed client (UI)

`client.ts` is generated from the registry by `pnpm signal:client` (`scripts/generate-signal-client.ts`); do not edit it. It has one method per operation (`createSignalClient().searchNeeds({ q })`), typed from the operation's zod input and output (planned operations are typed `never` until built, so building one needs no regeneration; adding or renaming one does, and `tests/signal-client.test.ts` fails until you regenerate). Calls return `{ ok: true, data } | { ok: false, error }` with the error envelope's code plus `network_error`. Browser code uses `createSignalClient()` (relative URLs, the public REST API). Server components use `signalServerClient()` from `app/_components/signal/server-client.ts`, which dispatches the same REST requests in process through the HTTP adapter (`server-client.ts`) with the visitor's IP for rate limits; for Operator calls, build one with `createInProcessSignalClient({ headers: { authorization: "Bearer <OPERATOR_SECRET>" } })`. Pages never import the domain or the database.

## Matching and embeddings

`domain/matching.ts` runs preview's extract → retrieve → judge workflow (`previewSubmission`); `MATCH_THRESHOLD` (0.6, tuned by task 03), `CANDIDATE_LIMIT` (8), and `MAX_MATCHES` (3) live there. Any AI step failing with `ai_unavailable` degrades to `ai: "unavailable"` with no matches. `previewId` is a deterministic hash of the text (no preview state is stored); `submit_signal` records it in the `signal.created` payload.

Only needs with an embedding are candidates. `submit_signal` embeds a new draft need's statement (left null if the embedder is down). **When you change a need's statement or create a need** (resolve_suggestion edits, split_need), call `embedNeeds(db, ctx.ai.embedder, [needId])` from `domain/embeddings.ts` after the write commits (or in `after()`). `pnpm db:embed` (`--test` for `DATABASE_URL_TEST`) backfills every live need without an embedding via `embedMissingNeeds`; it is idempotent and needs Gateway access.

Submissions (`domain/submissions.ts`): a merged-away `target.needId` lands on the live need; the submitter is upserted by lowercased email (a known `company` links its account; an unknown one creates an `Unknown`-plan account); a reused `idempotencyKey` with different content is `conflict`. Tracking tokens are per submission, so `get_my_signals` shows only the signal(s) filed under that token, never all signals for an email (emails are unverified).

## Events

`recordEvent(tx, { type, actor, needId, signalId, suggestionId, payload, dedupeKey })` appends to `events`. Pass `dedupeKey` derived from the request's `idempotencyKey` so a retry counts once (`recordEvent` returns `false` for a duplicate). Failed or rolled-back requests write nothing because the event shares the transaction. Add new types to `SignalEventType`; the column is free text, so no migration is needed.

## AI ports

`ctx.ai` holds `extractor`, `embedder`, `retriever` (pgvector), `judge`, and `reasoner`. Production uses `ai/gateway.ts`: the extractor and judge are AI SDK structured output on the fast model (`gatewayExtractor({ model? })`, `gatewayJudge({ model? })`; tests inject `MockLanguageModelV4`), and the reasoner is `reasoningModelReasoner({ model?, modelId? })` in `ai/reasoning-model.ts` (re-exported as `gatewayReasoner`): one task-agnostic AI SDK structured-output call on the reasoning model for every `ReasonerTask`; the caller passes prompt, system, and zod schema. Model ids come from `lib/ai/models.ts`: `signalFastModelId()` (`SIGNAL_FAST_MODEL`, default `anthropic/claude-haiku-5.5`), `signalReasoningModelId()` (`SIGNAL_REASONING_MODEL`, default `anthropic/claude-sonnet-5.5`), and `signalEmbeddingModelId()` (`SIGNAL_EMBEDDING_MODEL`, default `openai/text-embedding-3-small`, 1536 dimensions).

`pnpm test` never calls a live model. The database harness installs `createFakeAi()`. Override per test with `configureSignalRuntime({ ai: createFakeAi({ judge: fakeJudge({ [needId]: { probability: 0.9, reason: "..." } }) }) })`, or simulate an outage with `createUnavailableAi()`. `fakeReasoner({ decision_brief: ({ prompt }) => ({...}) })` answers a reasoner task; an unhandled task fails with `ai_unavailable`. Add a task name to `ReasonerTask` when an operation needs one. Live-model checks belong in `pnpm eval`.

## Prioritization, demand, and decisions

- `domain/criteria.ts`: criteria keys, defaults (returned when `priority_criteria` is empty), `criteriaWeightsSchema` (every key, each 0–1, sum 1 ± 1e-6). A need's priority score is `Σ score × weight` (0–5).
- `domain/need-facts.ts`: Operator facts about one need (supporters, accounts and ARR, use cases, scores, trend) for model prompts; no submitter names or emails. `trendOf` holds the rising / steady / falling rule.
- `domain/demand.ts`: `get_demand_summary` numbers (SQL) plus the `demand_summary` reasoner call; any model failure gives `summary: null, ai: "unavailable"` with the numbers intact.
- `domain/priority.ts`: `suggestPriorityScores({ ai, db, now }, needId)` asks the reasoner (task `priority`) for a 0–5 score and reason per criterion and files a pending `priority` suggestion (payload `{ reason, scores, reasons }`, `suggestion.created` by `signal:ai`); a pending one for the same need is refreshed instead of duplicated. Suggestion generation calls it after every signal lands.
- `domain/decisions.ts`: `draftDecisionBrief` (task `decision_brief` on the decision model, spec 007 / 0006; demand, accounts, and value in the markdown come from the database, the current strategy is in the prompt and its version in the payload, options and the recommendation with confidence and strategy fit from the model) and `publishDecision` (need status, `decisions` row with the latest accepted/edited brief, `decision.published` with the publisher as actor and the brief's `recommendedStatus`, one transaction). `get_my_signals` and the public need view read the `decisions` table.
- `ai/reasoning-model.ts`: `reasoningModelReasoner()`, the one production `Reasoner` (see AI ports).

**Resolve hooks.** `resolve_suggestion` applies these two kinds by calling, inside its transaction and before marking the suggestion resolved (for `accept` and `edit`; `reject` applies nothing):

| Kind             | Hook                                                      | `edit` shape                                                       | Effect                                                                                                                                                               |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priority`       | `applyPrioritySuggestion(tx, { suggestion, edit?, now })` | `priorityEditSchema`: `{ scores: { <criterion>: 0–5 }, reasons? }` | Upserts `priority_scores`: AI scores with source `ai`, scores the PM set with source `pm` (the PM override).                                                         |
| `decision_brief` | `applyDecisionBriefSuggestion(tx, { suggestion, edit? })` | `decisionBriefEditSchema`: `{ markdown }`                          | Accept: nothing else. Edit: replaces `payload.markdown` (keeps `originalMarkdown`). `publish_decision` attaches the latest accepted or edited brief to the decision. |

Both throw `validation_failed` for a malformed edit; `applyPrioritySuggestion` throws `conflict` (merged need) or `not_found`. They are registered as handlers in `domain/suggestion-kinds.ts` (see PM triage).

## Strategy and readiness (spec 007)

Operations: `get_strategy`, `set_strategy`, `list_ready_needs` (all Operator; `set_strategy` is a write).

- `domain/strategy.ts`: the append-only strategy (`getStrategy`, `setStrategy`, `readinessLine`, `DEFAULT_READINESS` when none is written).
- `domain/readiness.ts`: `checkReadiness(deps, needIds?)` marks live, undecided needs (`draft | open`, no decision, `ready_at` null) whose distinct supporting accounts' ARR or distinct supporters reach either nonzero threshold: sets `ready_at` and records `need.ready` once (`dedupeKey: need.ready:<needId>`, payload `{ arrCents, supporters, strategyVersion }`, actor `signal:ai`). It then schedules an automatic `draftDecisionBrief` for every ready, undecided need that has no pending brief and none drafted since it became ready, so a brief that failed with `ai_unavailable` is retried on the next check. Hooks: suggestion generation (the signal's need), `merge_needs` and `undo_merge` (scheduled after the response), `set_strategy` (every live need, inline, for `newlyReady`). `listReadyNeeds` backs `list_ready_needs`.
- `domain/scheduler.ts`: the off-hot-path scheduler shared by suggestion generation, readiness, and auto briefs (`scheduleOffHotPath`; `after()` in route handlers, a recorder in tests).

## PM triage

Operations: `list_suggestions`, `resolve_suggestion`, `merge_needs`, `undo_merge`, `split_need`, `get_need_detail` (all Operator).

- `domain/suggestions.ts`: the queue (`listSuggestions`, `toSuggestionViews`; `reason` is lifted from `payload.reason`) and `resolveSuggestion(ctx, { id, action, edit? })`. One transaction: lock the suggestion (`conflict` unless `pending`), validate `edit` with the kind's schema (`validation_failed`), run the kind's `apply` (accept / edit) or `reject`, set `status`, `resolved_at`, `resolved_by_kind` (the resolver's actor kind), merge `{ edit }` into the payload, and record `suggestion.accepted | edited | rejected` (payload `{ kind }`, actor = resolver). If `apply` throws, nothing is written. Needs an `apply` created or reworded are embedded after commit.
- `domain/suggestion-kinds.ts`: **the per-kind registry** (`suggestionKindHandlers`). A handler is `defineSuggestionKind({ edit?: zodSchema, apply?, reject? })` (types in `suggestion-types.ts`); adding a kind is one entry. A kind without a handler can be accepted/rejected (decision recorded only) but not edited. Payloads and edits by kind:

| Kind                         | Payload (plus `reason`)                        | `edit`                                              | Accept / edit does                                                           | Reject does                                    |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `draft_need`                 | `statement`; `signalIds` column                | `{ statement }`                                     | draft → `open`, `approved_at`, statement (re-embedded if changed)            | nothing (stays draft)                          |
| `merge`                      | `intoNeedId` (= `relatedNeedId`), `similarity` | `{ intoNeedId }`                                    | `mergeNeeds` (below)                                                         | nothing                                        |
| `theme`                      | `themeId` or `themeName`                       | `{ themeId }` or `{ themeName, themeDescription? }` | sets `needs.theme_id` (a named theme is found case-insensitively or created) | nothing                                        |
| `public_summary`             | `summary`                                      | `{ summary }`                                       | `public_summary` = text, status `approved` (only now public)                 | `pending` → `none` if no other pending summary |
| `split`                      | `statement`, `signalIds`                       | `{ statement, signalIds? }`                         | `splitNeed` (below)                                                          | nothing                                        |
| `priority`, `decision_brief` | task 05 (above)                                | task 05                                             | task 05 hooks                                                                | nothing                                        |

- `domain/merges.ts`: `mergeNeeds(tx, …)` moves every signal (and proposed solutions whose `source_signal_id` moved), sets `merged` + `merged_into_id`, inserts `merges`, records `need.merged` (needId = merged-away need, payload `{ mergeId, intoNeedId, previousStatus }`). `conflict` if either need is merged; `validation_failed` for a self-merge. `undoMerge(tx, …)` moves exactly `moved_signal_ids` back (those still on the target), restores the previous status (from the `need.merged` payload; seeded merges fall back to `open`/`draft` by `approved_at`), sets `undone_at`, records `merge.undone` (payload `{ mergeId, intoNeedId }`). `conflict` if already undone or the target was merged since (undo that first).
- `domain/splits.ts`: `splitNeed(tx, …)` moves the listed signals (at least one, never all) and their solutions to a new need (same theme; `open`, or `draft` if the source is a draft), records `need.created` for the new need (signalId = first moved signal, payload `{ splitFrom }`) and `need.split` on the source (payload `{ newNeedId, signalIds }`). Callers embed the new need after commit (`embedNeedsQuietly`).
- `domain/need-detail.ts`: `get_need_detail`'s private view (verbatim signals with submitter and account, accounts with ARR, scores, weighted score, decisions, merges, suggestions).

**Suggestion generation** (`domain/suggestion-generation.ts`). `generateSuggestionsForSignal({ ai, clock, db }, { signalId })` proposes, via the `Reasoner` (tasks `draft_need`, `merge`, `theme`, `public_summary`, `split`), with reasons: an approved statement for a draft need its signal created; a merge target among the top 5 pgvector neighbours (draft-created needs only); a theme for an unthemed need; an anonymized public summary when the signal has a use case (dropped if it contains a supporter's name, email, or company; the need goes `none` → `pending`, never public until approved); a split when some of the need's signals ask for something else. It also calls `suggestPriorityScores`. Each kind is independent and skipped when one is already pending for the need; AI failures skip a kind, and the function never throws. Suggestions are written with `suggestion.created` by `signal:ai` (agent).

`submit_signal` (the operation, after its transaction, and only for a fresh signal: the domain returns an internal `replayed: true` for a reused `idempotencyKey`) calls `scheduleSuggestionGeneration(ctx, signalId)`, which runs generation with Next.js `after()` (or starts it immediately outside a request scope). The scheduler is injectable: `configureSuggestionScheduler(fn)` / `resetSuggestionScheduler()`. The test database harness installs a recorder (`scheduledGenerations` in `tests/signal/support/database.ts`), so nothing runs in the background during tests; run one with `await scheduledGenerations[0]()`.

## Tests

Tests run on one of two databases, chosen by `DATABASE_URL_TEST` (the shell wins over `.env.local`):

| `DATABASE_URL_TEST`                                                     | Database                                                                                                                                           | Used by                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| set, e.g. `postgres://postgres:postgres@localhost:5432/signal_test_t01` | Postgres 18 + pgvector in Docker, reached through the local Neon HTTP/WebSocket proxy with the production driver (`@neondatabase/serverless` Pool) | local runs                                     |
| unset or empty                                                          | in-process PGlite with pgvector (`@electric-sql/pglite`, `@electric-sql/pglite-pgvector`), fresh per test file                                     | CI, and `DATABASE_URL_TEST= pnpm test` locally |

Local Docker stack (compose project `signal`, fixed ports, shared by all worktrees):

```bash
pnpm db:up          # docker compose -p signal up -d --wait: db on :5432, neon-proxy on :4444
DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/signal_test_<suffix> pnpm test
pnpm db:test:setup  # optional: create the DATABASE_URL_TEST database and apply the schema now
pnpm db:down
```

- Give each parallel worktree its own database name (`signal_test_<suffix>`). The harness creates the database if missing and rebuilds its schema when `lib/db/schema.ts` changed (hash in `_signal_schema`), via `lib/db/prepare-database.ts`. Local hosts (`localhost`, `127.0.0.1`, `*.localtest.me`) go through the proxy (`configureNeonFor` in `lib/signal/db.ts`).
- `tests/setup/database-env.ts` runs first in every test file. It points `DATABASE_URL` at the test database or removes it, so nothing under test can reach the dev database.
- `tests/signal/**` is the `signal` Vitest project. Its files run one at a time in one fork because a Docker test database is shared by the files of one run.
- In a database test, wrap the file in `describeWithDatabase(name, () => { const harness = useTestDatabase(); ... })` from `tests/signal/support/database.ts`. It opens the database, truncates every Signal table, routes every adapter to it (`configureSignalRuntime({ db, ai })`) with fake AI, and closes it afterwards. Tests never skip.
- Build data with `tests/signal/support/builders.ts` (`insertNeed`, `insertTheme`, `insertSubmitter`, `insertAccount`, `insertCriteria`, `supporters(n)`). Use `resetDatabase(db)` to start over mid-file.
- Code takes `SignalDb` (Drizzle's generic Postgres database type), so it runs unchanged on Neon, Docker, and PGlite. Writes use `db.transaction`, which all three support; the Neon `neon-http` driver is not used for the app because it has no interactive transactions.
- New tables go in `lib/db/schema.ts` and in `signalTableNames` there, so the harness and the seed truncate them. Test databases get the schema automatically; Neon branches get it from versioned migrations: `pnpm db:generate`, then `pnpm db:migrate` (see docs/database.md → Migrations and seeds).

## Agent behaviour evals

`pnpm eval:agents` (part of `pnpm eval`; never `pnpm test` or CI) sends ~15 scripted requests to the real Assistant and Operator agents and checks the tool calls, their key arguments, and the database state (`evals/agents/scenarios.ts`). The harness (`evals/agents/harness.ts`) loads each agent the way eve compiles it (`instructions.md` as the system prompt, every file in `tools/` including the dynamic Signal tools, the model from `agent.ts`) and runs it in process with the AI SDK over a freshly seeded `DATABASE_URL_TEST` (local only) or PGlite; it does not run eve's server runtime or its built-in `eve__*` tools. Run it whenever agent instructions, agent tools, or operation descriptions change. Live runs need Gateway access (`AI_GATEWAY_API_KEY`, or `VERCEL=1` with `VERCEL_OIDC_TOKEN`) and skip without it; `--only assistant/` runs a subset; `--fake` replays scripted model replies offline to prove the wiring. The report (per-scenario checks, tool-call traces, latency, spend) prints and lands in `evals/agents/results/latest.json`. Harness logic is unit-tested in `tests/evals/agents.test.ts`. Add a scenario with its `check` and a `script` for `--fake`.

## Parity

`runParityTable({ operation, fixture, cases, mutates })` from `tests/signal/parity/harness.ts`:

- `fixture(db)` builds the data. Read-only tables build it once. With `mutates: true` the database is reset and the fixture rebuilt before each surface call, and ids and timestamps are normalized (`normalizeRun`) before comparing.
- Each case gives `input(fixture)` and either `expect(fixture)` (`{ output }` or `{ error: code }`) or `check(output, fixture)`, or both.
- Every case runs through REST (the real route handler, with `X-Signal-Agent` and the Operator bearer when needed), MCP (public or Operator server), and the Eve tool (Assistant or Operator). Outputs, error codes, and written events must match exactly; every surface acts as an `agent`.
- `assertNoPrivateData` in `tests/signal/support/public-needs-fixture.ts` shows how to check that public output has no PII.
- `tests/signal/registry.test.ts` checks the registry against the spec table, the input schema on every surface, Operator isolation (a probe operation proves `unauthorized` over REST and absence from public MCP, the Assistant, and OpenAPI), and that each built operation has a parity file.

## Seed

`pnpm db:seed` loads the demo workspace into `DATABASE_URL`, replacing all Signal data; it refuses on Vercel or in CI, and on a database that already has needs unless `--replace` is passed. `pnpm db:seed --test` seeds `DATABASE_URL_TEST` instead (run `pnpm db:test:setup` first for a new Docker database). The content (`seed/demo-data.ts`) is hand-written: 8 accounts, 4 themes, 25 needs (including the acceptance scenario's `n1` and `n2`), and 150 signals over 90 days, with merges, decisions, scores, suggestions, and their events. Ids and text come from a fixed faker seed, and dates are relative to today. Statements are embedded when the AI Gateway is reachable (`--no-embed` skips it). To extend it, add needs or fields in `demo-data.ts` and rows in `demo-workspace.ts`; `tests/signal/domain/seed.test.ts` pins the counts and N1/N2.
