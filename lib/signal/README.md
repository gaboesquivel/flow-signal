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

1. **Contract.** In `operations/<name>.ts`, `defineOperation({ name, description, access, http, input, output, errors, run })`. Write `description` for an agent. `input` is a `z.object` (REST query or body plus `:path` params; use `z.coerce` for numbers read from a GET query). `output` must be plain JSON: ISO strings, not `Date`. `errors` lists the codes `run` may throw; `validation_failed`, `database_unavailable`, and `rate_limited` are implicit, plus `unauthorized` for `access: "operator"`.
2. **Parity table (red).** Add `tests/signal/parity/<name-with-dashes>.parity.test.ts` (the registry test fails without it). See below.
3. **Domain tests (red).** Add `tests/signal/domain/<topic>.test.ts` for the rules.
4. **Implement `run`.** Put queries and rules in `domain/` and call them from `run(input, ctx)`. Throw `new SignalError(code, message)` for expected failures. Writes go in `ctx.db.transaction(async (tx) => ...)`, with `recordEvent(tx, ...)` in the same transaction.
5. **Green.** The adapters pick it up: REST via `app/api/[...path]/route.ts`, MCP on `/api/mcp` (public) or `/api/mcp/operator` (all), the Assistant (public) and Operator (all) Eve agents, plus OpenAPI and the MCP server card (public only). No route files or tool files to add.

Actors: REST callers are `human` unless they send `X-Signal-Agent: <client>`; MCP calls are `agent` with the MCP client name; Eve tools are `agent` with client `eve:<agent>`. Operator access over REST is checked by the adapter (`verifyOperatorRequest`); the Operator MCP route checks it before the server starts.

REST limits: public operations are rate limited per IP (120/min) and bodies capped at 16 KB; override per operation with `limits: { requestsPerMinute, maxBodyBytes }`.

## Matching and embeddings

`domain/matching.ts` runs preview's extract → retrieve → judge workflow (`previewSubmission`); `MATCH_THRESHOLD` (0.6, tuned by task 03), `CANDIDATE_LIMIT` (8), and `MAX_MATCHES` (3) live there. Any AI step failing with `ai_unavailable` degrades to `ai: "unavailable"` with no matches. `previewId` is a deterministic hash of the text (no preview state is stored); `submit_signal` records it in the `signal.created` payload.

Only needs with an embedding are candidates. `submit_signal` embeds a new draft need's statement (left null if the embedder is down). **When you change a need's statement or create a need** (resolve_suggestion edits, split_need), call `embedNeeds(db, ctx.ai.embedder, [needId])` from `domain/embeddings.ts` after the write commits (or in `after()`). `pnpm db:embed` (`--test` for `DATABASE_URL_TEST`) backfills every live need without an embedding via `embedMissingNeeds`; it is idempotent and needs Gateway access.

Submissions (`domain/submissions.ts`): a merged-away `target.needId` lands on the live need; the submitter is upserted by lowercased email (a known `company` links its account; an unknown one creates an `Unknown`-plan account); a reused `idempotencyKey` with different content is `conflict`. Tracking tokens are per submission, so `get_my_signals` shows only the signal(s) filed under that token, never all signals for an email (emails are unverified).

## Events

`recordEvent(tx, { type, actor, needId, signalId, suggestionId, payload, dedupeKey })` appends to `events`. Pass `dedupeKey` derived from the request's `idempotencyKey` so a retry counts once (`recordEvent` returns `false` for a duplicate). Failed or rolled-back requests write nothing because the event shares the transaction. Add new types to `SignalEventType`; the column is free text, so no migration is needed.

## AI ports

`ctx.ai` holds `extractor`, `embedder`, `retriever` (pgvector), `judge`, and `reasoner`. Production uses `ai/gateway.ts`: the extractor and judge are AI SDK structured output on the fast model (`gatewayExtractor({ model? })`, `gatewayJudge({ model? })`; tests inject `MockLanguageModelV4`), and the reasoner is a stub that fails with `ai_unavailable` until tasks 04 and 05 implement it. Model ids come from `lib/ai/models.ts`: `signalFastModelId()` (`SIGNAL_FAST_MODEL`, default `anthropic/claude-haiku-5.5`), `signalReasoningModelId()` (`SIGNAL_REASONING_MODEL`, default `anthropic/claude-sonnet-5.5`), and `signalEmbeddingModelId()` (`SIGNAL_EMBEDDING_MODEL`, default `openai/text-embedding-3-small`, 1536 dimensions).

`pnpm test` never calls a live model. The database harness installs `createFakeAi()`. Override per test with `configureSignalRuntime({ ai: createFakeAi({ judge: fakeJudge({ [needId]: { probability: 0.9, reason: "..." } }) }) })`, or simulate an outage with `createUnavailableAi()`. `fakeReasoner({ decision_brief: ({ prompt }) => ({...}) })` answers a reasoner task; an unhandled task fails with `ai_unavailable`. Add a task name to `ReasonerTask` when an operation needs one. Live-model checks belong in `pnpm eval`.

## Prioritization, demand, and decisions

- `domain/criteria.ts`: criteria keys, defaults (returned when `priority_criteria` is empty), `criteriaWeightsSchema` (every key, each 0–1, sum 1 ± 1e-6). A need's priority score is `Σ score × weight` (0–5).
- `domain/need-facts.ts`: Operator facts about one need (supporters, accounts and ARR, use cases, scores, trend) for model prompts; no submitter names or emails. `trendOf` holds the rising / steady / falling rule.
- `domain/demand.ts`: `get_demand_summary` numbers (SQL) plus the `demand_summary` reasoner call; any model failure gives `summary: null, ai: "unavailable"` with the numbers intact.
- `domain/priority.ts`: `suggestPriorityScores({ ai, db, now }, needId)` asks the reasoner (task `priority`) for a 0–5 score and reason per criterion and files a pending `priority` suggestion (payload `{ reason, scores, reasons }`, `suggestion.created` by `signal:ai`); a pending one for the same need is refreshed instead of duplicated. Nothing calls it yet: task 04's off-hot-path generation should call it after a signal lands.
- `domain/decisions.ts`: `draftDecisionBrief` (task `decision_brief`; demand, accounts, and value in the markdown come from the database, options and the recommendation from the model) and `publishDecision` (need status, `decisions` row with the latest accepted/edited brief, `decision.published` with the publisher as actor, one transaction). `get_my_signals` and the public need view read the `decisions` table.
- `ai/reasoning-model.ts`: `reasoningModelReasoner()`, a task-agnostic `Reasoner` on `SIGNAL_REASONING_MODEL` with structured output. `gatewayReasoner()` can delegate to it.

**Resolve hooks.** `resolve_suggestion` applies these two kinds by calling, inside its transaction and before marking the suggestion resolved (for `accept` and `edit`; `reject` applies nothing):

| Kind             | Hook                                                      | `edit` shape                                                       | Effect                                                                                                                                                               |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `priority`       | `applyPrioritySuggestion(tx, { suggestion, edit?, now })` | `priorityEditSchema`: `{ scores: { <criterion>: 0–5 }, reasons? }` | Upserts `priority_scores`: AI scores with source `ai`, scores the PM set with source `pm` (the PM override).                                                         |
| `decision_brief` | `applyDecisionBriefSuggestion(tx, { suggestion, edit? })` | `decisionBriefEditSchema`: `{ markdown }`                          | Accept: nothing else. Edit: replaces `payload.markdown` (keeps `originalMarkdown`). `publish_decision` attaches the latest accepted or edited brief to the decision. |

Both throw `validation_failed` for a malformed edit; `applyPrioritySuggestion` throws `conflict` (merged need) or `not_found`.

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
- New tables go in `lib/db/schema.ts` and in `signalTableNames` there, so the harness and the seed truncate them. Test databases get the schema automatically; Neon branches get it from `pnpm db:migrate` (Drizzle push, preceded by `CREATE EXTENSION vector`).

## Parity

`runParityTable({ operation, fixture, cases, mutates })` from `tests/signal/parity/harness.ts`:

- `fixture(db)` builds the data. Read-only tables build it once. With `mutates: true` the database is reset and the fixture rebuilt before each surface call, and ids and timestamps are normalized (`normalizeRun`) before comparing.
- Each case gives `input(fixture)` and either `expect(fixture)` (`{ output }` or `{ error: code }`) or `check(output, fixture)`, or both.
- Every case runs through REST (the real route handler, with `X-Signal-Agent` and the Operator bearer when needed), MCP (public or Operator server), and the Eve tool (Assistant or Operator). Outputs, error codes, and written events must match exactly; every surface acts as an `agent`.
- `assertNoPrivateData` in `tests/signal/support/public-needs-fixture.ts` shows how to check that public output has no PII.
- `tests/signal/registry.test.ts` checks the registry against the spec table, the input schema on every surface, Operator isolation (a probe operation proves `unauthorized` over REST and absence from public MCP, the Assistant, and OpenAPI), and that each built operation has a parity file.

## Seed

`pnpm db:seed` loads the demo workspace into `DATABASE_URL`, replacing all Signal data. `pnpm db:seed --test` seeds `DATABASE_URL_TEST` instead (run `pnpm db:test:setup` first for a new Docker database). The content (`seed/demo-data.ts`) is hand-written: 8 accounts, 4 themes, 25 needs (including the acceptance scenario's `n1` and `n2`), and 150 signals over 90 days, with merges, decisions, scores, suggestions, and their events. Ids and text come from a fixed faker seed, and dates are relative to today. Statements are embedded when the AI Gateway is reachable (`--no-embed` skips it). To extend it, add needs or fields in `demo-data.ts` and rows in `demo-workspace.ts`; `tests/signal/domain/seed.test.ts` pins the counts and N1/N2.
