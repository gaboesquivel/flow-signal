# 004 — Crewday outcome eval: prove Signal moves the core metrics against a vote board

Status: draft (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Metrics, Riskiest assumptions. Builds on [spec 001](./001-signal-mvp.md) (operation registry, event log, `get_metrics`, matching eval).
Decisions: [0004 Simulated customer world with scripted behaviour as the outcome eval](../decisions/0004-simulated-world-outcome-eval.md) (Proposed).

**Bet.** Given a realistic, independently labeled year of customer demand, Signal (driven through its REST, MCP, and agent surfaces) raises prevention rate and shortens decision latency against a plain vote board, with PMs accepting its suggestions, and without breaking a guardrail. If Signal does not clearly beat the board in a world we control, it will not beat it with real users.

## Problem Statement

We claim Signal stops duplicates at submission, keeps customer context, and moves PMs from organizing to deciding. We cannot show any of it yet:

- **No baseline.** PRODUCT.md lists every MVP metric's baseline as "unknown". A 50% prevention rate means nothing until it is compared with what a plain vote board gets on the same demand.
- **Only matching is measured, and it is saturated.** `evals/matching` (131 cases, 30-need catalog) scores precision@3 0.99 and new-need recall 1.0. It can no longer separate a better build from a worse one. The same process wrote its cases and its labels, and its catalog is the seed's.
- **The outcome metrics are untested.** Prevention rate, decision latency, and suggestion acceptance only exist on seeded history that was written to make them non-empty. Nothing shows that the product's mechanism produces them.
- **PRODUCT.md's prevention rate can flatter us.** It counts only duplicates that were later merged. Duplicates nobody noticed never enter the denominator, so missing them looks like success.
- **Agents are tested for tool choice, not outcomes.** Spec 001's agent evals check that the right operation is called. They do not check that an agent working for a customer or a PM reaches the same result a careful human would.

## Solution

**Crewday** is a fictional mid-market B2B SaaS company (workforce scheduling for frontline teams) that uses Signal for its feature requests. We build one year of Crewday's customer demand as a frozen, versioned **world**: accounts, personas, true needs, and every signal with its hidden ground truth. We then replay that world through Signal in simulated time. Scripted **policies** act as submitters and the PM, and they read the hidden ground truth plus tunable noise. Each run scores the outcomes with Signal's own `get_metrics` and with ground-truth metrics that Signal cannot see.

The same world and policies also run against a **vote-board arm**: the same registry and event log, but with keyword search in place of AI matching and no AI suggestions. The difference between the two arms is Signal's lift. Runs are versioned, kept in an append-only history, and compared over time, so a change to prompts, models, or thresholds shows up as a change in business outcomes, not only in matching precision.

There is no UI. Everything runs through operations over REST, MCP, and the Eve agents.

## User Stories

1. As the Signal team, we want to run `pnpm eval:crewday` and get prevention rate, decision latency, suggestion acceptance, and the guardrails for Signal and the vote board side by side, so that every claim in PRODUCT.md → Metrics has a measured baseline.
2. As the Signal team, we want a held-out test split that is never used for tuning, so that improvements over time are real and not overfitting to the world.
3. As the Signal team, we want each tagged run appended to a history with its world version, git SHA, models, and policy parameters, so that we can see whether a change moved business outcomes and by how much.
4. As the Signal team, we want results reported across a sweep of submitter and PM behaviour, so that we know which conclusions hold however people behave and which depend on our assumptions.
5. As the Signal team, we want ground-truth metrics Signal cannot observe (duplicates left behind, wrong attachments, priority agreement), so that over-eager matching or rubber-stamping cannot inflate the headline metrics.
6. As the Signal team, we want part of the world submitted by the Eve Assistant agent over public MCP and part triaged by the Operator agent over Operator MCP, so that agent journeys are judged by outcomes and attributed separately in `get_metrics`.
7. As the Signal team, we want planted failure cases (validation failures, idempotent retries, PII in signal bodies), so that a run also proves metrics count correctly and public summaries never leak identifying details.

## Implementation Decisions

### Layout

```
evals/crewday/
  world/v1/            frozen fixtures, committed (JSON): accounts, personas, themes, needs, signals, strategy
  generate/            world generation scripts (run once per world version; never during an eval)
  sim/                 discrete-event engine, policies, arms, surface router
  score/               ground-truth metrics, get_metrics cross-check, guardrails, report
  history/             append-only summaries of tagged runs (small JSON, committed)
  results/             full run reports (gitignored), like evals/matching/results
```

### The world (`crewday@v1`)

Crewday is one Signal workspace, matching PRODUCT.md's single organization. Target sizes:

| Element  | v1 size | Notes                                                                                                                                                                                                           |
| -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts | ~40     | Starter, Growth, and Enterprise, with ARR and open deals in a realistic long tail (a few accounts hold most revenue); some churn-risk and some in-flight deals                                                  |
| Personas | ~200    | Ops admins, shift managers, frontline staff, HR and payroll, IT and security, CSMs and sales reps filing for an account, and agents (a support copilot over public MCP, a PM assistant over Operator MCP) |
| Themes   | 6       | For example Scheduling, Time and attendance, Payroll and exports, Compliance, Integrations, Mobile                                                                                                            |
| Needs    | ~120    | Hand-written in "who needs to do what so that outcome" form, each with an arrival curve (steady, bursty after an incident, seasonal, late-emerging) and a true priority                                          |
| Signals  | ~1,500  | 12 months; each carries its hidden labels                                                                                                                                                                       |

**Hard cases are planned, not incidental.** About 20 deliberate traps among the needs:

- Shared solution, different need ("payroll CSV export for accountants" vs. "payroll CSV export for union audits").
- Near-neighbours that differ only in who or why.
- One need that splits into two over the year.
- A need that is only ever described as a symptom ("the app is useless on Sundays").

Among the signals: two-ask submissions, vague complaints, typos and non-native English, sales reps filing for a prospect, the same person filing twice, and planted PII (names, phone numbers, employee IDs) that must never reach a public summary.

**Ground truth per signal:** true need key (or keys, for a multi-ask), whether it is the need's first occurrence, persona, account, timestamp, channel (`web | mcp`), actor kind, and whether a use case is present. **Ground truth per need:** theme, true priority rank, and the decision Crewday's strategy implies. The strategy is a short hidden memo with themes, a revenue focus, and capacity, written before the signals.

**Generation, layered so no layer grades itself:**

1. People hand-write the needs, traps, accounts, personas, and strategy memo.
2. A model from a different family than Signal's runtime models generates the signal text, writing from each need in a persona's voice. Each label exists by construction, before the text is written.
3. A stratified sample is reviewed (weighted toward traps), and any signal that drifted from its label is fixed or dropped. _Open: who reviews and how much; see Further Notes._
4. The world is frozen as `world/v1`. Any change to the world is a new version (`v2`), never an edit in place. Generation scripts record model ids, prompts, and RNG seeds.

**Splits:** needs are split 50/50 into `dev` and `test` by stratified random assignment. A need's signals go wherever the need goes. Tuning (prompts, thresholds, policies) uses `dev` only. `test` runs only for tagged reports, and its per-case details stay out of anything a tuning run reads.

### Simulation

A discrete-event engine replays the world in timestamp order, in simulated time, through `configureSignalRuntime({ clock, db, ai })` (`lib/signal/runtime.ts`). This is the seam the parity suite already uses. Operations run unchanged, so every `created_at`, decision date, and event carries world time.

**Submitter policy** (per signal, oracle + noise):

1. `preview_signal` with the signal's title and body.
2. If a shown match is the signal's true need → attach with probability `p_attach` (default 0.8). Otherwise submit new.
3. If a shown match is wrong and no correct match is shown → attach to it anyway with probability `p_wrong` (default 0.1). This models a submitter accepting a plausible but wrong match.
4. `submit_signal` with `target.needId` or `target.newNeed`, the use case when the ground truth has one, and an `idempotencyKey`.

**PM policy** (on a weekly cadence, with a time budget):

- Each action costs simulated PM minutes (reading a raw signal, finding and doing a manual merge, reviewing a suggestion, writing a brief by hand, reviewing a drafted brief). The weekly budget is `pm_hours` (default 6). Costs and budget are named parameters, not facts.
- **Triage:** `list_suggestions`, then `resolve_suggestion`. Accept when the suggestion agrees with ground truth (a merge of two needs with the same true need; a draft statement graded ≥ 4; a priority score within one point of the true priority; a theme matching the true theme). Edit when partly right. Reject otherwise. Noise: `p_pm_error` (default 0.05) flips the verdict.
- **Manual dedup:** while budget remains, the PM finds duplicates the AI did not propose with probability `p_manual_find` per week and merges them with `merge_needs`. This is the only dedup path in the vote-board arm.
- **Decisions:** a need is decided once its consolidated demand or priority crosses the policy's readiness rule and the PM has budget for a brief (drafted with `draft_decision_brief` and reviewed, or written by hand in the vote-board arm). The decision then goes out through `publish_decision`. The same rule applies to both arms, so the latency difference comes only from consolidation and saved PM time.

**Behaviour sweep:** every report runs the default policy plus a grid over `p_attach ∈ {0.5, 0.8, 0.95}`, `p_wrong ∈ {0.05, 0.2}`, and `pm_hours ∈ {3, 6, 12}`. It states which conclusions hold across the grid. A conclusion that holds only at the defaults is labeled as depending on assumptions.

### Arms

Both arms use the same registry, database schema, event log, and `get_metrics`. Only the AI ports differ.

- **Signal:** production AI ports (Gateway extract, embed, judge, reasoner) and suggestion generation.
- **Vote board:** a `boardAi` port set in `evals/crewday/sim`. Preview returns `search_needs`-style keyword results for the title (top 3, no reasons, no probability). No draft-statement drafting, so the submitter's title becomes the statement. No merge, theme, priority, summary, or brief suggestions. This is PRODUCT.md's "plain vote board" comparison, built on the same plumbing so the comparison is fair.
- **Previous Signal:** the history makes the last tagged Signal run the third comparison. No separate arm is needed.

### Surfaces and agents

Persona channel decides the surface, so each run exercises all three:

- Web personas go through the REST route handlers in-process (as in `tests/signal/parity/harness.ts`).
- Support-copilot personas go through the public MCP route.
- The PM loop alternates by week between REST and Operator MCP.

`actor_kind` and `agent_client` follow the surface, so `get_metrics` splits human and agent counts as spec 001 defines.

**Agent sub-run** (live models, sampled to bound cost): about 100 test-split signals are handed to the Eve **Assistant** agent as a natural-language instruction ("Maria from Harbor Logistics says … file this for her"). Four weeks of PM triage are handed to the Eve **Operator** agent with the strategy memo as its instruction. They are scored on outcomes:

- The Assistant called `preview_signal` before `submit_signal`, chose the true need when it was shown, kept the customer's words and use case, and called no Operator tool.
- The Operator agent's resolutions agree with ground truth at least as often as the scripted PM policy does.

### Metrics reported

Per arm, per split, per behaviour setting, and human vs. agent where `get_metrics` splits:

| Metric                        | Source                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prevention rate (PRODUCT.md)  | `get_metrics` over the run, cross-checked by recomputing from `events`                                                                                                                                       |
| Decision latency              | `get_metrics`; plus needs left undecided at year end                                                                                                                                                         |
| Suggestion acceptance         | `get_metrics` by suggestion type; plus **acceptance precision** (share of accepted suggestions that ground truth says are correct)                                                                            |
| True prevention rate          | Ground truth: signals on an already-existing true need that ended attached to it ÷ all such signals. This includes duplicates nobody merged, which PRODUCT.md's formula cannot see                          |
| Hidden duplicate rate         | Ground truth: live needs at year end that share a true need with another live need ÷ live needs                                                                                                              |
| False attach rate             | Ground truth: signals attached to a need that is not their true need                                                                                                                                         |
| Context rate                  | Signals with the submitter's use case                                                                                                                                                                        |
| Priority agreement            | Spearman correlation between Signal's priority ranking and the world's true priority, over decided and open needs                                                                                            |
| PM time                       | Simulated PM minutes spent organizing (reading, merging) vs. deciding (reviewing briefs, publishing)                                                                                                         |
| Guardrails                    | Unmerge rate; PII in public summaries (planted-PII scan); p95 preview latency; model spend per signal                                                                                                        |

### Success criteria (proposed; hypotheses, tuned only on `dev`)

On `crewday@v1` `test`, default policy, Signal arm:

- Prevention rate ≥ 50%, at least **20 points above** the vote board. True prevention rate also beats the board by at least 20 points.
- Hidden duplicate rate at most half the board's.
- Decision latency median ≤ 0.5× the board's. PM organizing time ≤ 0.5× the board's.
- Suggestion acceptance ≥ 70%, with acceptance precision ≥ 95%. High acceptance with low precision is rubber-stamping and fails.
- Guardrails: false attach rate ≤ 5%, unmerge rate < 5%, zero planted PII in public summaries, p95 preview ≤ 2 s, ≤ $0.01 per signal.
- Robustness: the prevention lift and the latency lift both hold across the behaviour sweep.

**Outcome kill signal (simulated):** if the Signal arm does not beat the vote board on prevention rate by 20 points at the default policy after tuning on `dev`, the bet is flagged before any real-user pilot. This adds to PRODUCT.md's MVP kill criterion and does not replace it.

### Reproducibility and cost

- The world is committed and versioned, and policies run on a seeded RNG. Two runs with the same world, seed, git SHA, and models differ only by model non-determinism.
- Dev runs may replay AI responses from a local cache keyed by model, prompt hash, and input (`--cached`). Tagged `test` runs are always live and repeated 3 times; the report gives the mean and range.
- The full world in both arms with the default policy is budgeted at about $5 of model spend. The sweep reuses Signal's matching results where the behaviour change does not alter AI inputs. _Assumption; the first run measures it._
- Never in CI (spec 001's CI policy). `pnpm test` gets only an offline smoke: a 50-signal slice with fake AI ports on PGlite, asserting the engine is deterministic and the scorer recomputes `get_metrics` exactly.

### Commands

- `pnpm eval:crewday`: dev split, Signal and vote-board arms, default policy, report to `evals/crewday/results/latest.json` and a terminal table.
- Flags: `--split dev|test`, `--arm signal|board|both`, `--sweep`, `--agents` (the live agent sub-run), `--cached`, `--seed`, `--tag <name>` (test split only; appends to `history/`).
- Joins `pnpm eval` with the dev split and `--cached`. It skips with a clear message when AI Gateway access is missing, as `eval:matching` does.

**Exposure:** none. This adds eval code and fixtures only, with no route, operation, or deployable behaviour. The runner writes only to a test database: local Docker or PGlite per [0003](../decisions/0003-local-test-databases.md). It refuses to start when its database URL is the `DATABASE_URL` from `.env.local` or any Neon `main` or dev branch.

### Relation to `evals/matching`

`evals/matching` stays as the fast component eval and the MVP kill criterion. The world's ~120-need catalog and traps also feed a harder matching set (`--component matching`) that reports precision@3, false-match rate, and new-need recall on `test`, so matching quality can move again. Retiring or rebasing `evals/matching` is a later decision.

## Testing Decisions

- A good test here checks an outcome against hidden ground truth, through the same operations a real user or agent calls. It never checks internal calls.
- **Offline (in `pnpm test`):**
  - The engine replays a fixed slice deterministically with fake AI ports.
  - The scorer's recomputation from `events` equals `get_metrics` for the same window.
  - Planted retries are counted once, and planted validation failures are not counted.
  - The vote-board port never emits a suggestion.
  - The runner refuses a non-test database.
- **Live (`pnpm eval:crewday`):** the metrics table and success criteria above. Prior art: `evals/matching/run.ts` (runner, threshold sweep, cost meter, skip without the Gateway), `tests/signal/parity/harness.ts` (in-process surfaces with runtime overrides), and `scripts/acceptance-mcp.mjs` (MCP journey).

**Acceptance scenario.** Actor: a Signal engineer. Starting state: a fresh local test database, `crewday@v1` committed, and AI Gateway access.

1. `pnpm eval:crewday --split test --arm both --tag v1-baseline` → the run creates the Crewday workspace (40 accounts, 6 themes, the first week's needs) and replays 12 months. The progress log shows simulated weeks and the surface mix (REST, public MCP, Operator MCP).
2. The report prints both arms side by side: prevention rate, true prevention rate, hidden duplicate rate, false attach rate, decision latency, suggestion acceptance and acceptance precision, PM time, and guardrails, each marked pass or fail against the success criteria.
3. Metrics count correctly: for one simulated week, the scorer's recomputation from `events` equals `get_metrics`. A planted signal sent twice with the same `idempotencyKey` is counted once. A planted submission that failed validation is not counted. Signals filed by the support copilot over public MCP appear under agent, not human.
4. The report lists the planted-PII signals and confirms none of their identifying details appear in any approved public summary.
5. `evals/crewday/history/` gains one entry with the world version, split, git SHA, model ids, policy parameters, seed, and per-metric mean and range over 3 repeats.
6. Re-running `pnpm eval:crewday --split dev --cached --seed 1` twice gives identical reports.

**Same journey through agents.** `pnpm eval:crewday --split test --agents`:

1. The Eve Assistant agent receives about 100 test-split customer requests in natural language and files them over the public MCP tools. For each one, it called `preview_signal` before `submit_signal`, chose the true need when it was shown, and kept the customer's use case. Zero Operator tools were called.
2. The Eve Operator agent runs four simulated weeks of triage over Operator MCP with the strategy memo. Its resolutions agree with ground truth at least as often as the scripted PM policy's, and its decisions are attributed `published_by_kind = agent` in `get_metrics`.

## Out of Scope

- Any UI, including a results dashboard. Reports are JSON and terminal tables.
- Real customer data, a real Crewday, or any production database.
- Competitor-style embedding-only dedupe as a third arm. It is a candidate once the vote-board comparison holds.
- Validating riskiest assumption 1 (real submitters' willingness to add their voice). The simulation assumes behaviour and sweeps it. Only real users can confirm it.
- Replacing `pnpm db:seed`'s demo workspace with Crewday. Seeding the demo from the world is a later option.
- Ingestion (spec 002) and notifications (spec 003) inside the simulation.
- Running evals in CI.

## Further Notes

**What the simulation can and cannot prove.** It proves that Signal, given demand like Crewday's and people who behave within the swept ranges, produces the outcomes PRODUCT.md promises better than a vote board. It can falsify the product mechanism cheaply. It cannot prove that people behave as the policies assume. The sweep exists so we can say how much each conclusion depends on that.

**Open assumptions**

- **Crewday's domain** (workforce scheduling, mid-market, frontline teams) is a guess; Crewday is only confirmed as fictional.
- **The human review of generated signals** is not decided: who reviews, and what share (proposed 10%, weighted to traps, about 150 signals). The alternative is cross-family model review that flags disagreements, which is cheaper but not independent.
- **The generator model family** is not chosen. The requirement is only that it is not one of Signal's runtime models.
- **Policy defaults** (`p_attach` 0.8, `p_wrong` 0.1, `pm_hours` 6, action costs) and the decision readiness rule are hypotheses. The sweep bounds them.
- **Success thresholds** (+20 points prevention, 0.5× latency, ≥ 95% acceptance precision) are proposals.
- **The run budget** (about $5 per full run, plus the agent sub-run) is unmeasured.
- **PRODUCT.md additions on acceptance:** add true prevention rate, hidden duplicate rate, and acceptance precision under Supporting metrics, and the simulated outcome kill signal under Kill criterion. These add to PRODUCT.md; they do not reverse anything.
