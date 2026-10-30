# 012 — Match exposure: record which matches a submitter saw, so the main bet can be measured

Status: accepted (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Riskiest assumptions 1 and 2, Kill criterion (with real users), Metrics → Guardrails. Builds on [spec 001](./001-signal-mvp.md) (`preview_signal`, `submit_signal`, `get_metrics`, the event log) and [spec 006](./006-lean-ledger-ui.md) (the submit wizard and the metrics page).

**Bet.** If Signal records which matches each submitter was shown and which one they picked, the main bet (assumption 1) and the real-user kill criterion become measurable from the event log, with no new infrastructure.

## Problem Statement

Signal's main bet is that submitters will add their voice to an existing need instead of filing their own version. Nothing in the product can tell whether that is true:

- `preview_signal` stores nothing. `previewId` is a hash of the title and body ([matching.ts](../../lib/signal/domain/matching.ts) `previewIdFor`), and `signal.created` records only `attachedTo: existing | draft` and the `previewId` the caller sent.
- So a signal filed as new after Signal showed three good matches looks the same as one filed new because nothing matched. "Saw a match and filed new anyway" is exactly what assumption 1 is about.
- The real-user kill criterion is "over at least 200 submissions where Signal showed a match". Signal can't count that denominator.
- The live false-match guardrail ("over-eager matching would inflate prevention rate") has no source. False-match rate exists only in the offline eval, which is saturated (precision@3 1.0 on 131 self-written cases).
- A submission that skipped the preview (an agent posting straight to `submit_signal`) can't be told apart from one that saw no matches.

## Solution

Every preview records what it showed: the shown needs, in order, with their probabilities. It records no submitted text. When a submission arrives with that `previewId`, Signal stamps `signal.created` with the shown needs and the rank of the one chosen (or none). `get_metrics` turns that into:

- **Match take-up:** of submissions that were shown at least one match, the share that attached to a shown need. This is the direct measure of assumption 1.
- **Filed new despite a match:** split by what happened later. The PM merged the draft into a shown need (the submitter turned down a correct match), merged it elsewhere (Signal showed the wrong needs), or left it alone.
- **Moved off a taken match:** signals attached to a shown need that a PM later split off it. This is the live false-match proxy.
- **Skipped or unknown preview:** submissions with no `previewId`, or one Signal never issued or that has expired.
- **Kill-criterion progress:** all-time count of submissions shown a match against the 200 threshold, with prevention rate and unmerge rate over that population, and a verdict of `insufficient_data`, `pass`, or `fail`.

Humans and agents are reported separately, as for every MVP metric. PMs see the numbers on `/operator/metrics` and over Operator MCP.

## User Stories

1. As a PM, I want to see what share of submitters who were shown a match took it, so that I know whether the main bet is holding before I trust prevention rate.
2. As a PM, I want to see how many people filed new despite a match, and whether I later merged them into one of those matches, so that I can tell distrust of matches from bad matches.
3. As a PM, I want to see how close we are to 200 real submissions with a match shown, and whether the kill criterion passes, so that the pilot decision is a lookup, not a project.
4. As an agent using public MCP, I want `preview_signal` and `submit_signal` to keep their inputs and errors, so that my integration doesn't change. A `previewId` I lose or forge must never make a submission fail.
5. As a submitter, I want my preview text to stay private. Signal keeps only which needs it showed me, never what I typed before submitting.

## Implementation Decisions

**Where exposure is recorded: on the server, at preview time.** The rejected alternative was having the caller pass `shownNeedIds` to `submit_signal`. That keeps preview stateless, but it trusts the client for the metric that decides the kill criterion, and it can't see previews that never became a submission. Spec 001 already lists `preview_signal` as a public write (rate limited, size limited), so storing one event per call widens nothing.

**`preview.shown` event.** Written by `previewSubmission` after matches are chosen and before it responds. Written in the request, not in `after()`, so a submit that follows can always find it. One insert, which is small against the 4.7 s p95. A failed insert fails the preview as `database_unavailable`, as any database error does today.

```ts
// events row: type "preview.shown", actor from the request context, no need_id or signal_id
payload: {
  previewId: string; // random, see below
  ai: "ok" | "unavailable";
  matches: {
    needId: string;
    probability: number;
    rank: number;
  }
  []; // rank 1–3, as returned
  additionalAsks: number; // count only
}
dedupeKey: `preview.shown:${previewId}`;
```

No title, body, draft statement, or reason is stored. The payload holds need IDs and numbers only.

**`previewId` becomes random.** `pv_` plus 22 random base64url characters, minted per call. A content hash would make two submitters typing the same words share one exposure record. `previewIdFor` goes away. Tests that asserted a computed id assert the `^pv_` shape instead.

**Exposure on `signal.created`.** `submitSignal` looks up `preview.shown` by `previewId` before its transaction opens (no lookup while the transaction is open, matching the existing embed-before-transaction rule). It adds one field to the payload:

```ts
exposure:
  | { kind: "shown"; previewId: string; shownNeedIds: string[]; chosenRank: number | null }
  | { kind: "none_shown"; previewId: string }      // preview found, zero matches (or ai unavailable)
  | { kind: "skipped" }                            // no previewId sent
  | { kind: "unknown"; previewId: string }         // never issued, or older than 24 h
```

`chosenRank` is the 1-based rank of `target.needId` in `shownNeedIds`. It is `null` for a new need, or for a need the submitter found elsewhere, such as on the board. The existing `previewId` field stays for compatibility. Submit inputs, outputs, and errors are unchanged. An unknown or expired `previewId` never fails a submission. Idempotent retries return the prior signal and write no second event, as today.

**Exposure window.** 24 hours from `preview.shown` to submit. Later submissions record `unknown`. This is a proposal (see Further Notes).

**Metrics.** `get_metrics` gains an `exposure` block. Every rate is `null` on a zero denominator, split human vs. agent like the existing metrics, and windowed on `signal.created.occurred_at`:

| Field                             | Calculation                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shownSubmissions`                | `signal.created` with `exposure.kind = "shown"`                                                                                                             |
| `takeUpRate`                      | shown with `chosenRank` not null ÷ `shownSubmissions`                                                                                                       |
| `chosenRank`                      | counts for ranks 1, 2, 3                                                                                                                                    |
| `filedNewDespiteMatch`            | shown, `attachedTo = "draft"`; split into `mergedIntoShown`, `mergedElsewhere`, and `unmerged`, from `need.merged` not followed by `merge.undone`           |
| `movedOffTakenMatch`              | shown signals with `chosenRank` not null that appear in a later `need.split` `signalIds` from that need ÷ shown with `chosenRank` not null                  |
| `skipped`, `noneShown`, `unknown` | counts by `exposure.kind`                                                                                                                                   |
| `previewsWithoutSubmission`       | `preview.shown` with ≥ 1 match in the window and no `signal.created` carrying its `previewId` within 24 h. Diagnostic; one person may preview several times |

A separate `killCriterion` block ignores the window. It counts every `shown` submission ever (human and agent together, plus each alone). For that population it reports prevention rate (existing definition), plus the all-time unmerge rate (merges are need-level, so that guardrail is not split by population), and a verdict: `insufficient_data` under 200, `fail` when prevention rate < 30% or unmerge rate > 10%, and `pass` otherwise. Seeded demo history has no `exposure` field, so seeded data never counts toward it.

Calculations live in `lib/signal/metrics.ts` beside the existing ones and read only `events`, matching how prevention rate is computed. `close_the_loop_rate` stays in `unsupportedMetrics`.

**Contracts agents see.**

- `preview_signal` (public MCP, REST, Assistant agent): same input and output. The description drops "Read-only" and says Signal records which needs were shown, never the text.
- `submit_signal`: unchanged.
- `get_metrics` (Operator MCP, REST, Operator agent): the output schema adds `exposure` and `killCriterion`, and the description defines each field as above. Still `access: "operator"`; it returns `unauthorized` without the Operator secret.

**UI last.** `/operator/metrics` adds an "Exposure" panel (take-up, filed-new breakdown, skipped/unknown) and a kill-criterion line (`N / 200 · verdict`), through the typed client only, in the existing metrics view's style.

**Exposure.** `preview_signal` stays public and unauthenticated on every deployment: rate limited to 60 requests per minute per IP and size limited, as today. It now writes one `preview.shown` event per call holding need IDs and numbers only. `submit_signal` is unchanged. `get_metrics` and `/operator/metrics` stay Operator-only and fail closed without the secret on every deployment.

## Testing Decisions

Tests go test-first at the domain level, on hand-built event histories, like the existing metrics tests. Parity covers the operation surfaces. Prior art: `tests/signal/domain/submissions.test.ts`, `tests/signal/domain/matching.test.ts`, the metrics domain tests, and `tests/signal/parity/*`.

In scope:

- `preview.shown` holds no title, body, statement, or reason. A test asserts the payload keys.
- Each `exposure.kind`, including an expired preview and a forged `previewId`, records correctly, and none fails the submission.
- `chosenRank` is right for ranks 1–3, a new need, and a need outside the shown set.
- Metrics: retries counted once; failed submissions excluded; an undone merge leaves `mergedIntoShown`; human vs. agent attribution; seeded history never counts toward `killCriterion`; each verdict boundary (199 vs. 200, 30%, 10%).
- Parity: `preview_signal` returns a `^pv_` id on REST, public MCP, and the Assistant agent, and each call writes one event. `get_metrics` returns the same `exposure` block on REST, Operator MCP, and the Operator agent.
- Crewday's Signal arm and vote-board arm both call `preview_signal`, so both write exposure. A smoke test on the fixture world asserts `takeUpRate` is non-null for each arm.

**Acceptance scenario.** On a fresh seed of a test database, needs N1 ("execs need a PDF of the weekly report so they can read it offline") and N2 (PDF archiving for compliance) exist:

1. Maya (human, web wizard) enters "PDF export for my execs". The preview shows N1 at rank 1 and N2 at rank 2. One `preview.shown` event exists with those two need IDs and no text.
2. Maya adds her voice to N1. `signal.created` carries `exposure: { kind: "shown", shownNeedIds: [N1, N2], chosenRank: 1 }`.
3. Her client retries with the same `idempotencyKey`. It gets the same signal, and there is still one `signal.created`.
4. Dana (human) previews similar text, sees N1, and chooses "none of these". A draft D is created with `chosenRank: null`.
5. Support Copilot (agent, public MCP) calls `preview_signal`, then `submit_signal` with `target.needId = N2`. It records `chosenRank: 2`, attributed to the agent.
6. An agent calls `submit_signal` with no `previewId` and gets `exposure.kind = "skipped"`. Another sends `previewId: "pv_forged"`, gets `unknown`, and its submission succeeds.
7. A submission that fails validation writes no event.
8. The PM merges D into N1. `get_metrics` (Operator MCP and `/operator/metrics`) shows:
   - human `takeUpRate` 0.5 and agent `takeUpRate` 1.0
   - `filedNewDespiteMatch.mergedIntoShown` 1
   - `skipped` 1 and `unknown` 1
   - `killCriterion` 3 / 200, `insufficient_data`
9. The PM undoes the merge. `mergedIntoShown` drops to 0, and `unmerged` rises to 1.
10. Without the Operator secret, `get_metrics` returns `unauthorized`.

## Out of Scope

- A server-side duplicate check for skipped-preview submissions, sweeps, and submitter follow-ups. These stay in [spec 009](./009-duplicate-backstop.md).
- Close-the-loop rate (needs a tracking-page view event; [spec 003](./003-stakeholder-notifications.md) territory).
- Production latency and spend tracking for the hot path.
- Changing the match threshold, the number of matches, or the wizard's copy.
- Backfilling exposure for signals created before this ships. They count as no exposure.

## Tasks

- [x] 01: Record `preview.shown` with a random `previewId`
- [x] 02: Stamp exposure on `signal.created`
- [x] 03: Exposure and kill-criterion metrics in `get_metrics`
- [ ] 04: Exposure panel on `/operator/metrics`

### 01: Record `preview.shown` with a random `previewId`

**What to build:** `previewSubmission` mints a random `previewId` and writes `preview.shown` (payload above) before returning, including on `ai: "unavailable"`. Update the `preview_signal` description, and replace `previewIdFor` in tests.

**Area:** lib/signal/domain/matching.ts, lib/signal/operations/preview-signal.ts, tests

**Blocked by:** None (can start immediately)

- [ ] Every preview on every surface writes exactly one `preview.shown` with need IDs, probabilities, and ranks, and no text.
- [ ] Parity passes for `preview_signal` with the `^pv_` shape.

### 02: Stamp exposure on `signal.created`

**What to build:** `submitSignal` resolves the `previewId` before the transaction and writes `exposure` into the `signal.created` payload.

**Area:** lib/signal/domain/submissions.ts, tests

**Blocked by:** 01

- [ ] All four `exposure.kind` values and `chosenRank` record as specified. An unknown or expired id never fails a submission.
- [ ] Retries still write one event, and failed requests write none.

### 03: Exposure and kill-criterion metrics in `get_metrics`

**What to build:** the `exposure` and `killCriterion` blocks in `lib/signal/metrics.ts`, the output schema, and the operation description. Add "match exposure" and "match take-up" to GLOSSARY.md.

**Area:** lib/signal/metrics.ts, lib/signal/operations/get-metrics.ts, GLOSSARY.md, tests

**Blocked by:** 02

- [ ] Domain tests on hand-built histories prove each field and verdict boundary, as listed in Testing Decisions.
- [ ] Parity passes on REST, Operator MCP, and the Operator agent. The Crewday fixture smoke run reports non-null `takeUpRate` for both arms.

### 04: Exposure panel on `/operator/metrics`

**What to build:** the Exposure panel and the kill-criterion line, through the typed client.

**Area:** app/operator/(console)/metrics

**Blocked by:** 03

- [ ] The acceptance scenario passes end to end, steps 1–2 and 8–9 in the browser.

## Further Notes

- **Open assumptions:**
  - The 24 h exposure window.
  - That PM splits are frequent enough for `movedOffTakenMatch` to work as a live false-match proxy. If it stays near zero with real users, it shows how rarely PMs split, not match quality.
  - Counting agent submissions toward the 200 together with humans. PRODUCT.md says "real users". The verdict is reported for each population and combined, so this can be settled once the first numbers arrive.
- **Spec 009 overlap:** 009's proposed `skippedPreview` flag is covered by `exposure.kind = "skipped"` here. When 009 is fleshed out, it should read exposure instead of adding its own flag.
- **PRODUCT.md additions on acceptance:**
  - Add match take-up under Diagnostics → Supporting.
  - Name `signal.created.exposure` as the source of the real-user kill criterion's "showed a match" count.
  - Add `movedOffTakenMatch` as the live counterpart of the false-match guardrail.

  These add to PRODUCT.md and reverse nothing.

- **Crewday:** once this ships, the lift run reports take-up per arm with no scorer change. That gives the simulation's submitter policy a measured counterpart the day real submissions arrive.
