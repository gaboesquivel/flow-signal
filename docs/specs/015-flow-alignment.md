# 015 — Flow alignment: draft-first delivery, per-session prompt logs

Status: implemented (2026-10-31)

Recorded after delivery: the work landed in [#32](https://github.com/gaboesquivel/flow-signal/pull/32) (`271320d`) and [#33](https://github.com/gaboesquivel/flow-signal/pull/33) (`4c8b346`). Applies Flow [spec 048](https://github.com/gaboesquivel/flow-skills/blob/main/docs/specs/048-delivery-lifecycle.md) (decision 0057), [spec 047](https://github.com/gaboesquivel/flow-skills/blob/main/docs/specs/047-shared-language-test-first.md), and `write-agents` Sessions to Signal. Builds on [spec 010](./010-retro-remediation.md); supersedes its task 07.

## Problem Statement

Signal's agent workflow was behind Flow `main`. Every push to a PR ran the full CI. Every branch push built a Vercel preview, and a pre-commit hook ran on each commit. Parallel sessions appended to one tracked `prompts.txt`, so worktree merges fought over it, and two `OPERATOR_SECRET` values ended up in this public repository's history. A third-party TDD skill overlapped Flow `build`'s contract test-first rule, so agents had two workflows to choose from.

## Solution

- One draft PR per delivery is the shared workspace. Drafts run no CI and no preview. Marking the PR ready runs `verify` and `pr-title` once on the head, and every later push runs them again. `main` pushes run nothing, and production still deploys from `main`.
- Commits run no Git hooks; the secret-file check runs in ready-PR CI.
- Each session logs its prompts and responses, redacted, to its own Git-ignored file. `prompts.txt` is a frozen archive.
- Installed Flow skills match `flow-skills` main, and no overlapping workflow skill remains.

## User Stories

1. As an agent, I push commits to a draft PR and no CI runner or Vercel build starts.
2. As an agent, I mark the PR ready. `verify` and `pr-title` run on that head, and `required-checks.mjs` exits 0 only when both succeeded there.
3. As an agent, I commit with no hook running.
4. As the maintainer, a prompt that contains `DATABASE_URL=postgres://u:p@h/db` is logged as `DATABASE_URL=[REDACTED]`, in that session's own `.sessions/<tag>.prompts.log`, which Git ignores.
5. As a parallel session, my log never conflicts with another session's log.
6. As an agent, the skills I load name one way to do test-first work: Flow `build`.

## Implementation Decisions

- **CI:** `ci.yml` and `pr-title.yml` trigger on `opened`, `synchronize`, `reopened`, and `ready_for_review` (`pr-title.yml` also on `edited`). The job condition skips drafts, and draft runs use their own concurrency group.
- **Vercel:** `vercel.json` sets `git.deploymentEnabled` to `{"**": false, "main": true}`. A preview is an explicit `vercel deploy`, so Neon preview branches come only from explicit previews.
- **Hooks:** `simple-git-hooks`, `prepare`, `hooks:pre-commit`, and the unused gitleaks scripts are removed. `pnpm setup` deletes a stale hook only when it carries the simple-git-hooks marker (`tooling/setup/stale-hooks.mjs`).
- **Prompt logs:**
  - `tooling/hooks/prompt-log.mjs` resolves the main checkout through the Git common directory, so logs outlive worktrees.
  - It redacts before writing: environment assignments, keyed secrets, secret-bearing CLI flags, basic and bearer auth, URL credentials, known token shapes, and opaque high-entropy strings.
  - When content can't be redacted with confidence (a private key), it drops the entry.
  - `log-response.mjs` appends the agent's summary through the same redaction.
- **Skills:** `pnpm skills:update` refreshes the skills, and `test-driven-development` is removed. `skills-lock.test.mjs` forbids that skill and pins `build`, `ship`, and `write-agents` to Flow.
- **Agent config:**
  - The AGENTS.md Delivery section covers draft, ready, the gate script, `pnpm smoke`, and merge.
  - A Claude Code `SessionStart` hook installs dependencies only in cloud sessions, and Cursor gets an `environment.json`.
  - The gate script and the response logger are allowed for both hosts.

**Exposure:** no deployed behaviour changes; only the delivery tooling changes.

## Testing Decisions

- **Contract tests:** `tooling/hooks/prompt-log.test.mjs` covers redaction examples, ordinary delivery text that stays untouched, unredactable drops, per-session isolation, the response line, and the ignored main-checkout path.
- **Other unit tests:** `tooling/setup/stale-hooks.test.mjs` and `skills-lock.test.mjs`.
- **Focused check:** `node --test tooling/hooks/prompt-log.test.mjs`.
- No model evals.

**Acceptance scenario** (observed on #33):

1. #33 is opened as a draft with two pushes. → `verify` and `pr-title` report `skipping`; `vercel ls` lists no deployment for the branch.
2. `gh pr ready 33`. → `verify` succeeds on `3543847`, and so does `pr-title`. `required-checks.mjs gaboesquivel/flow-signal 33` exits 0 with `"ready": true`.
3. `pnpm smoke` runs against local `next dev` → `smoke: 15/15 passed`.
4. A squash merge lands as `4c8b346`. → no CI run on `main`; the Vercel production deployment for `4c8b346` is `READY`, and `/api/needs` on the production alias returns 200.
5. A prompt is submitted in a new session. → `.sessions/<tag>.prompts.log` gains a redacted entry, and `git status` shows nothing new.

## Out of Scope

- Enabling branch protection or rulesets on `main`. None are active, so the gate script is what enforces checks.
- Cursor prompt logging: `logPrompt` accepts Cursor's `beforeSubmitPrompt` input, but no `.cursor/hooks.json` is added.
- Rotating `OPERATOR_SECRET`: deferred by the maintainer on 2026-10-31.
- A Next.js build in CI.

## Further Notes

- Previews no longer run on branches, so the production deploy is the first build of a merged change. Vercel keeps the previous deployment live if that build fails. Run an explicit `vercel deploy` first for build-risky changes.
