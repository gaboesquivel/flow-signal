# Project Rules

## Prompt Logging

A hook (`tooling/hooks/log-prompt.mjs`) appends each user prompt, redacted, to this session's own Git-ignored log in the main checkout (`.sessions/<tag>.prompts.log`) and tells you the tag; harness events are not logged. After responding, run `node tooling/hooks/log-response.mjs <tag> "<brief summary>"`. Never paste secret values into a summary. Logging never blocks work: if it fails, say so and continue. `prompts.txt` is the frozen archive of the shared log (through 2026-10-31); don't append to it or commit new lines. Optional progress notes go beside the log as `.sessions/<tag>.progress.md`.

## Environment

- The GitHub repo `gaboesquivel/flow-signal`, the Vercel project `flow-signal`, and the Neon project `signal` are the user's own; run their CLIs directly. In an unlinked worktree, use `vercel --cwd <main checkout>` or copy `.env.local` and `.vercel/` (Claude Code worktrees get them from `.worktreeinclude`).
- Pipe secrets into CLIs; never print them.
- Workers run `pnpm test:changed` (or the one focused test file) plus lint and types for their files; the full suite runs once, in ready-PR CI. Live evals run on demand, matched to the changed path (ARCHITECTURE.md → Testing). Commits run no hooks.

## Delivery

- One branch and one pull request per delivery (`spec/<number>-<slug>` for a spec), opened as a **draft**. Drafts run no CI and Vercel builds no preview. One integration owner pushes to it; other sessions commit in their own worktrees under `.claude/worktrees/` and hand their commits over.
- Mark it ready (`gh pr ready <n>`) once implementation, review, and focused checks are done; that runs `verify` and `pr-title` once on the head, and every later push runs them again. `main` pushes run no CI.
- Merge only when `node .agents/skills/ship/scripts/required-checks.mjs gaboesquivel/flow-signal <n>` exits 0 (skipped, pending, or missing checks never count).
- Before merging, run `pnpm smoke` against a running local server (`SMOKE_BASE_URL`, default `https://signal.localhost`; `--live` adds one model call) and include its summary line in the PR or hand-back. CI has no server, so it never runs there.
- Production deploys from `main` (migrations in `scripts/vercel-build.mjs`). A preview is explicit: `vercel deploy`, for a design review or a change that risks the build.

<!-- BEGIN FLOW -->

## Flow

This project uses Flow skills. Say a phrase to load its skill; the installed `flow` skill describes this block. Delete the block to opt out.

Do the work yourself: CLI, then MCP, then API, then browser. Hand the user only sign-in, secrets, payment, consent, or permission changes, once, as one command each (`write-agents` Tools).

| Say                                                  | Skill       |
| ---------------------------------------------------- | ----------- |
| "explore this"                                       | `explore`   |
| "interview me"                                       | `interview` |
| "grill this"                                         | `grill`     |
| "spec it"                                            | `to-spec`   |
| "share the draft"                                    | `to-spec`   |
| "break it down"                                      | `to-tasks`  |
| "build it"                                           | `build`     |
| "check it against the spec"                          | `review`    |
| "ship it" (add "local" or "with GitHub" for one run) | `ship`      |
| "push it"                                            | `push`      |
| "update the docs"                                    | `flow`      |

<!-- END FLOW -->

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
