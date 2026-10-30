# 0004 — Simulated customer world with scripted behaviour as the outcome eval

Status: Proposed (2026-10-30)

## Context

PRODUCT.md's three metrics (prevention rate, decision latency, AI suggestion acceptance) depend on what people do: submitters choosing to add their voice, and PMs accepting suggestions and deciding. There are no real users yet, every baseline is "unknown", and the only offline eval (`evals/matching`) measures one component and is saturated. Every later change to prompts, models, thresholds, or agents needs a stable way to show whether it moved those outcomes. That makes this choice reach beyond one spec, and a frozen labeled world is costly to rebuild.

## Options

1. **Component evals only:** keep growing labeled matching and grading sets. Cheap and deterministic, but they never measure prevention, latency, or PM load, and they say nothing about a baseline.
2. **Simulated world with scripted (oracle + noise) policies:** a frozen fictional customer's year of demand with hidden ground truth, replayed in simulated time through the real operations, with submitters and PMs as seeded policies that read ground truth and make tunable errors. Compared against a vote-board arm on the same plumbing.
3. **Simulated world with LLM persona agents:** the same world, but every submitter and PM is a model agent that sees only what a real user would. More realistic, but non-deterministic, costly at ~1,500 signals, and a model grading a model's suggestions can flatter itself.
4. **Wait for real users:** the only true test of behaviour, but there are none, and it gives no regression signal between releases.

## Decision

Option 2, as specified in [spec 004](../specs/004-crewday-outcome-eval.md): the fictional customer **Crewday**, a versioned and frozen world (`crewday@v1`) with dev and test splits, oracle + noise policies with a behaviour sweep, a vote-board arm built from alternative AI ports on the same registry and event log, and an append-only run history. LLM persona agents are used only in a bounded agent sub-run (Eve Assistant and Operator agents), which is scored on outcomes.

Why:

- Labels exist by construction, so outcomes can be scored against truth Signal cannot see (duplicates left behind, wrong attachments).
- Seeded policies make runs reproducible and cheap enough to repeat. Sweeping their parameters shows which conclusions depend on assumed behaviour.
- Building the baseline on the same operations isolates the AI's contribution, and it exercises REST, MCP, and agents together.

## Consequences

- Conclusions are conditional on the swept behaviour ranges. Riskiest assumption 1 still needs real users.
- The world becomes a maintained asset. Changes ship as new versions, never in-place edits, and the `test` split must stay unused for tuning.
- The domain must stay drivable by an injected clock and AI ports (`configureSignalRuntime`). New operations that read wall-clock time directly would break the simulation.
- Persona-agent realism (option 3) stays available as a later layer on the same world.
