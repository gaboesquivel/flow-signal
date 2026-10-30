# 009 — Post-submission duplicate backstop

Status: accepted (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Metrics (prevention rate), Riskiest assumption 1, Diagnostics. Builds on [spec 001](./001-signal-mvp.md) (off-hot-path `merge` suggestions), [spec 004](./004-crewday-outcome-eval.md) (true prevention rate), and [spec 012](./012-match-exposure.md) (`preview.shown`, `signal.created.exposure`).

**Bet.** If Signal keeps looking for duplicates after a draft is filed (again when anything relevant changes, against more than one candidate, and with the submitter asked directly), true prevention rate on Crewday rises (fewer duplicates nobody merged) without raising the unmerge or false-match rate.

## Problem Statement

Submitters and agents skip the three-step wizard and file duplicates anyway. The only backstop is one merge check per draft, run once right after submission (`proposeMerge` in [suggestion-generation.ts](../../lib/signal/domain/suggestion-generation.ts)), and it misses six things:

1. **It never runs again.** There is no sweep, and new supporters on the draft or on a candidate need don't trigger a recheck.
2. **Embedder-down drafts are never checked.** The draft is stored without a vector and the check is skipped; `pnpm db:embed` backfills the vector but never re-runs the check.
3. **Near-simultaneous drafts never meet.** Two drafts posted seconds apart can each be checked before the other is saved, so neither sees the other.
4. **One candidate only.** A draft that duplicates two needs gets one proposal, and when a PM rejects the best match the next one is never proposed.
5. **The submitter is never asked.** Only the PM sees the proposal; the person who skipped the wizard never hears "add your voice to X?".
6. **No server check for skipped previews.** A submission without a `previewId` gets no duplicate check of its own, and the skip is not reported as a rate.

## Solution

- **Merge checks with memory.** Each check of a draft need is recorded in a `merge_checks` row: when it ran, which candidates it saw, and how many supporters each had. A draft is **due** for another check when it was never checked, gained supporters, its nearest candidates changed (a new or newly embedded need appeared), or a candidate gained supporters. Deciding "due" costs no model call.
- **Duplicate sweep.** `sweepDuplicates` walks live drafts from the last 30 days and checks the due ones, a few per run. It runs off the hot path after every submission (the existing `after()` scheduler, in the same task as suggestion generation), after `pnpm db:embed`, and on demand through a new Operator operation, `sweep_duplicates`.
- **Embed on check.** A check embeds a draft that has no vector and stores it, so the draft becomes a candidate for others too.
- **Multi-candidate merges.** A check excludes needs already proposed for this draft (pending or rejected merge suggestions) and needs with a pending merge proposal into this draft, then asks the unchanged merge judge. When it names a candidate, the check asks once more without it, so up to two merge suggestions come out of one check.
- **Submitter follow-up.** On My signals (web and `get_my_signals`), a signal on a draft that the holder alone supports shows each pending merge proposal as "Is this the same need?". The holder answers through a new public operation, `answer_suggested_match`: **join** merges their draft into the proposed need (accepting the PM suggestion, as the submitter); **decline** keeps it and marks the suggestion so the PM sees the submitter said no.
- **Server check for skipped previews.** `submit_signal` with a new-need target and no usable preview (`exposure.kind` `skipped` or `unknown`) runs the preview's retrieve and judge steps and returns `possibleDuplicates`. The draft is still created. `get_metrics` adds **skip rate** (submissions with no `previewId` ÷ all submissions) to the exposure block.

## User Stories

1. As a PM, I want drafts filed while the embedder was down to get a merge proposal once they are embedded, so that an outage doesn't let duplicates through.
2. As a PM, I want two near-identical drafts filed seconds apart to end up proposed for merge, so that a burst of submissions doesn't fork a need.
3. As a PM, I want a second merge proposal when a draft duplicates two needs, or when I reject the first one, so that I am not left to find the other match myself.
4. As a submitter who skipped the wizard, I want My signals to ask whether my request is the same as an existing need, so that I can add my voice there with one click.
5. As an agent posting straight to `submit_signal`, I want the response to list possible duplicates, so that I can ask my user before they end up with a duplicate.
6. As a PM, I want to see what share of submissions skip the preview, so that I know how much the backstop is carrying.

## Implementation Decisions

**Scheduling: the existing off-hot-path scheduler, no cron.** The project has no Vercel cron or cron route; off-hot-path work runs with `after()` through `scheduleOffHotPath` ([scheduler.ts](../../lib/signal/domain/scheduler.ts)). The sweep rides on it: `scheduleSuggestionGeneration` runs generation for the new signal, then one bounded sweep (at most `SWEEP_CHECKS_PER_RUN = 2` due drafts). Every submission is a sweep tick, and new supporters arrive by submission, so a recheck triggered by a new supporter happens in the same task. Without submissions nothing becomes due except embedder backfills, which `pnpm db:embed` sweeps right after embedding. `sweep_duplicates` covers anything else on demand. A Vercel cron calling `sweep_duplicates` is out of scope.

**The merge judge stays put.** The judge call (prompt, schema, `task: "merge"`) is pulled out of `proposeMerge` unchanged as `judgeMergeCandidates(ai, statement, candidates)` in its own module, [merge-judge.ts](../../lib/signal/domain/merge-judge.ts), so the backstop and generation can both call it without an import cycle. Multi-candidate and sweep logic live in a new [duplicate-backstop.ts](../../lib/signal/domain/duplicate-backstop.ts) and call it, so a later swap of the judge (spec 008) changes one function. Generation's `merge` kind now calls `checkDraftForDuplicates` for drafts, so the first check and every recheck share one path and write the same `merge_checks` row.

**`merge_checks` table (additive migration).**

```ts
merge_checks: {
  needId: uuid; // primary key → needs.id (the draft)
  checkedAt: timestamptz;
  draftSupporters: int; // signals on the draft at check time
  candidates: jsonb; // [{ needId, supporters }] the judge saw, nearest first
}
```

**Due rule.** For a live draft (status `draft`) created within 30 days: never checked; or its signal count differs from `draftSupporters`; or its current eligible candidates (nearest `MERGE_CANDIDATES`, after exclusions) differ as a set from the stored ones; or any stored candidate now has more supporters. Retrieval is a pgvector query, so deciding "due" costs no model call. A draft without a vector is embedded first; if the embedder is down it stays unchecked (and due).

**Exclusions.** A check never re-proposes a need already in a pending or rejected merge suggestion from this draft, never proposes a need that has a pending merge suggestion into this draft (no mutual proposals), and never proposes the draft itself. Before inserting, it rechecks inside the transaction that no pending or rejected suggestion for the same pair exists, so overlapping sweeps don't double-propose.

**Spend.** One reasoner call per check, a second only when the first proposes a merge; at most two checks per sweep tick. PRODUCT.md's guardrail (under $0.01 per signal) is already over at $0.014; the due rule keeps sweeps at zero model calls when nothing changed. Measure with Crewday's generation-spend test before raising the per-tick bound.

**Submitter follow-up.**

- `get_my_signals` adds `suggestedMatches: [{ suggestionId, need: <public need> }]` to each signal (usually empty). Offered only when the signal's need is a live draft, every signal on it is on the holder's link, the target is live, and the holder hasn't declined it.
- `answer_suggested_match` (public; REST `POST /api/my-signals/:token/matches/:suggestionId`, public MCP, Assistant agent): input `{ token, suggestionId, answer: "join" | "decline" }`. Errors: `not_found` (unknown token, or a suggestion not offered on that link) and `conflict` (no longer pending, the draft gained another supporter, or a need was merged meanwhile). **Join** runs `mergeNeeds` with the submitter as actor and marks the suggestion `accepted` in the same transaction (event `suggestion.accepted` with payload `{ kind: "merge", via: "submitter" }`); PMs can undo it like any merge. **Decline** leaves the suggestion pending for the PM and adds `submitterDeclined: true` to its payload. Both record `follow_up.answered` (`needId` = the draft, payload `{ suggestionId, intoNeedId, answer }`, `dedupeKey` per suggestion). Output: `{ answer, needId }`, where `needId` is the need the signal is on now.

**Server check on `submit_signal`.** Only for `target.newNeed` with exposure `skipped` or `unknown`. Before the transaction (no network inside it): retrieve `CANDIDATE_LIMIT` needs with the statement embedding already computed for the draft, judge with `ctx.ai.judge` (the same match judge as preview; Jev by default since spec 008), and keep matches with `chooseMatches` at the judge's threshold, as preview does (at most 3). AI unavailable means an empty list, never a failure. The output adds `possibleDuplicates: [{ needId, statement, probability, status, supporterCount }]`, always present (empty otherwise). `signal.created` gets `possibleDuplicates: [{ needId, probability }]` so a replay returns the same needs (re-read as they are now). No `skippedPreview` flag: spec 012's `exposure.kind = "skipped"` already records it.

**Metrics.** The exposure block in `get_metrics` adds `skipRate` = `skipped` ÷ (shown + noneShown + skipped + unknown), null on zero. One field, computed from counts the block already has.

**UI.** On `/my/<token>`, a signal with suggested matches shows each as a pencil note ("Is this the same need?") with the need's statement and supporters, and two buttons: "Add my voice there" and "No, mine is different". The page posts through a server action and the typed client.

**Exposure.** `answer_suggested_match` is public and token-gated like `get_my_signals`: the token is the proof, and it only acts on a draft the holder alone supports. Rate limited (20/min per IP). `sweep_duplicates` is Operator-only, `effects: "write"` (it creates suggestions), and fails closed without the secret.

## Testing Decisions

Test-first in domain tests on PGlite (or `DATABASE_URL_TEST`) with the fake AI; parity for the new and changed operation shapes. Prior art: `tests/signal/domain/suggestion-generation.test.ts`, `tests/signal/domain/submissions.test.ts`, `tests/signal/parity/*`.

In scope:

- Due rule: never checked, draft gained a supporter, a candidate gained a supporter, a new candidate appeared, nothing changed (not due, no model call).
- Embedder down: no check recorded; after `embedMissingNeeds` the sweep checks it and proposes.
- Two drafts created back to back: the first's check misses the second; a sweep proposes the merge exactly once (no mutual proposal).
- Multi-candidate: two proposals from one check; after a rejection, the rejected need is never proposed again.
- Follow-up: offered only on a holder-only draft; join merges and accepts; decline marks the suggestion and hides it; a wrong token is `not_found`; a draft with another supporter is not offered and join returns `conflict`.
- `submit_signal`: skipped and unknown previews return `possibleDuplicates`; a shown preview returns `[]`; AI down returns `[]` and the submission succeeds; a replay returns the same list.
- Metrics: `skipRate` on a hand-built history.
- Parity: `answer_suggested_match` (REST, public MCP, agent), `sweep_duplicates` (REST, Operator MCP, Operator agent; `unauthorized` without the secret), and `get_my_signals` and `submit_signal` with the new fields.

**Acceptance scenario.** On a test database with need N1 ("Executives need to share dashboard snapshots so that board meetings use current numbers") and N2 (a monthly KPI export for board packs):

1. An agent calls `submit_signal` with no `previewId` and a new-need statement about board dashboard snapshots. The response lists N1 in `possibleDuplicates`; draft D1 exists.
2. Generation runs: one check proposes D1 → N1 and, asked again without N1, D1 → N2.
3. The PM rejects D1 → N2. A later sweep with nothing changed makes no model call.
4. Maya opens her My signals link and sees "Is this the same need?" for N1. She clicks "Add my voice there": D1 is merged into N1, the suggestion is accepted via the submitter, and her signal now shows N1.
5. With the embedder down, Dana files draft D2. No check is recorded. `pnpm db:embed` embeds it and sweeps: D2 gets a merge proposal.
6. Drafts D3 and D4 with the same statement are submitted back to back, and D3's check runs before D4 exists. The next sweep proposes one merge between them, once.
7. `get_metrics` reports `skipRate` for agents as the share of their submissions without a `previewId`.
8. On Crewday (on demand), true prevention rate for the Signal arm rises against the last run, with unmerge and false-match rates not higher.

## Out of Scope

- A Vercel cron or any new scheduling infrastructure.
- Changing the merge judge's prompt or model (spec 008 may swap it behind `judgeMergeCandidates`).
- Moving a single signal off a draft that others also support (the follow-up is offered only on holder-only drafts).
- Emailing submitters; the follow-up is on My signals and MCP only.
- Blocking a submission because of `possibleDuplicates`.

## Tasks

- [ ] 01: Merge checks with memory and multi-candidate proposals
- [ ] 02: Duplicate sweep on submission, after `db:embed`, and `sweep_duplicates`
- [ ] 03: Server check and `possibleDuplicates` on `submit_signal`; skip rate in metrics
- [ ] 04: Submitter follow-up: `suggestedMatches` and `answer_suggested_match`
- [ ] 05: Follow-up on `/my/<token>` and docs

### 01: Merge checks with memory and multi-candidate proposals

**What to build:** the `merge_checks` table and migration; `judgeMergeCandidates` extracted unchanged; `checkDraftForDuplicates` with exclusions, embed-on-check, and up to two proposals; generation's `merge` kind calls it.

**Area:** lib/db/schema.ts, drizzle/, lib/signal/domain/suggestion-generation.ts, lib/signal/domain/merge-judge.ts, lib/signal/domain/duplicate-backstop.ts, tests

**Blocked by:** None (can start immediately)

- [ ] Existing suggestion-generation tests pass; multi-candidate and rejected-candidate cases pass.

### 02: Duplicate sweep on submission, after `db:embed`, and `sweep_duplicates`

**What to build:** the due rule, `sweepDuplicates`, scheduling after generation, the `pnpm db:embed` sweep, and the Operator operation.

**Area:** lib/signal/domain/duplicate-backstop.ts, lib/signal/operations/sweep-duplicates.ts, scripts/db-embed.ts, tests

**Blocked by:** 01

- [ ] Due-rule, embedder-down, and back-to-back cases pass; parity passes for `sweep_duplicates`.

### 03: Server check and `possibleDuplicates` on `submit_signal`; skip rate in metrics

**What to build:** the pre-transaction check, the output field, the event payload, the description, and `skipRate`.

**Area:** lib/signal/domain/submissions.ts, lib/signal/operations/submit-signal.ts, lib/signal/metrics.ts, tests

**Blocked by:** None (can start immediately)

- [ ] Submission cases and the `skipRate` test pass; submit parity passes.

### 04: Submitter follow-up: `suggestedMatches` and `answer_suggested_match`

**What to build:** the My signals field and the public operation.

**Area:** lib/signal/domain/my-signals.ts, lib/signal/domain/duplicate-backstop.ts, lib/signal/operations/answer-suggested-match.ts, tests

**Blocked by:** 01

- [ ] Follow-up cases pass; parity passes for both operations.

### 05: Follow-up on `/my/<token>` and docs

**What to build:** the pencil note and buttons; GLOSSARY (merge check, duplicate sweep, suggested match), ARCHITECTURE (operations), PRODUCT (skip rate under Diagnostics).

**Area:** app/my/[token], docs

**Blocked by:** 04

- [ ] Acceptance step 4 checked by hand in the browser.

## Further Notes

- **Open assumptions:** two checks per sweep tick and two proposals per check; the 30-day sweep window; that a candidate gaining supporters is worth a recheck (the judge sees only statements, so this mostly re-asks a question already answered).
- **Spec 008:** merge proposals stay on the reasoning-model merge judge for now. They could later switch to the match judge on `ctx.ai.judge` (Jev by default since spec 008) by replacing the body of `judgeMergeCandidates` in `domain/merge-judge.ts`; its input (draft statement, candidate statements in order) and output (`{ model, candidate: number | null, reason }`) are the seam.
