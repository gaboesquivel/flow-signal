# 010 — Retro remediation: Gateway-only models, an agent environment that runs itself, cheap checks, docs that match what shipped

Status: accepted (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Metrics, Riskiest assumptions, Kill criterion. Builds on [spec 001](./001-signal-mvp.md) (model routing, CI policy), [spec 004](./004-crewday-outcome-eval.md) (Crewday worlds and `pnpm eval:crewday`), [spec 007](./007-decision-direction.md) (decision model), and decisions [0007](../decisions/0007-decision-model-on-gateway-credentials.md) and [0008](../decisions/0008-decision-model-sonnet.md).

**Bet.** Most of the delivery drag on 2026-10-30 came from the environment, not the code. Agents stopped and handed commands to the user. Tests ran two or three times per change, and `pnpm eval` chained every live eval. The docs also drifted from what shipped. If we fix the environment once, the next build ships without user hand-offs or repeated runs. And the next measurement step, the Crewday lift run, starts from docs that say what is true.

## Problem Statement

Evidence comes from the 2026-10-30 retro: transcripts of the four flow-signal session folders, `prompts.txt`, git history, and `origin/main` at `3aabf53`.

1. **Model calls are not Gateway-only in code.** Every runtime path resolves models through `lib/ai/models.ts` (`gatewayModel`, `gatewayEmbeddingModel`). There are four exceptions:
   - `lib/ai/resolve-chat-model.ts` still falls back to `@ai-sdk/anthropic` with `ANTHROPIC_API_KEY` when `FLOW_ALLOW_DIRECT_ANTHROPIC=1`. The public and Operator chat routes use it.
   - The Operator MCP `config_status` tool reports `anthropicChat`.
   - Four eval runners each rebuild their own `apiKey ? createGateway({ apiKey }) : gateway` provider instead of using `lib/ai/models.ts`: `evals/agents/run.ts`, `evals/matching/run.ts`, `evals/crewday/spend.ts`, and `evals/crewday/generate/llm.ts`.
   - `@ai-sdk/anthropic`, `.env.example`, and `docs/INTEROP.md` still describe the direct path. Spec 007's Solution and Implementation Decisions still say decision briefs run on Fable 5.1 with BYOK, which decisions 0007 and 0008 replaced.
2. **Agents hand the user commands they could run.** CLI use already dominates (about 3,500 Bash calls, no raw API `curl`), so the CLI-first rule in the Flow block and `write-agents` → Tools is not the problem. The hand-offs have two causes:
   - **Unlinked worktrees.** `.vercel/` and `.env.local` are gitignored, so new worktrees get neither. Two of four session worktrees had neither file, and `vercel env add` failed with "Your codebase isn't linked to a project on Vercel", which led to a "please run it" hand-off.
   - **No permission rules.** No settings level defines permission rules, and every session ran in auto mode. The classifier blocked these routine steps, each ending in a request to the user:
     - Merge Without Review and CI Bypass: merging PRs, including with checks still pending.
     - Credential Materialization: grepping `.env.local`.
     - Secret-Store Writes: `vercel env rm`.
     - Production Reads.
     - Interfere With Workloads: `pkill next-server`.
3. **Checks run more than once.**
   - Each build worker ran the full `pnpm test`, the integrator ran it again, and CI ran it a third time. One log entry reads "603/603 locally… first verify run passed… re-run also passed".
   - `pnpm test` also rebuilds `mcp-app` every time.
   - `pnpm eval` chains GenUI offline, the Eve smoke test, matching, Crewday (about $5–8 per world), and agents. ARCHITECTURE says to run it "whenever agent code changes", which sets off the whole chain.
   - Spec 004 task 04 requires "`pnpm eval` includes the dev-world run".
4. **Docs say things that are not true.**
   - Spec 004 still requires worlds of about 1,500 signals and a stratified review. The shipped worlds have 604 signals each and `"review": "none (deferred)"`, yet task 02 is ticked.
   - PRODUCT.md rates assumption 4 (under 2 s, under $0.01) _high_ confidence, although the last live runs measured p95 4.7 s and $0.014 per signal.
   - PRODUCT.md lists decision quality as a headline simulated outcome, while spec 004 says it "mostly measures noise".
   - PRODUCT.md lists 19 metrics in no tiers.
5. **The prompt log is unreliable.** `prompts.txt` entries carry hand-written, out-of-order timestamps (`19:10:00Z`, `20:00:00Z`) and are appended separately in each worktree.

## Solution

One branch with eight tasks. All of them are configuration, code-path removal, or doc edits. **No tests or evals run in this spec's build.** CI runs `pnpm qa` on the PR as usual, and the team verifies later (see Testing Decisions).

1. **Gateway-only models.** All model and embedding calls, runtime and evals, go through `lib/ai/models.ts` on AI Gateway credentials (`AI_GATEWAY_API_KEY`, or Vercel OIDC). The direct Anthropic fallback, its flag, its status field, its dependency, and its docs are removed.
2. **Worktrees arrive linked.** A root `.worktreeinclude` copies `.env.local`, `.env.production.local`, and `.vercel/` into every Claude Code worktree (sessions, subagents, `--worktree`).
3. **Routine commands don't prompt.** A committed `.claude/settings.json` holds narrow allow rules for the commands agents run all day. Two classes still prompt through `ask` rules: deleting cloud resources and production database writes (`pnpm db:migrate` asks, since it runs against whatever `DATABASE_URL` is set).
4. **The classifier knows the environment.** AGENTS.md gets a short Environment section: these GitHub, Vercel, and Neon resources are the user's own; secrets are piped into CLIs, never printed; PRs merge only after `gh pr checks --watch` passes. The user adds the user-level `autoMode` block themselves (see User-only steps).
5. **Each check runs once.**
   - A `test:changed` script for workers.
   - CI is the only full test run.
   - `build:mcp-app` runs only when a test needs it.
   - `pnpm eval` becomes the cheap tier, and Crewday runs only when asked for.
6. **Docs match what shipped:** spec 004, spec 007, PRODUCT.md, ARCHITECTURE.md, README, and INTEROP.
7. **The prompt log writes itself.** A `UserPromptSubmit` hook appends the real timestamp and prompt, and the agent adds only the response summary.
8. **Repository hygiene.** Merged worktrees and `worktree-agent-*` branches are pruned, and the primary checkout returns to `main`.

## User Stories

1. As an agent in a fresh worktree, I want `vercel env ls` and `pnpm eval:matching` to work without setup, so that I never ask the user to run them.
2. As an agent shipping a PR, I want `gh pr checks --watch` and `gh pr merge --squash` to run without a prompt once checks pass, so that "ship it" means no further approvals.
3. As the user, I want deleting a cloud resource or writing to the production database to still ask me, so that speed doesn't remove the checkpoints that matter.
4. As the Signal team, I want every model call billed through the AI Gateway, so that spend, rate limits, and model ids live in one place.
5. As a build worker, I want to run only the tests my change touches, so that the full suite runs once, in CI.
6. As the Signal team, I want `pnpm eval` to cost cents rather than dollars, and `pnpm eval:crewday` to run only when I ask, so that "run the evals" never spends the Crewday budget by accident.
7. As a reader of PRODUCT.md and spec 004, I want the documents to state what shipped and what was measured, so that the next decision rests on facts.

## Implementation Decisions

### Task 01: Gateway-only models

- **`lib/ai/resolve-chat-model.ts`:** `resolveChatModel()` returns `gatewayModel(chatModelId())` when `gatewayAvailable()`, else `null`. Remove the `createAnthropic` branch and `FLOW_ALLOW_DIRECT_ANTHROPIC`. `chatUnavailableResolution()` reads: "Deploy on Vercel (AI Gateway authenticates through OIDC) or set AI_GATEWAY_API_KEY."
- **`lib/ai/models.ts`:** remove `directModelId`. If it has a test in `models.test.ts`, delete that test as well (deleting is allowed; writing new tests is not).
- **`lib/mcp/register-operator-tools.ts`:** remove `anthropicChat` from `config_status`.
- **Eval runners:** the four runners named in the Problem Statement call `gatewayModel(id)` and `gatewayEmbeddingModel(id)` from `lib/ai/models.ts` instead of building their own provider. Model ids stay as they are: `google/gemini-3-flash` for the generator and `openai/text-embedding-3-large` for the oracle. Both are Gateway ids.
- **`package.json`:** remove `@ai-sdk/anthropic` and update the lockfile with `pnpm install`.
- **Docs and env:** `.env.example` and `docs/INTEROP.md` drop `ANTHROPIC_API_KEY` and `FLOW_ALLOW_DIRECT_ANTHROPIC`.
- **`providerOptions.anthropic` stays.** Both uses (`thinking` in `lib/signal/ai/gateway.ts`; `effort` and `fallbacks` in `reasoning-model.ts`) are passed through the Gateway to the Anthropic provider and do not bypass it.
- **Guard:** add a `no-restricted-imports` rule to `oxlint.config.ts` that bans `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, and `@anthropic-ai/sdk`. Its message names the fix: "Use gatewayModel / gatewayEmbeddingModel from lib/ai/models.ts (AI Gateway only)". `pnpm lint` in CI then enforces this deterministically, with no test needed.

### Task 02: Worktree environment

**`.worktreeinclude`** at the repo root (gitignore syntax; it copies only files that are gitignored):

```
.env.local
.env.production.local
.vercel/
```

- Add `.claude/worktrees/` to `.gitignore` if it is missing.
- `../flow-signal-wt/*` worktrees made by hand with `git worktree add` do not get these files. AGENTS.md → Environment says so: create worktrees through Claude Code, or copy the three paths.

### Task 03: Permission rules

Committed `.claude/settings.json`, using the space form the docs use:

```json
{
  "permissions": {
    "allow": [
      "Bash(gh pr view *)",
      "Bash(gh pr checks *)",
      "Bash(gh pr create *)",
      "Bash(gh pr merge *)",
      "Bash(gh pr edit *)",
      "Bash(gh run view *)",
      "Bash(gh run watch *)",
      "Bash(vercel env ls *)",
      "Bash(vercel env add *)",
      "Bash(vercel env pull *)",
      "Bash(vercel inspect *)",
      "Bash(vercel logs *)",
      "Bash(vercel ls *)",
      "Bash(neonctl branches list *)",
      "Bash(neonctl connection-string *)",
      "Bash(neonctl branches create *)",
      "Bash(pnpm qa)",
      "Bash(pnpm lint *)",
      "Bash(pnpm check-types)",
      "Bash(pnpm test:changed *)",
      "Bash(pnpm eval:matching *)",
      "Bash(pnpm eval:agents *)",
      "Bash(docker compose -p signal *)"
    ],
    "ask": [
      "Bash(vercel env rm *)",
      "Bash(vercel remove *)",
      "Bash(neonctl branches delete *)",
      "Bash(neonctl projects delete *)",
      "Bash(gh repo delete *)",
      "Bash(pnpm db:seed *)",
      "Bash(pnpm db:migrate)"
    ]
  },
  "hooks": {}
}
```

- `pnpm eval:crewday` stays off the allow list on purpose, so a dollar-scale run always asks.
- The `hooks` block is filled in task 07.
- Auto mode keeps narrow rules and suspends only broad ones, such as `Bash(*)`. That means these rules take effect in auto mode too.

### Task 04: Environment line for agents and the classifier

Add an `## Environment` section to AGENTS.md, at most 6 lines:

- The repo `gaboesquivel/flow-signal`, the Vercel project `flow-signal`, and the Neon project `signal` belong to the user.
- Agents run their CLIs directly, from the main checkout with `--cwd` if a worktree is unlinked.
- Secrets are piped into CLIs and never printed.
- PRs merge only after `gh pr checks --watch` passes.
- Workers run `pnpm test:changed`; the full suite runs once, in CI.
- Live evals run only when asked for.

This edits AGENTS.md. The user authorizes it by accepting this spec.

### Task 05: Check economy

- **`package.json`:**
  - `"test:changed": "vitest run --changed origin/main"`.
  - `test` drops `pnpm run build:mcp-app &&` only if no test reads `mcp-app/dist`. The runtime reader is `lib/mcp/genui-preview-resource.ts`; check whether any test imports it before dropping it. If one does, keep the build in `test` and add `pretest:changed` instead.
  - `"eval": "pnpm eval:genui:offline && vitest run evals/eve-smoke.test.ts && pnpm eval:matching && pnpm eval:agents"`. Crewday is removed and stays as `pnpm eval:crewday`.
- **ARCHITECTURE.md → Testing** adds a rule and a table:
  - "Workers run `pnpm test:changed` and lint/types for their files. The integrator and CI run the full suite once. Don't re-run a green suite to confirm it."
  - A table mapping each changed path to its eval:

    | Changed path                                      | Eval to run                         |
    | ------------------------------------------------- | ----------------------------------- |
    | `lib/signal/ai/**`, `lib/signal/domain/matching*` | `pnpm eval:matching`                |
    | `agents/**`, `lib/mcp/**`                         | `pnpm eval:agents`                  |
    | `evals/crewday/**`, policy or metric code         | `pnpm eval:crewday`, when asked for |
- **CI** (`.github/workflows/ci.yml`) is unchanged: `security:check` plus `qa`.

### Task 06: Docs match what shipped

- **Spec 004:**
  - Task 02's criteria say about 600 signals per world (604 shipped).
  - The stratified-review criterion moves to Further Notes as deferred.
  - Task 04's criterion "`pnpm eval` includes the dev-world run" becomes "`pnpm eval:crewday` runs the dev world on demand".
  - Implementation line 209 ("Joins `pnpm eval`…") changes the same way.
- **Spec 007:** the Solution's "Decision model" bullet and Implementation Decisions → Decision model now describe Sonnet 5.5 on Gateway credentials. They link 0007 and 0008 and drop `anthropicByokOptions` and Fable-as-default.
- **PRODUCT.md:**
  - Assumption 4's confidence becomes _medium_, citing the measured p95 4.7 s and $0.014 per signal.
  - Decision quality is labelled a non-inferiority check.
  - Metrics are split into three tiers: the one metric that matters plus the two MVP metrics; guardrails; and diagnostics.
  - One line under simulated outcomes states that the simulation takes submitter behaviour as an input, so it cannot test assumption 1.
- **README:** the `pnpm eval` row is corrected, and `pnpm eval:crewday` and `pnpm test:changed` rows are added.

### Task 07: Prompt-log hook

- `tooling/hooks/log-prompt.mjs` reads the hook's JSON from stdin and appends this to `prompts.txt` in the project root:

  ```
  \n[<ISO UTC now>]\nPrompt: <prompt, first 500 chars, newlines collapsed>\n
  ```

  It always exits 0 and prints nothing.

- It is registered in `.claude/settings.json` under `hooks.UserPromptSubmit`.
- The AGENTS.md rule becomes: "A hook logs each prompt with its timestamp. After responding, append one `Response:` line under it with a brief summary."
- Worktree entries still diverge, so `prompts.txt` merges as a union: add `prompts.txt merge=union` to `.gitattributes`.

### Task 09: Neon preview branches deleted on PR close

Added after the build: the PR 10 preview failed with "Resource provisioning failed" because the Neon Free plan's 10-branch limit was full of `preview/*` branches from merged PRs. The Vercel-managed integration deletes a preview branch only when Vercel's retention removes its deployment (30 days on Hobby). `.github/workflows/neon-preview-cleanup.yml` runs `neondatabase/delete-branch-action` (pinned v3.2.1) on `pull_request: closed` for `preview/<head branch>`, using repo variable `NEON_PROJECT_ID` (set) and secret `NEON_API_KEY` (a project-scoped key; the user sets it once, `docs/database.md`).

### Task 08: Repository hygiene

This task is operational and changes no files.

- Remove these worktrees: `../flow-signal-wt/t08`, plus the `.claude/worktrees/*` worktrees whose PRs merged (`crewday-eval-fixes-6988a0`, `dreamy-banach-3fc39f`, `spec-006-hotfixes-7ddd10`). Remove each only if its session is no longer running.
- Delete the six `worktree-agent-*` branches and the merged `decision/*` and `claude/*` branches.
- Switch the primary checkout to `main` once `spec/004-crewday-outcome-eval` is confirmed contained in main. Its two unique commits were cherry-picked to spec 006; verify with `git cherry`.
- Ask the user once before removing anything with unmerged commits.

**Exposure:** no new deployable behaviour. Chat routes without Gateway access now return the existing "unavailable" response instead of falling back to the direct Anthropic path. Nothing else changes for users.

### User-only steps (one message, once)

These are the agent's own permission settings, so the user applies them:

```json
// ~/.claude/settings.json
{
  "permissions": { "defaultMode": "auto" },
  "autoMode": {
    "environment": [
      "$defaults",
      "gaboesquivel/* GitHub repos, the flow-signal Vercel project and the signal Neon project are the user's own; agents manage their branches, preview deploys and env vars"
    ],
    "allow": ["$defaults", "Squash-merging a gaboesquivel/* PR after its CI checks pass"]
  }
}
```

Then, from a terminal, run `claude auto-mode critique`. After that, remove `ANTHROPIC_API_KEY` from Vercel and GitHub if it is still there (0007 already asked for this).

## Testing Decisions

**This spec's build writes and runs no tests or evals,** at the user's direction (2026-10-30: "without running the tests, just pushing fixes, we'll verify later").

- The only automated check is CI's existing `pnpm qa` on the PR.
- The new oxlint import ban is a deterministic check that CI enforces.
- Deleting a test that covers removed code (`directModelId`) is allowed.

**Acceptance scenario** (run later by the team; `review` gives each step a verdict):

1. **Gateway-only code.** `git grep -nE "@ai-sdk/anthropic|createAnthropic|FLOW_ALLOW_DIRECT_ANTHROPIC|anthropicChat" -- ':!docs' ':!prompts.txt' ':!oxlint.config.ts'` on `main` returns nothing. `git grep -n "createGateway" -- evals` returns nothing.
2. **Lint guard.** Adding `import { anthropic } from "@ai-sdk/anthropic"` to any file makes `pnpm lint` fail with the "Use gatewayModel…" message.
3. **Worktree environment.** A new Claude Code session in its own worktree runs `vercel env ls` and gets the project's variables, with no "not linked" error and no prompt.
4. **Permission rules.** In auto mode, `gh pr checks <n> --watch` followed by `gh pr merge <n> --squash` runs without a prompt or a classifier block. `vercel env rm X preview` prompts.
5. **Check economy.** A worker changing one file in `lib/signal/domain/` runs `pnpm test:changed`, and only the affected test files run. `pnpm eval` with Gateway access makes no Crewday calls.
6. **Prompt log.** Sending a prompt appends exactly one entry with the real UTC time. The agent adds only the `Response:` line.
7. **Live Gateway path.** With `vercel env pull .env.local` (OIDC) and no `ANTHROPIC_API_KEY`, `POST /api/chat` and one `pnpm eval:matching` run succeed. In the Vercel AI Gateway usage view, they appear under the project.

## Direction changes

- **docs/INTEROP.md:** `ANTHROPIC_API_KEY` with `FLOW_ALLOW_DIRECT_ANTHROPIC=1` was a local direct-chat override. Now every model call goes through the AI Gateway, and there is no direct provider path. Confirmed by the user on 2026-10-30 ("make sure we running everything to vercel gateway").
- **ARCHITECTURE.md → Testing:** "Live-model evals (`pnpm eval`) run on demand and whenever agent code changes" changes. Now `pnpm eval` is the cheap tier, matched to the changed path, and `pnpm eval:crewday` runs only when asked for.
- **Spec 004:** a ~1,500-signal world, a review required for v1, and Crewday inside `pnpm eval` change to 604 signals, review deferred, and Crewday on demand. This records what shipped and widens nothing.
- **PRODUCT.md:** assumption 4 drops from _high_ to _medium_ confidence, decision quality becomes a non-inferiority check, and the metrics are split into tiers.

## Tasks

- [x] 01: Gateway-only models
- [x] 02: Worktree environment
- [x] 03: Permission rules
- [x] 04: Environment line for agents and the classifier
- [x] 05: Check economy
- [x] 06: Docs match what shipped
- [x] 07: Prompt-log hook
- [x] 09: Neon preview branches deleted on PR close
- [ ] 08: Repository hygiene _(runs after this PR merges)_

## Out of Scope

- **The Crewday lift run** (spec 004 task 04). It is the next step after this spec and needs a live budget of about $6–8.
- **Hot-path latency and spend** (p95 4.7 s against 2 s; $0.014 against $0.01), the duplicate backstop (spec [009](./009-duplicate-backstop.md)), and the harder matching set (spec 004 task 07). Each gets its own spec or task.
- **Pruning duplicate tests** (domain vs. parity overlap). This needs test runs, which this spec excludes.
- **Project MCP servers** (`.mcp.json` for Vercel and Neon). The CLIs cover these services, so the MCP rung stays optional.
- **Moving GenUI** from `anthropic/claude-sonnet-4.6` to a newer model. It already runs through the Gateway.

## Further Notes

- **Order:** tasks 01–07 touch disjoint files, except AGENTS.md (tasks 04 and 07) and `.claude/settings.json` (tasks 03 and 07). Run tasks 03, 04, and 07 in one worker. Task 08 runs last, after the PR merges.
- **Unknowns:**
  - Whether `.worktreeinclude` copies a directory pattern (`.vercel/`). Gitignore semantics say yes, but this is untested.
  - Whether the `UserPromptSubmit` stdin carries `prompt` under that key. Read the hook input once, then write the parser.
  - Whether `vitest --changed origin/main` follows imports across the `@/` alias. If not, fall back to `vitest related <files>`.
