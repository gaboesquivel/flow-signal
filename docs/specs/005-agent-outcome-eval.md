# 005 — Agent outcome eval: do agents reach the outcomes a careful human would?

Status: later (deferred 2026-10-30)

## Problem

PRODUCT.md makes agents first-class users. Support copilots file and support needs over public MCP, and PM assistants triage and decide over Operator MCP. Spec 001's agent evals check only that the right tool is called. Nothing checks that an agent acting for a customer or a PM reaches the right outcome:

- Did it find the existing need?
- Did it keep the customer's own words and use case?
- Did it make the decision Crewday's strategy implies?

## Assumption it tests

Eve agents working over Signal's MCP tools, given natural-language instructions, match or beat [spec 004](./004-crewday-outcome-eval.md)'s scripted policies on the same Crewday worlds:

- The **Assistant** agent calls `preview_signal` before `submit_signal`, attaches to the true need when it is shown, keeps the customer's use case verbatim, and never calls an Operator tool.
- The **Operator** agent, given the strategy memo, resolves suggestions and publishes decisions that agree with ground truth at least as often as the scripted PM. Its decisions are attributed `published_by_kind = agent` in `get_metrics`.

This is where context rate becomes measurable: it reflects what the agent kept, not what the generator wrote.

Runs on spec 004's worlds, engine, and scorer. It samples about 100 signals and four simulated weeks of triage per run to bound live-model cost. Flesh out after spec 004's first slice shows lift at default behaviour.
