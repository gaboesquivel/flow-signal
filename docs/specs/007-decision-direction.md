# 007 — Decision direction: Signal flags ready needs and recommends plan or decline against the PM's strategy

Status: implemented (2026-10-30). Amended by [0007](../decisions/0007-decision-model-on-gateway-credentials.md) (decision calls bill to the Gateway, no BYOK) and [0008](../decisions/0008-decision-model-sonnet.md) (default decision model: Sonnet 5.5; Fable 5.1 is the Crewday challenger). Amended by [010](./010-retro-remediation.md) (every model call on AI Gateway credentials; no direct provider path).

Product brief: [PRODUCT.md](../../PRODUCT.md) → Product model (Strategy), Metrics (direction accuracy, readiness lead time), Riskiest assumptions 3 and 5, Core journeys 5 and 7. Builds on [spec 001](./001-signal-mvp.md) (decision briefs, `publish_decision`, event log, `get_metrics`) and [spec 004](./004-crewday-outcome-eval.md) (Crewday worlds, PM policy, scorer).
Decisions: [0006 Decision model: Claude Fable 5.1 through the AI Gateway on our Anthropic key](../decisions/0006-decision-model-fable-gateway-byok.md) (Accepted), billing superseded by [0007](../decisions/0007-decision-model-on-gateway-credentials.md).
Related candidates: [008 Jev for closed-set classification](./008-jev-classification.md), [009 Post-submission duplicate backstop](./009-duplicate-backstop.md).

**Bet.** A recommended direction grounded in a written strategy is right often enough that PMs follow it instead of redoing the analysis (PRODUCT.md riskiest assumption 5). On Crewday, a PM who follows Signal's recommendation (and overrides it at a realistic rate) reaches decision quality ≥ 85% and better revenue coverage than the vote board, sooner.

## Problem Statement

Signal consolidates demand, but the decision step is still manual and reactive:

- A decision brief is only drafted when a PM asks for one. Nothing tells the PM which needs are ready to decide, so ready needs wait and decision latency grows.
- The brief's model sees demand, accounts, value, and a theme weight, but not the team's strategy: focus themes, revenue focus, or how much capacity is left this quarter. It cannot say "decline, this is off strategy" or "plan it, but capacity is full until Q2".
- The Crewday PM policy publishes the strategy's answer whatever the brief recommends, so spec 004 cannot tell a good recommendation from a bad one.

## Solution

- **Strategy.** A PM writes a short, versioned strategy: focus themes, a revenue focus, quarterly capacity, and the readiness line. Priority scoring and decision briefs read the current version.
- **Readiness.** After every signal (and when the strategy changes), Signal checks each live need against the readiness line. A need that crosses it is marked ready once (`need.ready`) and gets a decision brief drafted automatically, off the hot path.
- **Recommended direction.** The brief recommends a status with a confidence, says whether the need fits the strategy and why, and notes capacity. It stays a pending `decision_brief` suggestion; the PM accepts, edits, or rejects it and publishes the decision as today.
- **Decision model.** Decision tasks run on `SIGNAL_DECISION_MODEL` (default Claude Sonnet 5.5) through the AI Gateway on the Gateway's credentials ([0007](../decisions/0007-decision-model-on-gateway-credentials.md), [0008](../decisions/0008-decision-model-sonnet.md)); Fable 5.1 is the Crewday challenger.
- **Measurement.** `get_metrics` reports direction accuracy and readiness lead time. Crewday adds a PM policy that follows Signal's recommendation, next to spec 004's oracle PM, and scores direction accuracy against the strategy-implied decision.

## User Stories

1. As a PM, I want to write the team's strategy (focus themes, revenue focus, quarterly capacity, readiness line), so that scores and recommendations are judged against it.
   - Each save creates a new version; briefs record the version they used.
   - Unknown theme ids, negative capacity, or an empty readiness line are `validation_failed`.
2. As a PM, I want needs that cross the readiness line flagged with a drafted brief, so that I decide instead of hunting for what is ready.
   - A need is marked ready at most once; a merge moves readiness to the surviving need if it is ready by the same rule.
   - A brief is drafted automatically only if none is pending for the need.
   - Needs already decided or merged are never flagged.
3. As a PM, I want the brief to recommend plan or decline with a confidence and a strategy-fit reason, so that I can accept it quickly or see why to override.
4. As a PM, I want to see how often the recommendation matched what I published, so that I know whether to trust it.
5. As an agent with Operator access, I want to read the strategy, list ready needs with their recommendations, and resolve them under the same rules, so that I can do a PM's deciding work.
6. Failure: when the decision model is unavailable or declines, readiness is still recorded and the brief is retried on the next trigger; `draft_decision_brief` returns `ai_unavailable` as today. With no strategy written, readiness uses the default line and briefs say no strategy is set.
7. As the Signal team, I want Crewday to compare an oracle PM with a PM who follows Signal's recommendation, so that direction quality is measured, not assumed.

## Implementation Decisions

### Domain and schema (`lib/db/schema.ts`, `lib/signal/domain/`)

- `strategies` (id, version int unique, focus_theme_ids uuid[], revenue_focus text, capacity_per_quarter int ≥ 0, readiness_arr_cents bigint ≥ 0, readiness_supporters int ≥ 0, notes text, created_at, created_by_kind `human | agent`). Append-only; the current strategy is the highest version. At least one readiness threshold must be above 0.
- `needs.ready_at timestamptz null`.
- `domain/strategy.ts`: `getStrategy`, `setStrategy` (validates theme ids), `DEFAULT_READINESS` (used when no strategy exists; values chosen from the seeded workspace).
- `domain/readiness.ts`: `checkReadiness(ctx, needIds)` computes distinct supporting accounts' ARR and supporter count (the same query Crewday's `observeDemand` uses), sets `ready_at` and records `need.ready` (payload `{ arrCents, supporters, strategyVersion }`, `dedupeKey: need.ready:<needId>`) for needs that cross either threshold, and schedules a brief for each. Called from suggestion generation after a signal lands, after `merge_needs`, after `undo_merge`, and after `set_strategy` (for all live, undecided needs).
- Briefs: `draftDecisionBrief` adds the current strategy to the prompt and the payload. `decisionBriefDraftSchema.recommendation` gains `confidence` (0–1), `strategyFit` (`{ inFocus: boolean, reason: string }`), and `capacityNote`; the payload gains `strategyVersion` (null when none). Existing briefs without these fields still parse (new fields optional on read).
- Priority: the `strategic_fit` criterion prompt includes the strategy's focus themes and revenue focus.
- `publish_decision` writes `recommendedStatus` and `briefSuggestionId` (the need's latest accepted or edited brief, or null) into the `decision.published` payload, so metrics stay event-log only.

### Decision model ([0006](../decisions/0006-decision-model-fable-gateway-byok.md), as amended by [0007](../decisions/0007-decision-model-on-gateway-credentials.md) and [0008](../decisions/0008-decision-model-sonnet.md))

- `lib/ai/models.ts`: `DEFAULT_SIGNAL_DECISION_MODEL = "anthropic/claude-sonnet-5.5"` and `signalDecisionModelId()` (`SIGNAL_DECISION_MODEL`; set `anthropic/claude-fable-5.1` to compare). `models.test.ts` checks the id against the installed Gateway list. No BYOK: calls bill to the Gateway.
- `lib/signal/ai/reasoning-model.ts`: tasks in `DECISION_TASKS` (`decision_brief`) use the decision model with `providerOptions` = `anthropic: { effort: "medium", fallbacks: "default" }` and a 180 s timeout; every other task is unchanged. The stored suggestion `model` is the response's model id, so a refusal fallback is visible. Thinking is never set to `disabled` for decision tasks (Fable 5.1 rejects it).
- Gateway access is required (`AI_GATEWAY_API_KEY` or Vercel OIDC); there is no direct provider path ([spec 010](./010-retro-remediation.md)).

### Typed API contract (before any UI)

| Operation          | Access   | REST                            | Input → output                                                                                                                                                                                       |
| ------------------ | -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_strategy`     | operator | `GET /api/operator/strategy`    | `{}` → `{ strategy: Strategy \| null, defaults: Readiness }`                                                                                                                                         |
| `set_strategy`     | operator | `PUT /api/operator/strategy`    | `{ focusThemeIds, revenueFocus, capacityPerQuarter, readinessArrCents, readinessSupporters, notes? }` → `{ strategy, newlyReady: number }`; `validation_failed` on unknown themes or bad numbers     |
| `list_ready_needs` | operator | `GET /api/operator/needs/ready` | `{ cursor?, limit? }` → `{ needs: { needId, statement, readyAt, arrCents, supporters, brief: { suggestionId, status, recommendation } \| null }[], nextCursor }`, oldest ready first, undecided only |

`draft_decision_brief`, `resolve_suggestion`, and `publish_decision` keep their contracts; only the brief payload and the `decision.published` payload grow. `get_metrics` output gains `directionAccuracy` and `readinessLeadTime` (below). Every new operation is in the registry, so REST, Operator MCP, and the Operator agent get it through the existing adapters, and the parity suite covers it. None is on public MCP or the Assistant agent.

### MCP tools

`get_strategy`, `set_strategy`, `list_ready_needs` on the Operator MCP with the descriptions from the registry. Errors an agent acts on: `unauthorized` (no Operator secret), `validation_failed` (field-level messages), `ai_unavailable` (brief not drafted yet; readiness is still listed).

### Metrics (`lib/signal/metrics.ts`)

- **Direction accuracy:** `decision.published` events in the window whose payload `recommendedStatus` is not null; matched when it equals the published `status`. Reports `matched`, `total`, `rate`, split by publisher `actor_kind`. Retried publishes are already deduped by `dedupe_key`.
- **Readiness lead time:** median days from `need.ready` to that need's first `decision.published`, for decisions in the window; ready needs with no decision after 30 days reported separately (as decision latency does).

### Crewday (blocked on spec 004 merging to `main`)

- New PM policy option `pmPolicy: "oracle" | "follows_signal"` (default `oracle`, so spec 004's runs are unchanged) and `pPmOverride` (default 0.2, a hypothesis to sweep).
- `follows_signal`, Signal arm only: the engine calls `set_strategy` from the recipe's strategy memo at world start; each week the PM calls `list_ready_needs` instead of observing readiness itself, accepts the brief, and publishes its recommended status, except with `pPmOverride` it publishes the strategy-implied decision. The board arm keeps the oracle PM with hand briefs.
- Scorer adds direction accuracy against the strategy-implied decision and readiness lead time, beside spec 004's decision quality and revenue coverage, with the same bootstrap confidence intervals.

### Exposure

All new operations are Operator-only and fail closed without `OPERATOR_SECRET`, like the rest of the Operator surface. No public route, board view, or public MCP tool changes; supporters see decisions exactly as today. Decision calls run on AI Gateway credentials only; no Anthropic key is read ([0007](../decisions/0007-decision-model-on-gateway-credentials.md), [spec 010](./010-retro-remediation.md)). Readiness checks and auto briefs run after the response (`after()`), never on the submit hot path.

### UI

Operator console gets a strategy form and a "Ready to decide" list (need, demand, recommendation and confidence, strategy-fit reason, accept / edit / publish) built on the operations above. Layout follows `DESIGN.md` and spec 006 if it lands first.

## Testing Decisions

- **Domain tests** (`tests/signal/domain/`, real Postgres or PGlite, fake AI ports): strategy versioning and validation; readiness crossing on signal, merge, undo, and strategy change, marked once; auto brief scheduled once and skipped when one is pending; brief payload carries the strategy version and recommendation fields; old briefs still parse; `publish_decision` payload records the recommended status; direction accuracy and readiness lead time on hand-built event histories, including retries counted once, decisions without a brief excluded, and human vs. agent split.
- **Reasoner tests:** with `MockLanguageModelV4`, decision tasks use the decision model id, send no BYOK ([0007](../decisions/0007-decision-model-on-gateway-credentials.md)), send `effort` and `fallbacks`, never send disabled thinking; other tasks are unchanged.
- **Parity:** the three new operations on REST, Operator MCP, and the Operator agent; `unauthorized` without the secret; absent from public MCP.
- **Crewday:** a `follows_signal` run on the fixture world is deterministic for a seed; with `pPmOverride = 0` and an always-correct fake brief, direction accuracy is 100%; with an always-wrong fake brief, decision quality drops by the expected amount.
- Prior art: spec 001 domain and parity suites, `evals/crewday/sim/pm.ts`, `lib/signal/metrics.ts` tests.

**Acceptance scenario.**

Actor: a PM in the Operator console, then an agent over Operator MCP. Starting state: the seeded workspace (8 accounts, 4 themes, ~25 needs), no strategy written; need N7 "Ops managers need to export shift reports so that payroll closes on time" has 2 supporters from accounts totalling $180k ARR, theme Reporting.

1. The PM calls `set_strategy` with focus themes [Reporting], revenue focus "mid-market retention", capacity 3 per quarter, readiness line $250k ARR or 5 supporters → strategy version 1 is stored; `newlyReady` counts the needs already over the line; N7 is not among them.
2. A submitter from Acme ($120k ARR) adds their voice to N7 (`submit_signal`) → the response is unchanged and returns at the usual speed; after it, N7 has `ready_at` set and one `need.ready` event with `{ arrCents: 30_000_000, supporters: 3, strategyVersion: 1 }`.
3. A pending `decision_brief` suggestion for N7 exists, model `anthropic/claude-fable-5.1` (or the fallback model, recorded), recommendation `planned` with a confidence and `strategyFit.inFocus = true` citing Reporting, and `strategyVersion: 1`.
4. A second signal on N7 → no second `need.ready` event and no second pending brief.
5. An agent with Operator access calls `list_ready_needs` over Operator MCP → N7 is listed with its brief and recommendation; it calls `resolve_suggestion` accept, then `publish_decision` `planned` with note "Targeting Q1" → N7 is `planned`; the `decision.published` event carries `recommendedStatus: planned` and the brief id, actor kind `agent`.
6. The agent retries the same `publish_decision` → `conflict` or the same result; no second event.
7. `get_metrics` for this week → direction accuracy 1 matched of 1, attributed to agent; readiness lead time includes N7 (ready to decided, in days); a need decided without a brief is not in the direction-accuracy total.
8. With the Gateway unreachable, another need crosses the line → `need.ready` is recorded, no brief is stored, the need is listed with `brief: null`, and the next trigger drafts it.

## Direction changes

- [Spec 001](./001-signal-mvp.md) → Architecture and AI choices: decision briefs ran on `anthropic/claude-sonnet-5.5` (`SIGNAL_REASONING_MODEL`); they now run on `SIGNAL_DECISION_MODEL` (Claude Fable 5.1) per [0006](../decisions/0006-decision-model-fable-gateway-byok.md). Other reasoning tasks are unchanged.
- [Spec 004](./004-crewday-outcome-eval.md) → Simulation → Decisions: the oracle PM stays the default; this spec adds a `follows_signal` policy beside it. No spec 004 behaviour changes.
- `docs/INTEROP.md`: `ANTHROPIC_API_KEY` was "only used when `FLOW_ALLOW_DIRECT_ANTHROPIC=1`"; it was also sent to the AI Gateway as BYOK for decision tasks. _Superseded by [0007](../decisions/0007-decision-model-on-gateway-credentials.md) and [spec 010](./010-retro-remediation.md): no BYOK and no direct provider path._
- [PRODUCT.md](../../PRODUCT.md): Strategy, readiness, direction accuracy, readiness lead time, the per-brief guardrail, assumption 5, and journeys 5 and 7 were added on this branch (commit 065ee02).

## Out of Scope

- Jev or any classifier change to matching, merges, themes, or the readiness and plan/decline calls ([008](./008-jev-classification.md)).
- Duplicate backstop work: sweeps, multi-candidate merges, submitter follow-up, `possibleDuplicates` ([009](./009-duplicate-backstop.md)).
- Auto-publishing decisions; Signal never publishes without a PM or Operator agent action.
- Capacity planning beyond a per-quarter count (no effort roll-up, no roadmap view).
- Multiple strategies per workspace or per team.
- Stakeholder updates.

## Further Notes

- Unknowns: whether `fallbacks: "default"` is honoured through the AI Gateway (verify in the reasoner test against a recorded Gateway request, and in one live call); Fable 5.1 latency for a brief (expected under a minute; the 180 s timeout is a ceiling); whether Fable beats Sonnet 5.5 by enough to justify ~5× the price, measured on Crewday by running `follows_signal` with each model as `SIGNAL_DECISION_MODEL`.
- Fable 5.1 requires 30-day data retention on the Anthropic account behind the key.
- The 80% direction-accuracy target, the 0.2 override rate, and the $0.25 per brief guardrail are hypotheses.

### Verification results (2026-10-30)

- **Live brief through the Gateway** (local test database, seeded workspace, strategy v1 with Reporting in focus): `anthropic/claude-fable-5.1` answered in 17 s (1,784 input, 941 output tokens, 0 thinking tokens at `effort: "medium"`), $0.065. The stored suggestion `model` was `anthropic/claude-fable-5.1`; the recommendation was `planned`, confidence 0.72, `strategyFit.inFocus: true` citing Reporting, `strategyVersion: 1`. The Gateway accepted `effort` and `fallbacks: "default"` with no warnings; honouring the fallback is unobserved because nothing was refused.
- **BYOK did not apply.** Anthropic rejected the request-scoped key ("not scoped to a workspace … must include the anthropic-workspace-id header"), and the Gateway silently answered on its own credentials. A probe showed a `headers` field on the BYOK credential reaches Anthropic for the BYOK attempt only, so `anthropicByokOptions()` now adds `anthropic-workspace-id` from `ANTHROPIC_WORKSPACE_ID`, and the reasoner warns when a decision call's BYOK attempt fails. BYOK stays unverified until the workspace id (or a workspace-scoped key) is set in `.env.local` and on Vercel; see [0006](../decisions/0006-decision-model-fable-gateway-byok.md) → Consequences.
- **`list_themes`** (Operator, `GET /api/operator/themes`) lists every theme; `/operator/decide`'s strategy form uses it instead of collecting themes from `search_needs`, so themes with no live need can be chosen.
- **Not run yet:** the live Crewday comparison (`--pm-policy follows_signal` with Fable and with `SIGNAL_DECISION_MODEL=anthropic/claude-sonnet-5.5`; estimated $17–23, plus $6–8 for a first live oracle baseline, since spec 004 recorded no live numbers) and the acceptance walkthrough. The seeded workspace has no N7 "shift reports" need; a walkthrough needs an equivalent, e.g. readiness line of 12 supporters (ARR unused) and one new supporter on "Executives need to share dashboard snapshots …" (Reporting, 11 supporters), which leaves `newlyReady` at 0. The 0006 default stands until the Crewday numbers exist.
