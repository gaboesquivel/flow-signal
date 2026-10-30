# 0012 — Jev judges submission-time matches

Status: Accepted (2026-10-30). Amends [0002](./0002-retrieve-then-judge-matching.md) (the judge step).

## Context

[0002](./0002-retrieve-then-judge-matching.md) put a fast LLM (`anthropic/claude-haiku-5.5`) behind the `MatchJudge` port and named a calibrated classifier as the drop-in alternative. The LLM judge meets every matching quality target, but it writes a verdict and reason for all eight candidates, which takes 3.1 s at p50 and 3.8 s at p95; preview's p95 is 4.2 s against a 2 s guardrail ([spec 001](../specs/001-signal-mvp.md) task 03 result). Jev (`typesafe-ai/jev`) is on the Vercel AI Gateway as a decision model, so it needs no new key or SDK: the AI SDK's `experimental_decide` calls it with the existing Gateway credentials.

## Options

1. **Keep the Haiku judge** and shorten its output (fewer candidates, no reasons) to cut latency.
2. **Jev, one boolean question per candidate:** P(same need) for each.
3. **Jev, one choice plus one boolean:** which candidate is closest, and whether any is the same need; each candidate gets P(any) × P(that choice).

## Decision

Option 3, measured on the matching eval in [spec 008](../specs/008-jev-classification.md). At its own threshold (0.65) it scores precision@3 98.8%, false-match 0.8%, and new-need recall 97.3% (two runs agree), the judge step takes 0.19 s at p50 and 0.26 s at p95, and preview's p95 drops to 1.6 s, inside the guardrail for the first time. The judge costs $0.000033 per signal instead of $0.00034. Option 2 meets the quality targets only at 0.85 and above, where it shows fewer correct matches; its booleans rate near-duplicate catalog needs as the same need, while a choice spreads probability across them.

The switch is per call: `SIGNAL_CLASSIFIER_CALLS` (default `match_judge`; `none` restores the Haiku judge), and the model is `SIGNAL_CLASSIFIER_MODEL` (default `typesafe-ai/jev`), resolved in `lib/ai/models.ts` like every other model (spec 010).

## Consequences

- Each judge carries its own threshold on the `MatchJudge` port (`threshold`); probabilities from different judges are not on one scale. `MATCH_THRESHOLD` (0.6) stays for the LLM judge.
- Match reasons are written in code from the probability, because Jev returns no prose. The customer sees a short, generic reason ("The same kind of person wants the same outcome.") instead of one that names what is shared. If explanations prove to matter, a reason can be generated off the hot path for the matches shown.
- Multi-ask submissions with two correct needs split the choice's probability, so match recall@3 on that kind falls from 95% to 75–80%; the quality targets still pass. The diagnostic is in the eval report.
- A refusal or failure fails the whole judge call and preview degrades as before (`ai: "unavailable"`).
- Crewday's simulated submissions use the same judge, so its next run measures Jev; it has not run for this change.
