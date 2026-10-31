---
name: design
description: Compare visual directions, let the user choose, and record the chosen identity and direction in DESIGN.md. Use when the user says "design this" or "what should it look like".
disable-model-invocation: false
---

# Design

## Outcome

"Design this" ends with a visual direction the user chose from real alternatives, recorded in root `DESIGN.md`, before implementation spends on it. Design owns visual direction and identity: name, mark, color, type, and the look of a surface. It writes `DESIGN.md`, the canonical assets, and the theme token values where the app already keeps them, so the record and the code agree; restyling components and pages is `build`.

Use it when a product has no visual identity yet, a new surface's look is not settled by `DESIGN.md`, or the user wants to change direction. Skip it when a change fits the existing `DESIGN.md`: build it following that file. When `DESIGN.md` already records an identity, new work extends it; reopening it is a direction change only the user starts. Product intent is `explore`'s; interaction and logic questions are `prototype`'s.

## Read first

Read, in parallel when there is more than a little: `PRODUCT.md` (the authority for purpose, users, and journeys), `DESIGN.md`, the tokens, theme, and brand assets already in code, and any references the user gave. A missing `DESIGN.md` does not erase the evidence in code. With no product brief, work from the stated intent and say in one line that `explore` would sharpen it; never block on it.

## Brief

State a short design brief in conversation: the surface and its purpose (decide and act, complete a task, understand, or explore), what the design must convey, constraints (existing tokens, accessibility, the sizes and contexts it renders in), and what to avoid. Infer what you can; ask only what stays open, in one round, including where to save the explorations: suggest a folder the project already uses for design work, else `docs/design/`, and whether it is tracked. With nothing open, continue to alternatives without waiting.

## Alternatives

Produce two to four directions that differ in concept, not only in color; when they take real work, generate them in parallel (`write-agents` Workers). For each: a name, the idea in one line, how it serves the brief, and its risks.

Render each so the user can judge it by eye, with whatever the host can produce: an image, an HTML or SVG page, or a design tool; for a page layout in the running app, `prototype`'s UI guidance shows variants on the real route. Show it in context at realistic sizes, never in a vacuum: an identity on the same real screen of the product for every direction, so the comparison is fair, plus the mark at 16 and 32 px and in a header, light and dark; a page at phone and desktop width with real content.

Look at each render before showing it (a screenshot or browser when the host has one; otherwise say it was not seen). Check contrast, small sizes, and that no mark reads as a well-known symbol or another brand.

Save exploration files where the user chose. They are evidence, never a second design authority: `DESIGN.md` holds the approved direction.

## Choose

Compare the directions side by side against the brief and recommend one with reasons. The user chooses, combines, or asks for another round; the agent never selects. Refine the chosen direction until the user approves it. An explicit yes to the shown direction is approval.

## Record

On approval, update `DESIGN.md`, keeping its existing sections (create it when missing): purpose and expression, identity (name, concept, canonical asset paths), tokens with roles, type, usage rules and what to avoid, and how to check rendered output. Record only the approved direction: alternatives and history stay out, and `DESIGN.md` is the record, with no separate decision record unless the user asks. Product goals stay in `PRODUCT.md`; link to them.

Commit the canonical assets the product uses and set the token values in the app's existing theme (for example its CSS variables), with one source for shared geometry and tokens that every surface reads. When cheap, name a check that asset variants (favicon, icons, social image) have not drifted from that source as work for `build`. When the direction replaces a name, mark, or token, list every surface that still shows the old one (pages, icons, page titles and metadata) for `build`.

Recording needs Git: outside a repository, offer `git init` and stop on a no. Write on the work's branch; on the default branch, cut one named for the work (for example `design/identity`). Commit only these writes and any explorations the user chose to track. The token change is reviewed and checked when "build it" or "ship it" runs on the branch.

## Completion

Report the chosen direction, the `DESIGN.md` sections and assets written, the branch and commit, the surfaces left to apply, and what was not verified (for example trademark clearance or recognition testing). Name "build it" as the next step and wait.
