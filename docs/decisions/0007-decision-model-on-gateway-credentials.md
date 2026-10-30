# 0007 — Decision model billing: the AI Gateway's own credentials, no BYOK

Status: Accepted (2026-10-30). Supersedes in part [0006](./0006-decision-model-fable-gateway-byok.md) (billing only; the decision model, effort, refusal fallback, and timeout stand).

## Context

[0006](./0006-decision-model-fable-gateway-byok.md) runs decision briefs on Claude Fable 5.1 through the AI Gateway and bills them to our Anthropic account with request-scoped BYOK (`providerOptions.gateway.byok`, from `ANTHROPIC_API_KEY`). The first live brief (2026-10-30, [spec 007](../specs/007-decision-direction.md) → Further Notes) showed BYOK never applied:

- Anthropic rejects our key on every request, directly and through the Gateway: it is not scoped to a workspace, so each request must name one (`anthropic-workspace-id`).
- The Gateway then retries on its own credentials and the call succeeds, so the failure is silent. Briefs worked and were billed to the Gateway all along.

Every other Signal model call, and our other projects (gaboesquivel.com), already run on the Gateway's credentials with only `AI_GATEWAY_API_KEY` (or Vercel OIDC). `ANTHROPIC_API_KEY` was never used there.

## Options

1. **Keep BYOK and add the workspace id** (`ANTHROPIC_WORKSPACE_ID`, sent as a header on the BYOK credential), or replace the key with a workspace-scoped one.
2. **Drop BYOK: bill decision calls to the Gateway like every other call.**

## Decision

Option 2. Decision calls send no BYOK credential; the Gateway bills them on its own credentials. `SIGNAL_DECISION_MODEL`, `effort: "medium"`, `fallbacks: "default"`, and the 180 s timeout are unchanged.

Why:

- It is what already happened in production, and briefs worked; option 1 adds a second secret and a workspace setting to every environment to change only who is billed.
- One billing path for all model calls: one spend report, one budget (Gateway budgets), one set of credentials to rotate.
- A silent fallback means BYOK misconfiguration is invisible; removing BYOK removes that failure mode instead of monitoring it.

## Consequences

- `anthropicByokOptions()`, `ANTHROPIC_WORKSPACE_ID`, and the BYOK-failure warning are removed; `ANTHROPIC_API_KEY` is back to the local direct override only (`FLOW_ALLOW_DIRECT_ANTHROPIC=1`, `docs/INTEROP.md`). It is removed from Vercel and GitHub.
- Retention, rate limits, and spend for decision calls are the Gateway's, not our Anthropic account's; the Gateway budget covers them. 0006's 30-day retention requirement on our account no longer applies.
- Revisit if per-brief spend needs Anthropic-side controls the Gateway does not offer; option 1 then needs a workspace-scoped key.
