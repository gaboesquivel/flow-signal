# 0004 — Simulated customer world with scripted behaviour as the outcome eval

Status: Accepted (2026-10-30)

## Context

PRODUCT.md's three metrics (prevention rate, decision latency, AI suggestion acceptance) depend on what people do: submitters choosing to add their voice, and PMs accepting suggestions and deciding. There are no real users yet, every baseline is "unknown", and the only offline eval (`evals/matching`) measures one component and is saturated. Every later change to prompts, models, thresholds, or agents needs a stable way to show whether it moved those outcomes. That makes this choice reach beyond one spec, and a frozen labeled world is costly to rebuild.

## Options

1. **Component evals only:** keep growing labeled matching and grading sets. Cheap and deterministic, but they never measure prevention, latency, or PM load, and they say nothing about a baseline.
2. **Simulated world with scripted (oracle + noise) policies:** a frozen fictional customer's year of demand with hidden ground truth, replayed in simulated time through the real operations, with submitters and PMs as seeded policies that read ground truth and make tunable errors. Compared against a vote-board arm on the same plumbing.
3. **Simulated world with LLM persona agents:** the same world, but every submitter and PM is a model agent that sees only what a real user would. More realistic, but non-deterministic, costly at ~1,500 signals, and a model grading a model's suggestions can flatter itself.
4. **Wait for real users:** the only true test of behaviour, but there are none, and it gives no regression signal between releases.

## Decision

Option 2, as specified in [spec 004](../specs/004-crewday-outcome-eval.md): the fictional customer **Crewday**, built from one hand-written recipe into two separate, frozen, versioned worlds (`crewday-dev` for tuning, `crewday-test` held out). Signals are generated from personas and scenarios, never from need statements, and a world is rejected if keyword search alone solves too much of it. Scripted policies (oracle + noise, no model calls) act as submitters and the PM, with a behaviour sweep. A vote-board arm is built from alternative AI ports on the same registry and event log. Results carry confidence intervals and go into an append-only run history. Live Eve agents on the same worlds are a separate bet ([spec 005](../specs/005-agent-outcome-eval.md)).

Why:

- Labels exist by construction, so outcomes can be scored against truth Signal cannot see (duplicates left behind, wrong attachments).
- Seeded policies make runs reproducible and cheap enough to repeat. Sweeping their parameters shows which conclusions depend on assumed behaviour.
- Building the baseline on the same operations isolates the AI's contribution, and it exercises REST and both MCP servers together.

## Consequences

- Conclusions are conditional on the swept behaviour ranges. Riskiest assumption 1 still needs real users.
- The recipe and worlds become maintained assets. Changes ship as new versions, never in-place edits, and `crewday-test` must stay unused for tuning.
- The domain must stay drivable by an injected clock and AI ports (`configureSignalRuntime`). New operations that read wall-clock time directly would break the simulation.
- Persona-agent realism (option 3) stays available as a later layer on the same world.
