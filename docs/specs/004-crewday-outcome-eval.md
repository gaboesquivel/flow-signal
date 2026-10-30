# 004 — Crewday outcome eval: prove Signal moves the core metrics against a vote board

Status: accepted (2026-10-30). Amended by [007](./007-decision-direction.md) (adds a `follows_signal` PM policy beside the oracle PM; no change to existing runs).

Product brief: [PRODUCT.md](../../PRODUCT.md) → Metrics, Riskiest assumptions. Builds on [spec 001](./001-signal-mvp.md) (operation registry, event log, `get_metrics`, matching eval). Agent outcome runs on the same worlds: [spec 005](./005-agent-outcome-eval.md) (candidate).
Decisions: [0004 Simulated customer world with scripted behaviour as the outcome eval](../decisions/0004-simulated-world-outcome-eval.md) (Accepted).

**Bet.** Given a realistic, independently labeled year of customer demand, Signal (driven through its REST and MCP surfaces) produces more consolidated demand and better, faster decisions on the revenue that matters than a plain vote board does, without breaking a guardrail. If Signal does not clearly beat the board in a world we control, it will not beat it with real users.

## Problem Statement

We claim Signal stops duplicates at submission, keeps customer context, and moves PMs from organizing to deciding. We cannot show any of it yet:

- **No baseline.** PRODUCT.md lists every MVP metric's baseline as "unknown". A 50% prevention rate means nothing until it is compared with what a plain vote board gets on the same demand.
- **Only matching is measured, and it is saturated.** `evals/matching` (131 cases, 30-need catalog) scores precision@3 0.99 and new-need recall 1.0. It can no longer separate a better build from a worse one. The same process wrote its cases and its labels, and many submissions reuse their need's wording.
- **The outcome metrics are untested.** Prevention rate, decision latency, and suggestion acceptance only exist on seeded history that was written to make them non-empty. Nothing shows that the product's mechanism produces them.
- **Speed is measured, quality is not.** Decision latency rewards fast decisions whether or not they are right, and nothing weights outcomes by the revenue behind them.
- **PRODUCT.md's prevention rate can flatter us.** It counts only duplicates that were later merged. Duplicates nobody noticed never enter the denominator, so missing them looks like success.

## Solution

**Crewday** is a fictional mid-market B2B SaaS company (workforce scheduling for frontline teams) that adopts Signal for its feature requests. We build Crewday's world from a written recipe and generate it twice:

- `crewday-dev`, for tuning.
- `crewday-test`, held out and used only for tagged runs.

Each is a full year of demand with its own accounts, needs, and signals, all carrying hidden ground truth. Each is frozen and versioned.

We replay a world through Signal in simulated time. Scripted **policies** act as submitters and the PM, reading the hidden ground truth and making tunable errors. A run scores the outcomes two ways: with Signal's own `get_metrics`, and with ground-truth metrics Signal cannot see. These cover consolidation, decision quality, and revenue-weighted coverage.

The same world and policies also run against a **vote-board arm**. It uses the same registry and event log, but keyword search replaces AI matching and there are no AI suggestions. The difference between the two arms is Signal's lift, reported with confidence intervals. Later slices add a behaviour sweep and a run history, so changes to prompts, models, or thresholds show up as measured changes in business outcomes.

There is no UI. Everything runs through operations over REST and MCP.

## User Stories

1. As the Signal team, we want to run `pnpm eval:crewday` and see consolidation, decision quality, revenue coverage, PRODUCT.md's three metrics, and the guardrails for Signal and the vote board side by side, each with a confidence interval, so that every claim in PRODUCT.md → Metrics has a measured baseline.
2. As the Signal team, we want a held-out test world that is never used for tuning, so that improvements are real and not overfitting.
3. As the Signal team, we want each tagged run kept with its world version, git SHA, models, and policy parameters, and a change called an improvement or regression only when its interval clears the previous run's, so that we track progress without chasing noise.
4. As the Signal team, we want results across a sweep of submitter and PM behaviour, so that we know which conclusions hold however people behave.
5. As the Signal team, we want ground-truth metrics Signal cannot observe (duplicates left behind, wrong attachments, decisions that contradict strategy), so that over-eager matching or rubber-stamping cannot inflate the headline metrics.
6. As the Signal team, we want each report to state how much of the world keyword search alone can solve, so that we know the world is hard enough to be worth winning.
7. As the Signal team, we want planted failure cases (validation failures, idempotent retries, PII in signal bodies), so that a run also proves metrics count correctly and public summaries never leak identifying details.

## Implementation Decisions

### Layout

```
evals/crewday/
  recipe/              the hand-written world recipe: company, strategy memo, account and persona mix,
                       theme list, trap patterns, arrival curves (shared by both worlds)
  worlds/dev/v1/       frozen fixtures, committed (JSON)
  worlds/test/v1/      frozen fixtures, committed (JSON); never read by tuning code
  generate/            world generation scripts (run once per world version; never during an eval)
  sim/                 discrete-event engine, policies, arms, surface router
  score/               ground-truth metrics, get_metrics cross-check, intervals, guardrails, report
  history/             append-only summaries of tagged runs (small JSON, committed)
  results/             full run reports (gitignored), like evals/matching/results
```

### The worlds (`crewday-dev@v1`, `crewday-test@v1`)

Crewday is one Signal workspace, matching PRODUCT.md's single organization. Both worlds follow the same recipe and have the same shape. They share no needs, accounts, or personas, so neither world's labels can leak into the other. Target sizes per world:

| Element          | v1 size                 | Notes                                                                                                                                                                                                      |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts         | ~40                     | Starter, Growth, and Enterprise, with ARR and open deals in a realistic long tail (a few accounts hold most revenue); some churn-risk and some in-flight deals                                             |
| Personas         | ~200                    | Ops admins, shift managers, frontline staff, HR and payroll, IT and security, and CSMs and sales reps filing for an account; some file through a support copilot over public MCP                           |
| Themes           | 6                       | For example Scheduling, Time and attendance, Payroll and exports, Compliance, Integrations, Mobile                                                                                                         |
| Migrated backlog | ~40                     | Needs that exist at day 0, imported as Crewday's old spreadsheet would have them: inconsistent wording, solution-named titles, and about 8 duplicate pairs                                                 |
| Needs            | ~120                    | Includes the backlog's true needs; hand-written in "who needs to do what so that outcome" form, each with an arrival curve (steady, bursty after an incident, seasonal, late-emerging) and a true priority |
| Signals          | ~600 (v1; ~1,500 later) | 12 months after adoption; each carries its hidden labels                                                                                                                                                   |

**Starting state.** The run begins by loading the migrated backlog through operations as approved needs, duplicates included, then turns on Signal. This reflects how a real customer adopts the product and gives both arms the same messy start. Merging the backlog's duplicates is part of the PM's work.

**Hard cases are planned, not incidental.** About 20 deliberate traps per world. Trap pairs and their counterparts always stay inside one world:

- Shared solution, different need ("payroll CSV export for accountants" vs. "payroll CSV export for union audits").
- Near-neighbours that differ only in who or why.
- One need that splits into two over the year.
- A need that is only ever described as a symptom ("the app is useless on Sundays").

Among the signals: two-ask submissions, vague complaints, typos and non-native English, sales reps filing for a prospect, the same person filing twice, and planted PII (names, phone numbers, employee IDs) that must never reach a public summary.

**Ground truth per signal:** true need key (or keys, for a multi-ask), whether the true need already existed at that time, persona, account, timestamp, channel (`web | mcp`), and actor kind. **Ground truth per need:** theme, true priority rank, and the decision Crewday's strategy implies (`planned | declined`, and by when). The strategy is a short hidden memo in the recipe, written before any signal: themes, a revenue focus, and quarterly capacity.

**Generation, layered so no layer grades itself or leaks the answer:**

1. People hand-write the recipe: needs, traps, backlog, accounts, personas, and the strategy memo.
2. A model from a different family than Signal's runtime models writes each signal from a **persona and a scenario**: who they are, what went wrong at work that week, and optionally a solution they have in mind. It never sees the need statement. The label is attached by construction before the text exists.
3. **Leakage check:** for every signal, rank the world's needs by keyword search (the vote-board arm's retriever) on the signal's title and body. The **keyword-findable share** is the share whose true need ranks first. The world is rejected and regenerated if more than 60% of signals that should match an existing need are keyword-findable (at least 40% must need meaning, not words). Every report prints this share.
4. A stratified sample is reviewed (weighted toward traps), and any signal that drifted from its scenario's need is fixed or dropped. _Open: who reviews and how much; see Further Notes._
5. Each world is frozen. Any change is a new version (`v2`), never an edit in place. Generation scripts record model ids, prompts, and RNG seeds.

### Simulation

A discrete-event engine replays a world in timestamp order, in simulated time, through `configureSignalRuntime({ clock, db, ai })` (`lib/signal/runtime.ts`). This is the seam the parity suite already uses. Operations run unchanged, so every `created_at`, decision date, and event carries world time.

**Submitter policy** (per signal, oracle + noise):

1. `preview_signal` with the signal's title and body.
2. If a shown match is the signal's true need → attach with probability `p_attach` (default 0.8). Otherwise submit new.
3. If a shown match is wrong and no correct match is shown → attach to it anyway with probability `p_wrong` (default 0.1). This models a submitter accepting a plausible but wrong match.
4. `submit_signal` with `target.needId` or `target.newNeed`, the use case the generator wrote, and an `idempotencyKey`.

**PM policy** (weekly cadence and a weekly action budget). The policy never consults a model.

- **Budget.** The PM has `pm_actions` per week (default 60). Every PM operation call costs one action, and so does reading one raw signal. Organizing actions (reads, manual merges, splits) and deciding actions (brief review, publish) are counted separately. Counting actions instead of minutes keeps the latency result from resting on invented time costs.
- **Triage:** `list_suggestions`, then `resolve_suggestion`, judged only by ground truth:

  | Suggestion     | Accept when                                                                | Edit when                                                   |
  | -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
  | Draft need     | its statement's nearest need in the world recipe is the signal's true need | it names the right need's solution but the wrong who or why |
  | Merge          | both needs share a true need                                               | (never edited)                                              |
  | Theme          | it equals the true theme                                                   | (never edited)                                              |
  | Priority score | it is within one point of the true priority                                | it is two points off                                        |
  | Public summary | it names no persona, email, account, or planted PII                        | (never edited)                                              |
  | Split          | the moved signals share one main true need that is not the need's own      | (never edited)                                              |
  | Decision brief | its recommended status matches the strategy-implied decision               | the recommendation cannot be read                           |

  Everything else is rejected. Noise: `p_pm_error` (default 0.05) flips the verdict. "Nearest need in the recipe" is an embedding lookup against hand-written statements, not a judgment by a grading model. The need-statement rubric stays a separately reported metric.

- **Manual dedup:** while budget remains, the PM reads raw signals and finds duplicates the AI did not propose with probability `p_manual_find` per read, then merges them with `merge_needs`. This is the only dedup path in the vote-board arm, and it covers the backlog's duplicates in both arms.
- **Decisions:** a need becomes ready when its consolidated supporters, weighted by account ARR, cross the policy's readiness line. A ready need is decided when the PM has budget for a brief (drafted with `draft_decision_brief` and reviewed, or written by hand in the vote-board arm). The verdict follows the decision Crewday's strategy implies, with `p_pm_error` noise. In the Signal arm the PM sees Signal's priority score and suggested direction. In the board arm the PM sees vote counts, so a fragmented need looks smaller than it is. The same rules apply to both arms, so the differences come only from consolidation, the information shown, and the actions saved.

### Arms

Both arms use the same registry, database schema, event log, and `get_metrics`. Only the AI ports differ.

- **Signal:** production AI ports (Gateway extract, embed, judge, reasoner) and suggestion generation.
- **Vote board:** a `boardAi` port set in `evals/crewday/sim`. Preview returns `search_needs`-style keyword results for the title (top 3, no reasons, no probability). No draft-statement drafting, so the submitter's title becomes the statement. No merge, theme, priority, summary, or brief suggestions. This is PRODUCT.md's "plain vote board" comparison, built on the same plumbing so the comparison is fair.

### Surfaces

Persona channel decides the surface, so each run exercises REST and both MCP servers:

- Web personas go through the REST route handlers in-process (as in `tests/signal/parity/harness.ts`).
- Personas filing through a support copilot go through the public MCP route as `actor_kind = agent`, called by the scripted policy.
- The PM loop alternates by week between REST and Operator MCP.

`get_metrics` splits human and agent counts as spec 001 defines. Live Eve agents acting on these worlds are [spec 005](./005-agent-outcome-eval.md).

### Metrics reported

Per arm and per world, with 95% bootstrap confidence intervals (resampling needs, 1,000 resamples):

**Business outcomes (headline)**

| Metric               | Definition                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| True prevention rate | Signals whose true need already existed and that ended attached to it (at submission or through a later merge) ÷ all such signals. Includes duplicates nobody merged |
| Decision quality     | Published decisions that match the strategy-implied decision ÷ published decisions                                                                                   |
| Revenue coverage     | ARR of requesting accounts on needs that got a correct decision within 60 days of becoming ready ÷ ARR of requesting accounts on all needs that became ready         |
| Close-the-loop rate  | Signals whose submitter can see a published decision through `get_my_signals` ÷ signals on decided true needs (merged duplicates count only if their signals moved)  |
| PM organizing share  | Organizing actions ÷ all PM actions                                                                                                                                  |

**PRODUCT.md metrics**

| Metric                | Source                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prevention rate       | `get_metrics`, cross-checked by recomputing from `events`; reported by quarter, since early quarters are low while the catalog fills                  |
| Decision latency      | `get_metrics`; plus needs left undecided at year end. _Depends on the PM policy's readiness line and budget; read it as relative to the board_        |
| Suggestion acceptance | `get_metrics` by suggestion type (Signal arm only); plus **acceptance precision**: accepted suggestions that ground truth says are correct ÷ accepted |

**Diagnostics and guardrails**

- Hidden duplicate rate: live needs at year end that share a true need with another live need ÷ live needs.
- False attach rate: signals attached to a need that is not their true need.
- Priority agreement: Spearman correlation between Signal's priority ranking and the true priority.
- Need-statement rubric (model grader, as in `evals/matching`; reported, never used by a policy).
- Keyword-findable share of the world.
- Unmerge rate.
- Planted-PII scan of approved public summaries.
- Model spend per signal.
- Preview latency p50 and p95. _Reported only: in-process replay does not measure production latency, and the 2 s gate stays in `evals/matching`._

**Not measured here, and stated in every report:**

- Context rate. It repeats what the generator wrote, so it only means something for live agents (spec 005) and real users.
- Submitters' willingness to add their voice (riskiest assumption 1). The policy assumes it.

### Success criteria (proposed; hypotheses, tuned only on `crewday-dev`)

On `crewday-test`, default policy, Signal arm vs. vote board. A criterion passes only when its whole 95% interval clears the bar:

- True prevention rate at least **20 points above** the board.
- Decision quality ≥ 85% and not more than 5 points below the board (non-inferiority: the paired interval's lower bound of Signal − board is at least −5 points).
- Revenue coverage at least **1.5×** the board's.
- PM organizing share at most **half** the board's.
- Suggestion acceptance ≥ 70% with acceptance precision ≥ 95%. High acceptance with low precision is rubber-stamping and fails.
- Guardrails: false attach rate ≤ 5%, unmerge rate < 5%, zero planted PII in generated public summaries (every `public_summary` suggestion, whatever the PM did with it; approved summaries are reported as a second line), ≤ $0.01 model spend per signal.
- The world itself is valid: keyword-findable share ≤ 60%.

**Outcome kill signal (simulated):** if the Signal arm does not beat the vote board on true prevention rate by 20 points at the default policy after tuning on `crewday-dev`, the bet is flagged before any real-user pilot. This adds to PRODUCT.md's MVP kill criterion and does not replace it.

### Reproducibility, history, and cost

- Worlds are committed and versioned, and policies run on a seeded RNG. Two runs with the same world, seed, git SHA, and models differ only by model non-determinism.
- Tagged runs on `crewday-test` repeat 3 times with different seeds. History entries store each metric's point estimate and interval. A change counts as an **improvement** or **regression** against the previous tagged run only when the two intervals do not overlap. Otherwise it is reported as **no detectable change**.
- Dev runs may replay AI responses from a local cache keyed by model, prompt hash, and input (`--cached`). Tagged runs are always live.
- A full world in both arms at the default policy is budgeted at about $5 of model spend. _Assumption; the first run measures it._
- Never in CI (spec 001's CI policy). `pnpm test` gets only an offline smoke: a 50-signal slice with fake AI ports on PGlite.

### Commands

- `pnpm eval:crewday`: `crewday-dev`, both arms, default policy; report to `evals/crewday/results/latest.json` and a terminal table.
- Flags: `--world dev|test`, `--arm signal|board|both`, `--sweep`, `--cached`, `--seed`, `--tag <name>` (test world only; appends to `history/`), `--component matching`.
- Joins `pnpm eval` with the dev world and `--cached`. It skips with a clear message without AI Gateway access, as `eval:matching` does.

**Exposure:** none. This adds eval code and fixtures only, with no route, operation, or deployable behaviour. The runner writes only to a test database: local Docker or PGlite per [0003](../decisions/0003-local-test-databases.md). It refuses to start when its database URL is the `DATABASE_URL` from `.env.local` or any Neon `main` or dev branch.

### Delivery order

The first working run of both arms at default behaviour on the dev world answers the bet on its own (task 04). The behaviour sweep, run history, and harder matching set make that answer robust and repeatable. See Tasks.

## Testing Decisions

- A good test here checks an outcome against hidden ground truth, through the same operations a real user or agent calls. It never checks internal calls.
- **Offline (in `pnpm test`):**
  - The engine replays a fixed 50-signal slice deterministically with fake AI ports.
  - The scorer's recomputation from `events` equals `get_metrics` for the same window.
  - Planted retries are counted once, and planted validation failures are not counted.
  - The vote-board port never emits a suggestion.
  - The PM policy makes no model call.
  - Tuning entry points cannot read `worlds/test/`.
  - The runner refuses a non-test database.
- **Live (`pnpm eval:crewday`):** the metrics and success criteria above. Prior art: `evals/matching/run.ts` (runner, threshold sweep, cost meter, skip without the Gateway), `tests/signal/parity/harness.ts` (in-process surfaces with runtime overrides), and `scripts/acceptance-mcp.mjs` (MCP journey).

**Acceptance scenario.** Actor: a Signal engineer. Starting state: a fresh local test database, both v1 worlds committed, and AI Gateway access.

1. `pnpm eval:crewday --world test --arm both` → the run loads Crewday's migrated backlog (about 40 needs, including about 8 duplicate pairs) as approved needs and replays 12 months. The progress log shows simulated weeks and the surface mix (REST, public MCP, Operator MCP).
2. The report first prints the world's keyword-findable share (≤ 60%). It then prints both arms side by side, each value with its 95% interval and marked pass or fail: the headline business outcomes, PRODUCT.md's metrics (prevention rate by quarter), diagnostics, and guardrails.
3. Metrics count correctly:
   - For one simulated week, the scorer's recomputation from `events` equals `get_metrics`.
   - A planted signal sent twice with the same `idempotencyKey` is counted once.
   - A planted submission that failed validation is not counted.
   - Signals filed through the support copilot over public MCP appear under agent, not human.
4. The report lists the planted-PII signals and confirms none of their identifying details appear in any approved public summary.
5. The report lists what it does not measure (context rate, submitter willingness).
6. Re-running `pnpm eval:crewday --world dev --seed 1` with the same models gives the same world load, the same policy decisions for identical AI outputs, and the same scorer results for the same event log.

Spec 005 gives the same journey through live Eve agents over MCP.

## Tasks

- [x] 01: World format and fixture world
- [x] 02: Generate the Crewday worlds
- [x] 03: Simulation engine, policies, arms, and scorer (offline)
- [ ] 04: Signal vs. vote board on Crewday (the lift run) _(runner built and merged; live dev and test results pending)_
- [ ] 05: Behaviour sweep with cached AI responses _(deferred 2026-10-30: shipped without it for speed)_
- [ ] 06: Tagged runs, history, and the regression rule _(deferred 2026-10-30: shipped without it for speed)_
- [ ] 07: Harder matching set from the test world _(deferred 2026-10-30: shipped without it for speed)_

### 01: World format and fixture world

**What to build:** a typed, validated format for a Crewday world that the generator writes and the engine and scorer read. It covers the recipe, accounts, personas, themes, migrated backlog, needs with true priority and strategy-implied decision, and signals with their hidden labels and planted cases. A hand-written fixture world of about 50 signals in that format exercises every label kind: traps, multi-ask, backlog duplicates, planted PII, a planted retry, and a planted validation failure. It unblocks the generator and the engine at the same time.

**Area:** evals/crewday, tests

**Blocked by:** None (can start immediately)

- [ ] A world loader validates a world directory and rejects malformed or inconsistent worlds, such as a signal labeled with an unknown need, or a trap pair split across worlds.
- [ ] The fixture world loads and covers every label kind and planted case listed above.
- [ ] Tuning entry points cannot read the test world's directory, and a test proves it.

### 02: Generate the Crewday worlds

**What to build:** the written Crewday recipe and the scripts that generate `crewday-dev@v1` and `crewday-test@v1` from it. Signals are written by a non-Signal model family from persona and scenario, never from need statements. Each world is checked for keyword leakage, a stratified sample is reviewed, and both worlds are frozen and committed.

**Area:** evals/crewday, package.json

**Blocked by:** 01

- [ ] The recipe holds the company, strategy memo, account and persona mix, six themes, about 120 needs with arrival curves and true priorities, about 20 traps, and a migrated backlog of about 40 needs with about 8 duplicate pairs.
- [ ] Each world has about 40 accounts, about 200 personas, and about 1,500 signals over 12 months, and loads through task 01's loader. The two worlds share no needs, accounts, or personas.
- [ ] The generator never passes a need statement to the model. It records model ids, prompts, and RNG seeds.
- [ ] The keyword-findable share is ≤ 60% in each world and is recorded with the world.
- [ ] The stratified review is done and recorded: who reviewed, how many signals, and what was fixed or dropped. v1 uses the third-family model check described in Further Notes.

### 03: Simulation engine, policies, arms, and scorer (offline)

**What to build:** replaying any world in simulated time through Signal's operations over REST, public MCP, and Operator MCP in-process.

- Scripted submitter and PM policies; the PM policy uses no model and is budgeted in actions.
- The Signal arm and the vote-board arm.
- A scorer that computes every metric in the spec with bootstrap intervals and cross-checks `get_metrics` against the event log.

Proven on the fixture world with fake AI ports in `pnpm test`.

**Area:** evals/crewday, tests

**Blocked by:** 01

- [ ] Replaying the fixture world with fake AI ports and a fixed seed gives identical events and scores on repeat runs.
- [ ] The scorer's recomputation from `events` equals `get_metrics` for a simulated week. The planted retry is counted once, the planted validation failure is not counted, and public-MCP signals count as agent.
- [ ] The vote-board arm never emits a suggestion, and its preview returns keyword results only.
- [ ] The PM policy makes no model call and records organizing and deciding actions separately.
- [ ] The runner refuses any database that is not a local Docker or PGlite test database.

### 04: Signal vs. vote board on Crewday (the lift run)

**What to build:** `pnpm eval:crewday` runs both arms live on a chosen world at default behaviour.

- It loads the migrated backlog and replays the year.
- It prints the report: keyword-findable share, headline business outcomes, PRODUCT.md's metrics (prevention by quarter), diagnostics, guardrails, and what is not measured, each with an interval and a pass or fail against the success criteria.
- It writes the JSON report and skips cleanly without AI Gateway access.

This task answers the bet on the dev world.

**Area:** evals/crewday, package.json

**Blocked by:** 02, 03

- [ ] A live run on `crewday-dev` completes and reports every metric in the spec for both arms, with 95% intervals.
- [ ] The report confirms no planted PII reached an approved public summary.
- [ ] The first live run's model spend per world is measured and recorded in the spec's open assumptions.
- [ ] Acceptance scenario steps 1–5 pass on `crewday-test`.
- [ ] `pnpm eval` includes the dev-world run.

### 05: Behaviour sweep with cached AI responses

**What to build:**

- `--sweep` runs the behaviour grid and reports which conclusions hold across it, labeling the ones that hold only at the defaults.
- `--cached` replays AI responses from a local cache keyed by model, prompt hash, and input, so dev iterations and sweep cells that do not change AI inputs cost nothing extra.

**Area:** evals/crewday

**Blocked by:** 04

- [ ] The sweep reports every success criterion for each grid cell and summarizes how robust each one is.
- [ ] A second `--cached` dev run with unchanged code makes no model calls and gives an identical report (acceptance scenario step 6).
- [ ] Tagged runs refuse `--cached`.

### 06: Tagged runs, history, and the regression rule

**What to build:** `--tag <name>` on the test world runs 3 repeats with different seeds and appends a history entry: world version, git SHA, model ids, policy parameters, seeds, and each metric's estimate and interval. The report compares the run with the previous tagged run as improvement, regression, or no detectable change, using interval overlap.

**Area:** evals/crewday

**Blocked by:** 04

- [ ] A tagged run appends exactly one history entry and never rewrites earlier ones.
- [ ] The comparison flags a metric as improved or regressed only when the intervals do not overlap. A test with synthetic history entries proves both directions and the no-change case.
- [ ] `--tag` is rejected on the dev world.
- [ ] The first tagged baseline (`v1-baseline`) is recorded.

### 07: Harder matching set from the test world

**What to build:** `pnpm eval:crewday --component matching` runs Signal's matching pipeline over `crewday-test` signals against that world's needs. It reports precision@3, false-match rate, new-need recall, multi-ask detection, and the need-statement rubric, split by trap kind and keyword-findable vs. not. This lets matching quality move again while `evals/matching` stays the MVP kill criterion.

**Area:** evals/crewday, evals/matching

**Blocked by:** 02

- [ ] The run reports every listed metric overall, per trap kind, and for keyword-findable vs. not.
- [ ] It reuses `evals/matching`'s pipeline, grader, and cost meter rather than copying them.
- [ ] Its first result is recorded beside the `evals/matching` result, so the gap between the easy set and the hard set is visible.

## Out of Scope

- Any UI, including a results dashboard. Reports are JSON and terminal tables.
- Real customer data, a real Crewday, or any production database.
- Live Eve agents as submitters or PM ([spec 005](./005-agent-outcome-eval.md)).
- Competitor-style embedding-only dedupe as a third arm. It is the next comparison once the vote-board comparison holds.
- Validating riskiest assumption 1 (real submitters' willingness to add their voice). The simulation assumes behaviour and sweeps it. Only real users can confirm it.
- Replacing `pnpm db:seed`'s demo workspace with Crewday. Seeding the demo from a world is a later option.
- Ingestion (spec 002) and notifications (spec 003) inside the simulation.
- Running evals in CI.

## Further Notes

**What the simulation can and cannot prove.** It proves that Signal, given demand like Crewday's and people who behave within the swept ranges, produces better consolidation and better decisions on the revenue that matters than a vote board. It can falsify the product mechanism cheaply. It cannot prove that people behave as the policies assume. Latency and organizing-share results are relative to the policy's budget and readiness line, not absolute predictions.

**Decision quality mostly measures noise here.** Both arms publish the strategy-implied verdict flipped with the same `p_pm_error`, so decision quality mostly reflects PM noise and which needs get decided, not better judgment; that is why its comparison with the board is non-inferiority, not superiority.

**Known risk: a weak opponent.** PRODUCT.md says competitors already ship AI duplicate detection, so beating a plain vote board is necessary but not sufficient. Embedding-only dedupe is the next comparison.

**Open assumptions**

- **Crewday's domain** (workforce scheduling, mid-market, frontline teams) is a guess; Crewday is only confirmed as fictional.
- **The human review of generated signals** is not decided. **v1 shipped with no review at all, for speed** (manifest records it as deferred). The planned v1.1 method: the stratified sample (10% per world, weighted to traps) is checked by a model from a third family, different from both Signal's runtime models and the generator. Disagreements are fixed or dropped and recorded with the world. This is cheaper but not independent; a human review of the same sample can upgrade a world to `v1.1` without changing its signals' labels.
- **The generator model family** is not chosen. The requirement is only that it is not one of Signal's runtime models.
- **Policy defaults** (`p_attach` 0.8, `p_wrong` 0.1, `pm_actions` 60, `p_manual_find`, the readiness line) are hypotheses. The sweep bounds them.
- **Success thresholds** (+20 points prevention, ≥ 85% decision quality, 1.5× revenue coverage, half the organizing share, ≥ 95% acceptance precision) and the 60% keyword-findable ceiling are proposals.
- **The run budget** (about $5 per full run per world) is unmeasured.
- **PRODUCT.md additions on acceptance:** add true prevention rate, decision quality, revenue coverage, and acceptance precision under Supporting metrics, and the simulated outcome kill signal under Kill criterion. These add to PRODUCT.md; they do not reverse anything.
