---
name: to-spec
description: Turn the conversation into a numbered draft spec using project conventions, and accept it when approved. Use when the user says "spec it", "write a spec", "share the draft", or "accept the spec".
disable-model-invocation: false
---

# To Spec

Turn conversation context and repository understanding into a proportionate specification. Do not run a separate interview; synthesize what is already known and label unresolved assumptions rather than inventing decisions.

Use the project's existing spec location and numbering; with no convention, write `docs/specs/NNN-short-name.md` (three-digit sequence, kebab-case slug). Take a number no local or remote branch already uses. Outside a Git repository, offer `git init` and stop on a no. Commit on the work's branch, never the default branch, candidate stubs included: the branch already open for this work (exploration included), or a new `spec/<number>-<slug>` branch (`build`'s Pull request). The spec merges with the work.

**Spec, tasks, decision.** A spec is one bet: it tests one assumption and ships as one unit. Its tasks are the slices inside it, so a spec may be large. Work that only makes sense after seeing how another bet did gets its own spec. Split into several specs only when each increment proves something on its own, ships safely alone, exceeds one appetite, or depends on learning from an earlier one; a promising later idea is a candidate stub only when it is worth triaging. A choice gets a decision record in `docs/decisions/NNNN-short-name.md` (four-digit sequence) only when it chose among real alternatives **and** reaches beyond this spec or is costly to reverse; otherwise it belongs in the spec's Implementation Decisions. Never put feature scope or tasks in a decision record. When a spec makes a choice that passes the test, write the record beside the spec with status **Proposed** and link it from the spec. Also link any **Proposed** records written during exploration that the spec depends on.

Specs may cover product, research, marketing, engineering, operations, or cross-functional work. Use the sections below only when they fit; omit irrelevant headings. Keep small, understood changes brief.

**Candidate specs.** A later bet that should not be specified yet gets a stub file with status `candidate`: the problem and the assumption it tests, no tasks. Flesh it out into a full draft when its turn comes.

**Issues.** Specs live in files; open no issue unless the user asks, and never one per session, worker, or task, or one that copies the spec. Reference an existing issue when it is relevant. When the spec fleshes out an issue the user named, the pull request closes it (`Closes #N`).

## Status and acceptance

A spec's `Status:` line reads `candidate`, `draft`, `accepted`, `implemented`, or `dropped`, with the date. `to-spec` writes `candidate` and `draft` and owns acceptance; `build` sets `implemented` once every task integrates, and `ship` sets it if still missing; `ship` drops a spec.

**Acceptance** happens when the user says "accept the spec", or "build it" or "ship it" on a draft (`build` and `ship` apply these steps in their first commit). Writing a draft is not acceptance. In one commit:

- Set the spec's status to `accepted`, and each decision record it links from **Proposed** to **Accepted**, with the date, in the project's decision format.
- Write the back-pointers. For each linked record that supersedes or amends an older one, append `Superseded by [NNNN]`, `Superseded in part by [NNNN]`, or `Amended by [NNNN]`, with a short scope, to the older record's Status line (in a frontmatter format, set `superseded_by` instead, and `status: superseded` only for a full supersession) and index row, and to the Status line of each spec it changes; update each contradicted `PRODUCT.md` fact to the new position, linking the record. Entries in the spec's Direction changes section get the same spec and `PRODUCT.md` updates, linking the spec.
- Never write back-pointers before acceptance. A back-pointer is not a scope change and does not return another spec to `draft`.

A draft without an acceptance scenario, or without an **Exposure** line when it adds deployable behaviour, stays `draft`: name what is missing and stop the request. A `candidate` must become a full draft first. Changing an accepted spec's scope or a decision it links returns it to `draft`. Report the files changed.

**Share the draft** (comments before acceptance): push the branch and open its draft pull request, which `build` later reuses, with a body that links the spec file; in local mode (`origin` is not on GitHub, or the user named local) there is nothing to open, so report the file. On a public repository, say the branch becomes public.

## Process

1. Explore the repository only for what the conversation does not already hold (fan-out rule: `write-agents` Workers): existing specs and decisions, code seams and tests, and the glossary. Name things with the project's terms (`domain-modeling` Shared language). Before writing, check for contradictions with accepted decisions, specs, and `PRODUCT.md` (a goal that would reverse or narrow an Accepted decision, an accepted spec, or a `PRODUCT.md` fact stops for an explicit yes, as `explore`'s Direction changes describes), asking only about conflicts not already confirmed in this conversation or in a Proposed record on the current branch.

2. Sketch test seams at the highest practical level. Prefer existing seams.

3. Write the spec with status `draft` and the date, and any decision record it needs as **Proposed**, and commit them on the work's branch. "Spec it" publishes nothing. Do not show the text inline or ask before writing; report, as `tldr`'s Handoff digest, links to the files, open assumptions, and the next step: "build it", "accept the spec", or "share the draft".

<spec-template>

## Problem Statement

The problem from the affected user's perspective.

## Solution

The intended solution from the user's perspective.

## User Stories

Essential scenarios and acceptance criteria when they improve clarity, for example:

1. As an <actor>, I want a <feature>, so that <benefit>

Cover consequential paths and failure cases without redundant stories.

## Implementation Decisions

Decisions that shape execution: modules, interfaces, contracts, schema, or interactions. Prefer stable interfaces and intent over exhaustive file lists.

**Exposure** (required when the spec adds deployable behaviour): where the slice runs, who can reach it, and how writes behave when deployed without authentication. When authentication is out of scope, write paths fail closed on deployment.

Write interfaces contract-first, before any UI: the typed API shape the UI uses; MCP tool definitions when the product names agent users; and errors and permissions an agent can act on. Specify an MCP App only when a journey needs the product's UI inside an agent host; otherwise plain MCP tools suffice.

When a prototype encodes a decision more precisely than prose (state machine, schema, type shape), inline the decision-rich excerpt and note that it came from a prototype.

## Testing Decisions

What good tests mean here, which behavior is in scope, and prior art in the codebase.

**Behavior and checks:** the observable behavior at the contract as concrete examples with realistic domain data, the invariants that must always hold, and the focused check that proves each (the seam, and the command that runs only it). State behavior, not implementation steps. Which checks to write, and whether UI gets any, follows `build` Tests.

**Acceptance scenario** (required; `review` gives each step a verdict): one representative end-to-end journey. Name the actor, the starting state with realistic data, and numbered steps with the observable result of each. When the spec names agent users, give the same journey through the agent interface (MCP tool). When the work should move a defined metric or journey, reference its definition, name the source or instrumentation and calculation, and add a step proving an outcome is counted correctly: failures excluded, retries and duplicates counted once, human and agent attributed when that changes the count. Reuse existing collection; label unknowns instead of assuming infrastructure. Unrelated work gets no measurement.

## Appetite

For substantial work: the delivery target for this increment (time, and model, evaluation, or infrastructure cost when material), the first verifiable slice, and what gives way when it runs out. A target, not a guarantee. Record start and end when observed; otherwise "not measured". Omit for small changes.

## Direction changes

Confirmed changes to accepted specs or `PRODUCT.md` facts that got no decision record: the file, the old position, and the new one.

## Out of Scope

What this increment explicitly does not include.

## Further Notes

Additional context that helps execution or review.

</spec-template>
