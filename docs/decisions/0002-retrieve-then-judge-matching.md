# 0002 — Retrieve-then-judge matching as a bounded workflow on the hot path

Status: Proposed (2026-10-30)

## Context

The core AI step decides, while someone is submitting, whether their request is the same underlying need as an existing one. It must be fast (under 2 s at p95), cheap (under $0.01 per signal), explainable (a reason per match), evaluable offline, and conservative (false-match rate at most 5%). The same capability is used by humans in the UI and by agents over MCP. The template already provides the Vercel AI Gateway, the AI SDK, Eve agents, and MCP.

## Options

1. **Embedding similarity only:** embed the submission and return nearest needs above a cosine threshold.
2. **Retrieve then judge:** extract the underlying need with a fast model, retrieve top candidates by embedding, then have a fast model judge each candidate and give a probability and reason.
3. **Agent loop:** let an Eve agent search and reason freely per submission.
4. **Calibrated classifier service** (for example TypeSafe's typed questions) for the judge step.

## Decision

Option 2, implemented as a fixed three-step workflow with AI SDK structured output: extract (`anthropic/claude-haiku-5.5`), retrieve (Gateway embeddings plus pgvector, top 8), judge (`anthropic/claude-haiku-5.5`, threshold tuned on the eval set). Slower, open-ended reasoning (priority scores, summaries, decision briefs, demand questions) uses `anthropic/claude-sonnet-5.5` off the hot path, and Eve agents only where questions are open-ended (Operator chat). All models go through the AI Gateway and are overridable by env.

Why:

- Similarity alone matches on wording and named solutions, which is exactly the "same solution, different need" failure; extracting the need first and judging pairs targets the problem, not the phrasing.
- A fixed workflow has predictable latency and cost and can be scored step by step; an agent loop does not, and gains nothing on a narrow question.
- Haiku-class models meet the latency and cost guardrails; the judge prompt and threshold are tuned against the labeled eval set.
- A calibrated classifier (option 4) may give better-calibrated probabilities. It stays a drop-in alternative behind the `MatchJudge` port, to be compared on the same eval set if the judge's false-match rate misses its threshold.

## Consequences

- Each submission costs up to two fast-model calls and one embedding; expected well under $0.01, verified in the eval run.
- Model probabilities are not calibrated by default; the threshold is a tuned number, and the eval set must be refreshed as needs grow.
- Ports (`NeedExtractor`, `Embedder`, `NeedRetriever`, `MatchJudge`, `Reasoner`) keep providers swappable and tests offline.
- Changing the approach later touches the submission UX, MCP tool outputs, and the eval harness, which is why this is a record.
