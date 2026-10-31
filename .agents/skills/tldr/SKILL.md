---
name: tldr
description: Visual summary for a person, or a session recap and alignment check. Use when the user says "tldr", "show me", "recap", or "are we still aligned".
disable-model-invocation: false
---

# TL;DR

**Show, don't tell.**

Present the material the user names as a visual summary. When they ask for a recap, where you are, or whether you are still aligned, that material is the current or named session. Drafting prose is `write-humans`.

## Decide what matters

Check alignment when the request is about the session. Infer the user's goal, what changed, what is decided versus still open, and whether the agent is authorized for the next step. Separate facts from inference. Flag misalignment when the thread drifted, assumptions hardened without confirmation, or work ran ahead of authorization.

For an explanation, plan, or result, include only what that material supports.

## Respond visually first

- Prefer host-native generative UI (GenUI) when this session actually provides it: diagrams, charts, comparisons, timelines, and structured visual components.
- When it does not, use Mermaid for sequence, structure, flow, or containment, and a Markdown table for comparisons or a few labeled facts.
- Use a short statement when the material is a single fact, a limitation, or has no legitimate visual structure.

Chart only quantities the source states. Keep missing numbers and uncertainty visible. Do not imply controls the host does not provide.

Short labels only. When words are required, lead with the point, use concrete nouns, and do not invent facts or promises.

## Handoff digest

The one home for summaries at major handoffs: an `explore` brief, a spec ready, a build ready or stopped before its first write, a ship result, a retro. Those skills link here; using it needs no `tldr` run and no extra review step.

Lead with a few lines before any detail: the outcome, accepted versus deferred scope, appetite health only when measured, active work or conflicts that matter, verification status, and one next action. Link the spec, pull request, or diff instead of pasting it; give raw logs only on request. Use the visual rules above when structure helps; otherwise a compact table or a short paragraph. Keep it short, direct, and appropriately skeptical.

## Completion

End with at most one plain-language sentence when the request was about the session: aligned, needs clarification, or blocked — and the single best next question or action if not aligned.

Summarizing does not authorize implementation, file edits, or sending messages unless the user already authorized that work.
