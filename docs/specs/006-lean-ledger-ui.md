# 006 — Lean Ledger UI: submit wizard, My signals that carry forward, and the PM console

Status: accepted (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md). Design: [DESIGN.md](../../DESIGN.md). Glossary: [GLOSSARY.md](../../GLOSSARY.md). Builds on [001](./001-signal-mvp.md) (accepted).
Decisions: [0005 My signals links carry forward; never grouped by email](../decisions/0005-my-signals-link-carries-forward.md) (Accepted).

**Bet.** A lean, goal-first UI raises the share of submitters who add their voice to an existing need (prevention rate, riskiest assumption 1) and lets a PM clear triage and publish decisions without leaving the console (decision latency, suggestion acceptance; assumption 3). Showing matches only after the person has written, with enough room to read them side by side, beats live suggestions while typing.

## Problem Statement

The public pages from 001 task 07 show matches while the person is still typing, which is busy and pushes them to stop writing before they have said what they experience. Matches are shown in a narrow panel, so people can't read a need well enough to decide it's theirs. A submitter who files twice gets two separate private links. PMs have no console: triage, need detail, criteria, metrics, and decisions exist only as operations and MCP tools (001 task 08 paused unreviewed on `build/t08`). The look grew from template defaults and was never decided.

## Solution

Every surface follows [DESIGN.md](../../DESIGN.md): one job and one primary action per screen, ruled lists with one inline expansion, side-by-side reading wherever someone judges "is this the same need?", and AI output in pencil until a person confirms it in ink.

- **Submit wizard (`/submit`).** Describe → Check → Details → Done. Nothing is suggested while typing. Check runs the duplicate check once, then shows up to three matches as a compact list with the selected one read side by side against what the person wrote. They add their voice or say it's a new need, then give contact details and how it affects them.
- **My signals that carry forward (`/my/[token]`).** A person's next submission joins the link they already hold, so their signals collect on one page. Never grouped by email ([0005](../decisions/0005-my-signals-link-carries-forward.md)).
- **Board (`/`) and need page (`/needs/[id]`)** restyled lean: search, a quiet status filter, ruled rows.
- **PM console (`/operator`).** Triage, Needs, need detail → decide → publish, Criteria, Metrics, and Chat, as prototyped in `docs/design/round-3/`.

## User Stories

1. As a submitter, I want to write what I need without suggestions interrupting me, so that I say what I'm actually experiencing.
2. As a submitter, after I continue, I want to read a likely match next to what I wrote, so that I can tell whether it's my need.
3. As a submitter, I want to add my voice to an existing need with how it affects me, so that my context reaches the product team without filing a duplicate.
4. As a submitter whose need is not listed, I want "None of these" one click away, so that I'm never forced onto a wrong match.
5. As a submitter who has filed before, I want my new request on the same My signals page, so that I follow everything I asked for in one place.
6. As someone on a shared computer, I want to see which My signals link I'm filing under and start a new one, so that my request doesn't land on someone else's page.
7. As a PM, I want to clear the triage queue one row at a time from the keyboard, reading merges side by side, so that I decide quickly without losing context.
8. As a PM, I want to reject a suggestion with a short reason, so that the reason is kept for later review and for tuning.
9. As a PM, I want to see every need with people, accounts, ARR, score, and pending suggestions in one table, so that I know where to look first.
10. As a PM, I want to override one priority criterion with a note, draft a decision brief, edit it, and publish a status and public note from one need page, so that deciding takes minutes.
11. As a PM, I want a warning when a public summary or decision note names a person, account, or email, so that nothing identifying is published.
12. As a PM, I want criteria weight changes to re-rank needs before I save, so that I see what a weight does.
13. As a PM, I want the three MVP metrics with people and agents counted apart, so that I know whether Signal works.
14. As an agent, I want to file a signal onto a link the submitter gave me, so that the person's signals stay together.

Failure paths:

- AI unavailable at Check → the step says matching is unavailable and offers "Submit as a new need"; submitting still works.
- Database unavailable → a plain message with retry, never a blank page.
- A remembered link that no longer resolves → submit issues a new link and Done says so.
- Unauthorized console request → the access page, never data.

## Implementation Decisions

### Contract changes (before any UI)

All changes go through the operation registry (`lib/signal/operations/`) and appear on REST, MCP, and agent tools together, with parity tests.

1. **`submit_signal` gains `trackingToken?`** (same schema as `trackingTokenSchema`). When it names an existing tracking link, the signal joins it and `trackingUrl` is that link's; when absent, or when the token resolves to no link, a new link is issued. Output adds `linkReused: boolean`. Idempotency is unchanged: a replay returns the original result.
2. **Tracking links, additive only.** Deploys refuse destructive migrations (`lib/db/migration-safety.ts`: no `UPDATE`, `DROP`, or `RENAME`), so the migration only adds: a `tracking_links (id, token unique, created_at)` table and a nullable `signals.tracking_link_id`. `signals.tracking_token` stays, unique per signal. New submissions create or reuse a link, set `tracking_link_id`, and return the link's token. A legacy token (a signal with no link) is adopted at runtime the first time it is used, in `get_my_signals` or as a `submit_signal` `trackingToken`: the app creates a link with that same token and attaches the legacy signal, so old URLs keep working. `get_my_signals(token)` returns every signal on that link, newest first. Nothing reads or groups by email.
3. **`resolve_suggestion` gains `reason?`** (≤ 500 chars) on `reject`; kept in the `suggestion.rejected` event payload (no schema change).
4. **New operator operation `list_operator_needs`** (`GET /api/operator/needs`, Operator MCP). Input: `themeId?`, `status?`, `query?`, `sort: priority | people | accounts | arr` (default priority, nulls last, then people). Output per live need: `id, statement, theme, status, people, accounts, arrCents, openDealCents, score | null, criterionScores | null, pendingSuggestions`. Replaces stitching `search_needs`, `get_demand_summary`, and `list_suggestions` in the client; Criteria's live re-rank computes from `criterionScores` in the browser.
5. **New operator operation `check_public_text`** (`POST /api/operator/check-public-text`): `{ text, needId? }` → `{ findings: { kind: "person" | "account" | "email", match }[] }`, matching submitter names, account names, and emails in the workspace (deterministic, no model). Used by summary approval and the decision note; findings warn and block the button until edited, they don't fail `publish_decision`.
6. **`get_demand_summary` gains `plan?`** (`Enterprise | Growth | Starter`) so "What are enterprise accounts blocked on?" is one call.

`preview_signal` is unchanged; the web client calls it once when the person continues from Describe (and again only if they edit their words), not debounced while typing.

### Public UI

- Wizard state lives in the URL step (`?step=describe|check|details|done`, nuqs) plus in-memory form state; Back keeps what was typed. Check shows a calm loading line while `preview_signal` runs.
- Check: compact ruled list of matches (statement + people), first selected; below, side by side: "What you wrote" + AI restatement (pencil) ↔ selected need (statement, approved summary or latest decision note, status, people, why it matches in pencil). Phone stacks need first. `additionalAsks` appear as one line offering to file them separately after this one.
- Details: "Adding your voice to …" / "New need: …" with Change; `useCase` ("How does this affect you?"), urgency, email, optional name and company; the line "Your words are kept as you wrote them and shown only to the product team. Your email is never public."; a "Filing under your My signals page · Start a new link" line when a link is remembered.
- The remembered link is the token in `localStorage` (`signal.myLink`), written after a successful submit; reads and writes are guarded and the flow works without it.
- Board and need page: restyle only, same data.

### PM console

Routes: `/operator/triage`, `/operator/needs`, `/operator/needs/[id]`, `/operator/criteria`, `/operator/metrics`, `/operator/chat`, behind the existing Operator access. Prototypes in `docs/design/round-3/` (`4a-triage.html`, `4b-decide.html`, `4c-overview.html`) are the interaction reference; DESIGN.md is the authority. Reuse what fits from `build/t08` (operator client, `use-operation`), not its layout.

- Triage: `list_suggestions` newest first; one row open; J/K/A/E/R/Esc; per-kind edits as `resolve_suggestion` allows; accepted merges keep "Undo merge" (`undo_merge`); reject takes an optional reason; empty state "All caught up".
- Needs: `list_operator_needs`; filters and sort in the URL; a row expands to the two most urgent verbatim signals and the score breakdown.
- Need → decide: `get_need_detail`; override one criterion (`resolve_suggestion` edit with a required note) when a priority suggestion is pending; `draft_decision_brief` → edit → Decide side by side → `publish_decision`; confirmation shows the public need as supporters see it.
- Criteria: `get_criteria` / `set_criteria`; weights must sum to 1.00; live re-rank preview; Undo after save restores the previous weights.
- Metrics: `get_metrics`, 28 / 90 days; large mono numbers with one-line definitions; people and agents apart; unknown baselines labelled.
- Chat: the existing Operator agent, rendered as question → pencil answer with linked needs and a cited-needs list.

### Exposure

Public pages and `submit_signal` stay public and rate limited as in 001; a `trackingToken` only adds a signal to a link the caller already holds and never reveals other signals. `list_operator_needs` and `check_public_text` are operator access only, on the Operator REST prefix and Operator MCP, and fail closed when `OPERATOR_SECRET` is unset; they never appear in public MCP discovery. The console is unreachable without the Operator secret, as today.

## Testing Decisions

- Contract-first, red → green, as in 001: parity tests for each changed or new operation across REST, MCP, and agent tools; domain tests for link reuse (existing, unknown, legacy token adoption, replayed idempotency key), the additive migration passing `migration-safety`, reject reasons, `check_public_text` matches, and `list_operator_needs` sorting with null scores.
- Isolation tests: the new operator operations are absent from public discovery and return `unauthorized` without the secret; `get_my_signals` never returns a signal from another link that shares the email.
- Playwright on seeded data for the wizard (including AI unavailable, None of these, carry-forward and Start a new link), triage keyboard flow, and decide → publish. Prior art: `tests/mcp/operator-isolation.test.ts`, `tests/mcp/route.test.ts`, existing Playwright setup.
- Visual checks from DESIGN.md → Checking rendered output: pencil vs ink, no PII on public pages, light/dark AA, no sideways scroll at 390px.

**Acceptance scenario.**

Starting state: seeded workspace (`pnpm db:seed`), N1 "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers" open with 11 people; N2 compliance archive open. `OPERATOR_SECRET` set; AI Gateway available. Maya has previously submitted once from this browser, so a link is remembered.

Human journey:

1. Maya opens `/submit`, types title "Monthly PDF of the revenue dashboard" and body "Our CFO wants a PDF of the revenue dashboard every month for the board pack." → no matches or suggestions appear while she types.
2. She presses Continue → a loading line, then within 2 s N1 is selected first, shown side by side with her words and a pencil "why it matches"; N2 is listed but not first.
3. She adds her voice to N1, enters "board pack every month, ~2 hours of manual work", urgency High, maya@acme.example → Details shows "Filing under your My signals page"; Done shows the same link as her first submission (`linkReused: true`).
4. She opens the link → both of her signals appear on one page, newest first. Someone else submitting with maya@acme.example from another browser gets a different link that shows only their signal.
5. The PM opens `/operator/triage`, presses J/K to a theme suggestion, R, types reason "Too broad" and Enter → the row resolves as rejected; the `suggestion.rejected` event carries the reason.
6. On `/operator/needs` the PM sorts by priority → rows show people, accounts, ARR, score (nulls last), and pending markers from one `list_operator_needs` call.
7. The PM opens N1, drafts a brief, edits it, chooses Planned and types a note containing "Acme" → the note shows a finding and Publish is blocked; after removing it, Publish → N1 is Planned and Maya's My signals page shows the decision.
8. `/operator/metrics` (28 days) → prevention rate counts Maya's new signal once in the numerator under people; a replay of her submit with the same `idempotencyKey` adds nothing.

Agent journey: an Assistant agent calls `preview_signal`, then `submit_signal` with `target.needId = N1` and the `trackingToken` Maya gave it → `linkReused: true`, and `get_my_signals` lists all three signals. An Operator agent calls `list_operator_needs` and `get_demand_summary { plan: "Enterprise" }` with the bearer secret → results; the same calls on public MCP are absent or `unauthorized`.

## Tasks

- [x] 01: Ledger UI primitives
- [x] 02: My signals links that carry forward
- [ ] 03: Operator contract additions
- [ ] 04: Public board, submit wizard, and My signals UI
- [ ] 05: Console shell, Triage, and Needs
- [ ] 06: Need detail, decide, and publish
- [ ] 07: Criteria, Metrics, and Chat
- [ ] 08: Acceptance run and docs

Ready now: 01, 02, 03. Then 04 (after 01, 02) and 05 (after 01, 03); 06 and 07 run in parallel after 05; 08 last.

### 01: Ledger UI primitives

**What to build:** the shared pieces every Ledger screen uses, so public and console screens look and behave the same: pencil and ink blocks (with Suggested, edited, and rejected states), customer quote, status word with its shape, demand band, ruled list with a single inline-expanding row, side-by-side reading pair that stacks on phone, calm loading line, and quiet keyboard hint.

**Area:** components, app/_components

**Blocked by:** None (can start immediately)

- [ ] Each primitive renders in light and dark with the DESIGN.md tokens; status never relies on colour alone.
- [ ] The ruled list allows exactly one expanded row and is keyboard reachable; the side-by-side pair stacks at 390px with no sideways scroll.
- [ ] Component tests cover pencil/ink states and the single-expansion rule.

### 02: My signals links that carry forward

**What to build:** a person who already holds a My signals link files new signals onto it, from the web or through an agent, and sees them all on one page; old per-signal links keep working; nothing is ever grouped by email.

**Area:** lib/db, drizzle, lib/signal, agents, tests

**Blocked by:** None (can start immediately)

- [ ] Additive migration (tracking links table, nullable link reference on signals) passes `migration-safety`.
- [ ] `submit_signal` accepts `trackingToken` and returns `linkReused`; existing, unknown, legacy, and replayed-idempotency cases behave as the spec says; parity on REST, public MCP, and the Assistant agent tool.
- [ ] `get_my_signals` returns every signal on a link, adopting a legacy token on first use; two links sharing an email never see each other's signals.
- [ ] The Assistant agent's instructions say to pass a token only when the submitter gave it.

### 03: Operator contract additions

**What to build:** what the console needs from the API in one place: every live need with people, accounts, ARR, open deals, score, criterion scores, and pending suggestions in one call; a deterministic check that flags names, accounts, and emails in public text; a reason on rejected suggestions; and a plan filter on the demand summary.

**Area:** lib/signal, agents, tests

**Blocked by:** None (can start immediately)

- [ ] `list_operator_needs` and `check_public_text` exist on the Operator REST prefix, Operator MCP, and Operator agent tools, absent from public discovery, `unauthorized` without the secret, fail closed when `OPERATOR_SECRET` is unset.
- [ ] `list_operator_needs` filters by theme, status, and query and sorts by priority (nulls last, then people), people, accounts, or ARR.
- [ ] `resolve_suggestion` reject accepts `reason` and the `suggestion.rejected` event carries it; `get_demand_summary` filters by `plan`.
- [ ] The typed client is regenerated; parity and domain tests are written red first.

### 04: Public board, submit wizard, and My signals UI

**What to build:** customers use the lean public pages: a ruled board and need page, the Describe → Check → Details → Done wizard with the side-by-side Check and no suggestions while typing, and a My signals page that collects every signal on the link, with the remembered link and "Start a new link".

**Area:** app, components, lib/signal, tests

**Blocked by:** 01, 02

- [ ] Nothing is suggested while typing; `preview_signal` runs once on Continue and again only after the words change; Back keeps what was typed.
- [ ] Check shows up to three matches with the first read side by side; "None of these" is one click; additional asks are offered in one line; AI-unavailable and database-unavailable states are explained.
- [ ] Details shows where it lands with Change and which My signals link it files under; Done shows the link and whether it was reused.
- [ ] Public pages show no PII of other customers; Playwright covers the wizard, carry-forward, and Start a new link.

### 05: Console shell, Triage, and Needs

**What to build:** a PM signs in to the Ledger console, clears the triage queue one row at a time from the keyboard (merges read side by side, Undo merge kept, reject with reason, All caught up), and scans every need in one sortable table whose rows expand to the top verbatim signals and score breakdown.

**Area:** app/operator, components, lib/signal, tests

**Blocked by:** 01, 03

- [ ] Shell: Triage (live count) · Needs · Criteria · Metrics · Chat, behind Operator access; unauthorized shows the access page.
- [ ] Triage: J/K/A/E/R/Esc work; each suggestion kind edits only what `resolve_suggestion` allows; summary approval runs `check_public_text` and blocks on findings.
- [ ] Needs reads `list_operator_needs` with filters and sort in the URL.
- [ ] Takes client plumbing from `build/t08` where it fits; Playwright covers the triage keyboard flow.

### 06: Need detail, decide, and publish

**What to build:** from a need, a PM reads every signal verbatim and the merge history, overrides one priority criterion with a note, drafts and edits a decision brief, decides status and public note side by side, and publishes; the confirmation shows what supporters see.

**Area:** app/operator, components, tests

**Blocked by:** 05

- [ ] The override needs a note and is offered only while a priority suggestion is pending.
- [ ] The brief stays pencil until accepted or edited; the public note runs `check_public_text` and Publish is blocked on findings.
- [ ] After publishing, the need's status and note show on the public need and on the supporters' My signals pages.

### 07: Criteria, Metrics, and Chat

**What to build:** a PM changes criteria weights and sees needs re-rank before saving (with Undo), reads the three MVP metrics with people and agents apart, and asks the Operator chat demand questions answered with linked needs.

**Area:** app/operator, components, agents, tests

**Blocked by:** 05

- [ ] Weights must sum to 1.00 to save; the preview re-ranks from `list_operator_needs` criterion scores; Undo restores the previous weights.
- [ ] Metrics show 28 and 90 days, unknown baselines labelled, people and agents apart.
- [ ] "What are enterprise accounts blocked on?" is answered through `get_demand_summary` with `plan: Enterprise`, rendered as pencil prose with a cited-needs list.

### 08: Acceptance run and docs

**What to build:** evidence the spec works end to end for people and agents: the acceptance scenario on a fresh seed, locally and on the deployment, and the project docs brought in line.

**Area:** tests, docs, GLOSSARY.md, ARCHITECTURE.md

**Blocked by:** 04, 06, 07

- [ ] Every human and agent step of the acceptance scenario passes, with the metric step counting Maya's signal once.
- [ ] GLOSSARY defines My signals link (carries forward); ARCHITECTURE notes tracking links and the new operator operations; DESIGN.md's "Checking rendered output" passes on every screen.

## Direction changes

- [001](./001-signal-mvp.md) → Solution, UI: submit used a "form with debounced live preview" and matches shown "while a person or agent describes a need" → the web flow checks once after Describe, in a wizard; agents are unaffected.
- [001](./001-signal-mvp.md) → Schema: a tracking token per signal → tracking links shared by a holder's signals (the per-signal token column stays for compatibility) ([0005](../decisions/0005-my-signals-link-carries-forward.md)).
- [001](./001-signal-mvp.md) → UI: "Visual direction is open" → settled in [DESIGN.md](../../DESIGN.md). Task 08 (Operator console UI) is replaced by this spec.

## Out of Scope

- Email verification or magic links; grouping by email.
- File attachments and comments on needs.
- An AI explanation of how a weight change re-ranks needs.
- A false-match rate metric (unmerge rate and rejected merges stay as the guardrails).
- Overriding a priority score after its suggestion is resolved.
- Operator previews of a specific supporter's My signals page.
- Restyling `/genui` and `/dev`.

## Further Notes

- Prototypes in `docs/design/` are local and untracked; they are evidence, not the authority. Round-3 numbers differ between files (triage counts 7, 6, 5) because each was built from a different slice of the seed; the console reads live data.
- The seed scores only 4 of 23 needs, so "sorted by priority" mostly falls back to people; consider seeding more priority suggestions before the demo.
- `build/t08` holds about 2,100 lines of unreviewed console UI; take its client plumbing, rebuild the screens to DESIGN.md.
