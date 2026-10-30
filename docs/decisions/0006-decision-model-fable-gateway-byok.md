# 0006 — Decision model: Claude Fable 5.1 through the AI Gateway on our Anthropic key

Status: Accepted (2026-10-30). Superseded in part by [0007](./0007-decision-model-on-gateway-credentials.md) (billing: no BYOK; decision calls run on the Gateway's credentials) and by [0008](./0008-decision-model-sonnet.md) (default decision model: Sonnet 5.5).

## Context

Decision briefs recommend a product decision (plan or decline) against the PM's strategy ([spec 007](../specs/007-decision-direction.md)). They are few (dozens a week), an operator or an automatic readiness trigger waits on them, and a wrong recommendation costs more than a slow or expensive one. Today every reasoning task, briefs included, runs on `anthropic/claude-sonnet-5.5` through the Vercel AI Gateway ([spec 001](../specs/001-signal-mvp.md), [0002](./0002-retrieve-then-judge-matching.md)). The template routes all models through the Gateway and keeps `ANTHROPIC_API_KEY` for a local direct override only (`docs/INTEROP.md`).

## Options

1. **Keep Sonnet 5.5 for briefs** through the Gateway (status quo).
2. **Claude Fable 5.1 through the Gateway on the Gateway's credentials.**
3. **Claude Fable 5.1 through the Gateway on our own Anthropic key** (request-scoped BYOK in `providerOptions.gateway.byok`).
4. **Claude Fable 5.1 on the Anthropic API directly** with the Anthropic SDK.

## Decision

Option 3, for decision tasks only (`decision_brief`), behind `SIGNAL_DECISION_MODEL` (default `anthropic/claude-fable-5.1`), with `effort: "medium"` and Anthropic's server-side refusal fallback (`fallbacks: "default"`). All other tasks keep their models.

Why:

- Fable 5.1 is Anthropic's most capable model, and decisions are the low-volume, high-stakes step where that matters; at ~$0.10–0.15 a brief it stays far under the cost that matters (a wrong decision), while the per-signal paths keep their $0.01 guardrail.
- One routing layer: the Gateway keeps one client, one model-id scheme, and the same observability, timeouts, and test seams (`MockLanguageModelV4`) as every other Signal call; option 4 adds a second SDK and a second error path for one task.
- BYOK bills decision calls to our Anthropic account (retention, rate limits, and spend under our control) without giving up the Gateway; when the key is unset, the Gateway's own credentials are used, so local and preview environments still work.
- Option 1 stays available by setting `SIGNAL_DECISION_MODEL=anthropic/claude-sonnet-5.5`, which is also the Crewday comparison arm.

## Consequences

- Briefs take longer (Fable always thinks); the decision timeout is 180 s and briefs stay off the hot path.
- Fable 5.1 rejects disabled thinking; decision calls set effort instead.
- The Anthropic account behind the key must allow 30-day data retention.
- The Gateway accepts `effort: "medium"` and `fallbacks: "default"` without warnings (live brief, 2026-10-30). Whether a refusal actually falls back is still unobserved (no refusal occurred); until it is, a refusal is `ai_unavailable` and retried on the next trigger.
- BYOK failure is silent: when Anthropic rejects the BYOK credential, the Gateway retries on its own credentials and the call succeeds, billed to the Gateway. Our key is not workspace-scoped, so BYOK needs `ANTHROPIC_WORKSPACE_ID` (sent as `anthropic-workspace-id` on the BYOK credential only) or a workspace-scoped key. The reasoner logs a warning when a decision call's BYOK attempt failed.
- Fable becomes the default only if Crewday shows it beats Sonnet 5.5 on direction accuracy and decision quality by enough to justify ~5× the price; otherwise this record is superseded.
- `docs/INTEROP.md` documents the new use of `ANTHROPIC_API_KEY`.
