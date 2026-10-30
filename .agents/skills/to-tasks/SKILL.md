---
name: to-tasks
description: Break a plan, spec, or conversation into verifiable vertical-slice tasks with explicit blockers; list them in the spec's Tasks checklist. Use when the user says "break it down", "make tasks", or "split this into tasks".
disable-model-invocation: false
---

# To Tasks

Break a plan, spec, or conversation into **tasks**: independently verifiable vertical slices, each naming the tasks that **block** it.

Prefer the fewest tasks that each verify on their own. Keep a straightforward change as one task; split only when slices can proceed in parallel, need separate review, or would not fit one session. A task per layer, file, or step is too fine: every task costs a record, an integration, and a check.

## Process

### 1. Gather context

Work from the conversation. If the user passes a spec path, issue, or URL, read it in full, comments included.

### 2. Explore the codebase (optional)

When you have not already explored the codebase, read the areas the work touches to see the current state (fan-out rule: `write-agents` Workers). Task titles and descriptions should use the project glossary and respect decision records in the area you touch.

Look for prefactors that make the implementation easier: make the change easy, then make the easy change.

### 3. Draft vertical slices

Break the work into vertical-slice tasks.

<vertical-slice-rules>

- Each slice delivers narrow, verifiable behavior across the layers the product needs. Include schema, API, UI, or tests only where the task requires them.
- A completed slice is demoable or verifiable on its own.
- Each slice fits a single fresh context window.
- Do prefactoring first when it is part of the plan.

</vertical-slice-rules>

Give each task an **area**: every package or directory it changes, comma-separated (for example `lib/feedback/connect, app/opportunities`), coarse and never file paths. A vertical slice names every directory it touches, including pages or routes outside its main package, so disjoint areas mean disjoint changes. Overlapping areas need no blocking edge; `build` uses areas to keep overlapping edits from landing as if independent.

Give each task its **blocking edges**: other tasks that must finish before it can start. An edge needs a real data or file dependency: one task uses what the other builds, or both must change the same file in order. Topic order is not a reason; prefer a wide frontier, where tasks that share only the spec have no blockers. A task with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **affected scope** spans the codebase, so one edit breaks many call sites and no vertical slice can land green. Sequence it as **expand–contract**. Expand: add the new form beside the old so nothing breaks. Migrate call sites in batches sized by impact (per package or directory), each batch its own task blocked by the expand, keeping CI green because the old form still exists. Contract: remove the old form once no caller remains, in a task blocked by every migrate batch. When batches cannot stay green alone, they may share an integration branch and a final integrate-and-verify task; green is promised only there.

### 4. Record and report

Resolve only consequential scope or sequencing uncertainty first; "break it down" authorizes recording, so do not show the tasks for approval before writing them.

Outside a Git repository, offer `git init` and stop on a no. Tasks are the spec's checklist: write its Tasks section, one line per task (`- [ ] NN: Title`), and detail each task below it with the task template. Commit on the spec's branch. Without a spec, write one with `to-spec` first, or return the tasks as a local draft and say so. Do not introduce a `.scratch/` task system or labels.

**Task issues** open only when the user asks: one per task from the issue template (sub-issues of the issue the user names, if any), opened in parallel, with blockers linked once every number exists (native blocked-by links where supported, otherwise `Blocked by #a, #b` atop the body); append `(#N)` to each checklist line. On a public repository, say the issues are public. If publishing stops partway, report which issues exist; on a retry, match existing issues by title and open only the missing ones.

Tasks are not pull requests; `build` owns how tasks group into pull requests. A task is **ready** when its blockers are complete.

Report where the tasks live, each task with what it delivers and its area, and the ready set, then wait for "build it". Do not start implementation.

<task-template>

### <NN>: <Task title>

**What to build:** the end-to-end behaviour this task makes work, from the user's perspective, not a layer-by-layer implementation list.

**Area:** every package or directory this task changes, comma-separated, never file paths.

**Blocked by:** the numbers or titles of tasks that gate this one, or "None (can start immediately)".

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</task-template>

<issue-template>

## Spec

A link to the spec file this task belongs to (omit only when the task belongs to no spec).

## What to build

Area: every package or directory this task changes, comma-separated, never file paths.

The end-to-end behaviour this task makes work, from the user's perspective, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

</issue-template>

Avoid specific file paths or code snippets in task text; they go stale quickly. Exception: a prototype snippet that encodes a decision more precisely than prose (state machine, reducer, schema, type shape). Inline it, note that it came from a prototype, and keep only the decision-rich parts.
