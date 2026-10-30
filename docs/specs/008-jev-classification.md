# 008 — Jev for closed-set classification

Status: accepted (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Metrics (match precision@3, false-match rate), Guardrails (2 s p95, $0.01 per signal), Riskiest assumption 2. Builds on [0002](../decisions/0002-retrieve-then-judge-matching.md), which names a calibrated classifier as a drop-in alternative behind `MatchJudge`, [spec 007](./007-decision-direction.md), and [spec 010](./010-retro-remediation.md) (every model through the AI Gateway, resolved in `lib/ai/models.ts`). Decision: [0012](../decisions/0012-jev-match-judge.md).

**Bet.** If Signal's closed-set calls (yes/no, pick one) are answered by a calibrated classifier instead of an LLM writing JSON, preview gets inside its latency guardrail without losing matching quality.

## Problem Statement

Every yes/no and pick-one call in Signal is an LLM returning JSON with a self-reported probability: the submission-time match judge (Haiku 5.5, threshold 0.6), merge proposals (Sonnet, one candidate), theme choice, multi-ask detection, and, after spec 007, plan/decline inside the decision brief. Those probabilities are not calibrated, so thresholds drift whenever a prompt or model changes. The hot path also misses its guardrail: the Haiku judge writes a verdict and reason for all eight candidates, and preview's p95 is about 4 s against a 2 s target ([spec 001](./001-signal-mvp.md) task 03 result).

Jev (TypeSafe) answers typed `choice`, `score`, and `boolean` questions with a probability per answer. It is listed on the Vercel AI Gateway as `typesafe-ai/jev` (type `evaluation`, $0.042 per million input tokens), so it runs with the existing `AI_GATEWAY_API_KEY` and the AI SDK's `experimental_decide`; no TypeSafe key or SDK is involved.

pgvector keeps doing recall. Retrieval has its own gaps: the query embeds raw submission text while needs embed normalized statements, the drafted statement never reaches retrieval or the judge (the `MatchJudge` port accepts `draft`; preview never passes it), and each need has a single vector.

## Solution

- A classifier model entry in `lib/ai/models.ts`: `SIGNAL_CLASSIFIER_MODEL` (default `typesafe-ai/jev`), resolved through the one Gateway provider as a decision model (`gatewayDecisionModel`).
- A per-call switch, `SIGNAL_CLASSIFIER_CALLS`: a comma-separated list of the calls that run on the classifier, or `none`. Its default lists only the calls where Jev won the eval below. Today one call is switchable, `match_judge`.
- A Jev implementation of `MatchJudge` (`lib/signal/ai/jev.ts`), with all question wording in that module. It asks one `choice` ("which existing need is closest to the underlying need in `request`?", options named by their statements) and one companion `boolean` ("does `request` ask for the same underlying need as any of these?"), and gives each candidate P(any) × P(that choice). It carries its own threshold (0.65) on the port.
- The matching eval compares judges on the same set and reports per-step latency and per-model cost, so every later move is measured the same way.

Result: the match judge moved to Jev. Matching quality stays above every PRODUCT.md target, the judge step is about 16× faster and 10× cheaper, and preview's p95 meets the 2 s guardrail.

## Probe (2026-10-30)

`experimental_decide({ model: gateway.decisionModel("typesafe-ai/jev"), state, questions })` with one `choice` and one `score` question over a short request: Jev supports `choice`, `score`, and `boolean`. Answers came back typed (`{ type: "choice", choice, probabilities }`, `{ type: "score", score, probabilities }`), plus `providerMetadata.typesafe.confidence` per question and `providerMetadata.gateway.cost`. Two calls took 454 ms (cold) and 204 ms; each used 407 input and 46 output tokens and cost $0.000017 (input only). Repeated calls vary slightly (0.45 vs 0.41 on the same question). `experimental_decide` returns no partial answers: one refused question fails the whole call (`DecisionRefusalError`).

## Eval comparison

`pnpm eval:matching` over the 131 labeled submissions (55 paraphrase, 26 same-solution, 20 multi-ask, 30 new) against the fixture catalog, at 4 submissions in flight, locally, 2026-10-30. Extraction (Haiku) and embeddings are the same in every arm; only the judge changes. Need-statement grading was skipped (`--no-grade`), since extraction did not change. Targets: precision@3 ≥ 90%, false-match ≤ 5%, new-need recall ≥ 90%.

| Match judge                                       | Threshold   | Precision@3 | False-match | New-need recall | Match recall@3 | Judge p50 / p95 | Preview p95 | Judge $ / signal | Total $ / signal |
| ------------------------------------------------- | ----------- | ----------- | ----------- | --------------- | -------------- | --------------- | ----------- | ---------------- | ---------------- |
| Haiku 5.5 (LLM, before)                           | 0.60        | 99.0%       | 0.8%        | 100%            | 97.9%          | 3105 / 3779 ms  | 4167 ms     | $0.00034         | $0.00046         |
| Jev, one boolean per candidate                    | 0.60        | 79.5%       | 17.6%       | 91.9%           | 97.9%          | 192 / 258 ms    | 1552 ms     | ≈ $0.00005       | ≈ $0.00016       |
| Jev, one boolean per candidate                    | 0.85 (best) | 96.7%       | 2.3%        | 100%            | 88.3%          | same            | same        | same             | same             |
| Jev, boolean per candidate, drafted need in state | 0.75 (best) | 94.1%       | 3.8%        | 100%            | 83.0%          | 187 / 236 ms    | 1745 ms     | $0.000053        | $0.00016         |
| **Jev, choice + any (adopted)**, run 1            | **0.65**    | 98.8%       | 0.8%        | 97.3%           | 90.4%          | 189 / 255 ms    | 1578 ms     | $0.000033        | $0.00014         |
| **Jev, choice + any (adopted)**, run 2            | **0.65**    | 98.8%       | 0.8%        | 97.3%           | 90.4%          | 193 / 256 ms    | 1614 ms     | $0.000033        | $0.00014         |

Readings:

- Every Jev arm puts preview inside the 2 s guardrail; the Haiku judge does not. Haiku's quality is a little higher, but both pass every target.
- Booleans per candidate rate near-duplicate catalog needs (for example "scheduled delivery" and "share snapshots") as the same need, so false matches only fall below 5% at 0.85, where fewer correct matches show. A choice spreads probability across close candidates, which is what the judge needs.
- Passing the drafted need forces extraction before judging (serial), adds about 170 ms at p95, and did not help the boolean design. It was not wired into preview.
- 0.65 is the lowest threshold where the adopted design has false-match under 1% and new-need recall over 95% in both runs (the sweep's best-recall pick is 0.45–0.5). It is tuned on this set; a larger, fresher set should re-check it.
- Multi-ask cases with two correct needs split the choice, so match recall@3 on that kind is 75–80% (Haiku: 95%). Not a target metric; recorded in 0012.

### Multi-ask detection (diagnostic)

| Detector                                          | Recall on multi-ask | False positives on single asks | Extra cost / signal |
| ------------------------------------------------- | ------------------- | ------------------------------ | ------------------- |
| Haiku extractor (`additionalAsks` non-empty)      | 65–75% across runs  | 0.9%                           | none (same call)    |
| Jev boolean "more than one separate thing?" ≥ 0.5 | 75%                 | 0.9%                           | $0.000016           |

Jev ties the extractor, and it cannot write the extra asks' statements, so multi-ask detection stays on the extractor.

### Where hot-path time goes (Jev judge, for the guardrail follow-up)

Per-step wall time from the eval (`latency.steps` in the report): extraction 1.2 s p50 / 1.6 s p95 (Haiku, runs concurrently with the rest), embedding 0.35 s / 0.5–0.6 s, judge 0.19 s / 0.26 s. Embed → retrieve → judge finishes in well under a second, so preview's latency is now the extractor's. Spend per signal: Haiku extraction $0.000105, Jev judge $0.000033, embedding $0.000001; total $0.00014 against the $0.01 guardrail. The eval does not include preview's database work (`getPublicNeed` per match, the `preview.shown` insert) or network distance from Vercel to the Gateway.

## Implementation Decisions

- **Gateway only.** The classifier is a Gateway decision model resolved in `lib/ai/models.ts` (`signalClassifierModelId`, `gatewayDecisionModel`); `ai`'s `experimental_decide` calls it. No `@typesafe-ai/sdk` use and no `TYPESAFE_API_KEY`.
- **Judgments from Jev, decisions in code.** Jev answers "which is closest" and "is any the same need"; code multiplies them, applies the threshold, and picks the top three (`chooseMatches`, unchanged).
- **Threshold per judge.** `MatchJudge` gains an optional `threshold`. Preview gates on the caller's threshold, else the judge's, else `MATCH_THRESHOLD` (0.6, the LLM's). The eval gates the same way.
- **Reasons in code.** Jev returns no prose, so the reason shown with a match is written from the probability (0.7 and up: "The same kind of person wants the same outcome."). A trade-off against 0002's "a reason per match"; recorded in 0012.
- **Failure.** Any failure or refusal makes the judge throw `ai_unavailable` (5 s timeout, one retry), so preview degrades exactly as before.
- **Per-call switch, default by evidence.** `SIGNAL_CLASSIFIER_CALLS` defaults to `match_judge`; `none` restores the Haiku judge with an environment change. A call joins the default only after it wins on its eval.
- **Eval method.** `pnpm eval:matching` takes `--judge llm|jev`, `--jev-design choice|per_candidate`, `--draft` (pass the drafted need to the judge), and `--multi-ask-probe`. It reports per-step p50/p95 latency and cost per signal per model (decision-model calls are metered through `experimental_onDecisionModelCallEnd`). A call moves to Jev when, on the same set, it meets every PRODUCT.md quality target at a tuned threshold and is better on a guardrail (p95 latency or cost) without missing another.

## Testing Decisions

- `tests/signal/domain/jev-matching.test.ts`: both question designs against `fakeDecisionModel` (in `lib/signal/ai/fakes.ts`, the decision-model counterpart of `MockLanguageModelV4`): question shape, option names, the P(any) × P(choice) mapping, the judge's threshold, failures and refusals as `ai_unavailable`, the switch, and the multi-ask detector.
- `tests/signal/domain/matching.test.ts`: preview gates on the judge's own threshold.
- `tests/evals/matching.test.ts`: decision-model metering, multi-ask scores, step percentiles, and the runner's draft and probe options with fake ports.
- `lib/ai/models.test.ts`: the classifier model is listed by the installed Gateway and overridable.
- Live: the eval runs above. Crewday was not run (it costs dollars and runs only when asked); its simulated submissions now use the Jev judge too.

## Out of Scope

- **Merge proposals.** [Spec 009](./009-duplicate-backstop.md) is rebuilding `proposeMerge` into multi-candidate checks on a parallel branch. Its per-candidate check can call `ctx.ai.judge` (now Jev) instead of the reasoner; doing it here would collide with that work. No merge eval set exists outside Crewday.
- **Theme choice.** It also proposes a new theme name when none fits, which a classifier cannot write, and there is no labeled theme set to compare on. A Jev choice over existing themes plus a companion "does any fit?" boolean is the shape to try once a set exists.
- **Multi-ask detection.** Measured above: Jev ties the extractor and cannot write the extra statements.
- **Readiness and plan/decline (spec 007).** Readiness is arithmetic over ARR and supporter counts, already in code. Plan/decline is part of the decision brief, whose value is its prose; it stays with the decision model.
- **Retrieval gaps.** Passing the drafted need to the judge was measured and did not help (above). Embedding the drafted statement for retrieval would make extraction serial before embedding, about 1.6 s at p95 before the rest starts, which spends the guardrail just won. Multiple vectors per need need a schema change. All three are left for the guardrail follow-up, with the step timings above as its baseline.
- **Generated match reasons.** Revisit only if submitters need them.

## Tasks

- [x] 01: Probe Jev through the Gateway with `experimental_decide` (choice and score).
- [x] 02: Classifier model entry and per-call switch in `lib/ai/models.ts`; `fakeDecisionModel`.
- [x] 03: Jev `MatchJudge` (two designs) and multi-ask detector, test-first; judge threshold on the port.
- [x] 04: Eval: judge selection, drafted-need variant, multi-ask probe, step latency, per-model cost.
- [x] 05: Live comparison; flip `match_judge` to Jev; decision 0012 amends 0002.
