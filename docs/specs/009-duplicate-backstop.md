# 009 — Post-submission duplicate backstop

Status: candidate (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Metrics (prevention rate), Riskiest assumption 1. Builds on [spec 001](./001-signal-mvp.md) (off-hot-path `merge` suggestions) and [spec 004](./004-crewday-outcome-eval.md) (true prevention rate).

## Problem

Submitters and agents skip the three-step wizard and post duplicates anyway. The only backstop is one merge check per draft, run once right after submission (`proposeMerge` in `lib/signal/domain/suggestion-generation.ts`), and it misses:

- It never runs again: no sweep, and new supporters on either need don't trigger a recheck.
- When the embedder is down, the draft is stored without a vector and the check is skipped; `pnpm db:embed` backfills the vector but never re-runs it.
- Two drafts posted seconds apart can each be checked before the other is saved or embedded, so they never meet.
- It keeps one candidate; a draft that duplicates two needs, or whose best match a PM rejects, never gets the second one proposed.
- Only the PM sees the proposal; the submitter who skipped the wizard is never asked "add your voice to X?"
- A submission without a `previewId` looks the same as one that went through the wizard, so skipping is not measured and the server runs no duplicate check of its own.

## Assumption it tests

A scheduled sweep, re-checks after embedding, multi-candidate merges, a submitter follow-up on My signals and MCP, a `skippedPreview` flag on `signal.created`, and `possibleDuplicates` in the `submit_signal` response for submissions without a preview raise true prevention rate on Crewday (duplicates nobody merged go down) without raising the unmerge or false-match rate.
