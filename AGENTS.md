# Project Rules

## Prompt Logging

A hook (`tooling/hooks/log-prompt.mjs`) appends each prompt to prompts.txt with its real timestamp. After responding, append one `Response:` line under it with a brief summary of what you did.

## Environment

- The GitHub repo `gaboesquivel/flow-signal`, the Vercel project `flow-signal`, and the Neon project `signal` are the user's own; run their CLIs directly. In an unlinked worktree, use `vercel --cwd <main checkout>` or copy `.env.local` and `.vercel/` (Claude Code worktrees get them from `.worktreeinclude`).
- Pipe secrets into CLIs; never print them. Merge a PR only after `gh pr checks <n> --watch` passes.
- Workers run `pnpm test:changed` plus lint and types for their files; the full suite runs once, in CI. Live evals run on demand, matched to the changed path (ARCHITECTURE.md → Testing).

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
