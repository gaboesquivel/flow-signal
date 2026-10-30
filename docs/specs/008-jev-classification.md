# 008 — Jev for closed-set classification

Status: candidate (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Metrics (match precision@3, false-match rate), Riskiest assumption 2. Builds on [0002](../decisions/0002-retrieve-then-judge-matching.md), which names a calibrated classifier as a drop-in alternative behind `MatchJudge`, and [spec 007](./007-decision-direction.md).

## Problem

Every yes/no and pick-one call in Signal is an LLM returning JSON with a self-reported probability: the submission-time match judge (Haiku 5.5, threshold 0.6), merge proposals (Sonnet, one candidate), theme choice, multi-ask detection, and, after spec 007, readiness and plan/decline. Those probabilities are not calibrated, so thresholds drift whenever a prompt or model changes, and a merge proposal can name only one candidate. Jev (TypeSafe, `@typesafe-ai/sdk`, already used for GenUI routing) answers typed `choice` and `score` questions with a probability per label.

pgvector keeps doing recall. Retrieval has its own gaps worth fixing here: the query embeds raw submission text while needs embed normalized statements, the drafted statement never reaches retrieval or the judge (the `MatchJudge` port accepts `draft`; preview never passes it), and each need has a single vector.

## Assumption it tests

Jev's calibrated answers beat the current LLM calls on the same eval sets (`pnpm eval`: precision@3, false-match rate, new-need recall; Crewday: true prevention rate, acceptance precision, direction accuracy) within the hot path's 2 s p95 and $0.01 per signal. Each classification moves to Jev only where it wins; if the match judge moves, a new record amends [0002](../decisions/0002-retrieve-then-judge-matching.md).
