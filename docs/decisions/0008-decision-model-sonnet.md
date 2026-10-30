# 0008 — Decision model: Claude Sonnet 5.5 by default

Status: Accepted (2026-10-30). Supersedes in part [0006](./0006-decision-model-fable-gateway-byok.md) (the default decision model; with [0007](./0007-decision-model-on-gateway-credentials.md), 0006 is fully superseded).

## Context

[0006](./0006-decision-model-fable-gateway-byok.md) made Claude Fable 5.1 the default decision model, to be kept only if Crewday showed it beats Sonnet 5.5 by enough to justify about 5× the price. That Crewday comparison has not run. A live Fable brief cost $0.065 and took 17 s ([spec 007](../specs/007-decision-direction.md) → Further Notes); a Sonnet 5.5 call with the same decision options answered in about 2 s with no warnings.

## Options

1. **Keep Fable 5.1 as the default** until Crewday shows it is not worth the price.
2. **Default to Sonnet 5.5** and make Fable 5.1 the challenger, adopted only if Crewday shows it earns the price.

## Decision

Option 2. `DEFAULT_SIGNAL_DECISION_MODEL` is `anthropic/claude-sonnet-5.5`. Decision tasks keep their own setting (`SIGNAL_DECISION_MODEL`), `effort: "medium"`, the refusal fallback (`fallbacks: "default"`), and the 180 s timeout, so switching back to Fable is one environment variable.

Why: the burden of proof belongs on the more expensive model. Without evidence that Fable's recommendations are better, the cheaper and faster model is the default, and the per-brief guardrail ($0.25) has more headroom.

## Consequences

- Briefs cost and take a fraction of what Fable did; Sonnet is the same model the other reasoning tasks use.
- The spec 007 Crewday comparison now runs Sonnet as the default arm and `SIGNAL_DECISION_MODEL=anthropic/claude-fable-5.1` as the challenger. If Fable beats Sonnet on direction accuracy and decision quality by enough to justify the price, a new record makes it the default again.
