# 011 — Site cleanup: remove unused code, Gateway-only AI, local dev on Docker Postgres

Status: implemented (2026-10-30)

Builds on [spec 010](./010-retro-remediation.md) (Gateway-only models) and decision [0003](../decisions/0003-local-test-databases.md) (local Docker Postgres). Depends on decision [0009](../decisions/0009-local-dev-on-docker-postgres.md) : local development runs on Docker Postgres by default.

**Bet.** The site carries template leftovers (unused shadcn components, dead exports, stale Anthropic copy) and needs a Neon cloud branch before `signal.localhost` shows any data. If we strip what nothing imports and point local dev at the Docker stack we already run for tests, a fresh checkout reaches a working `signal.localhost` with one setup command and no cloud credentials except `AI_GATEWAY_API_KEY`.

**Delivery mode (user instruction).** Hotfix: verify with `pnpm lint` and `pnpm check-types` only, plus a manual load of `signal.localhost`. Do not run `pnpm test`, `test:changed`, or evals. This overrides the `AGENTS.md` worker rule for this spec only.

## Problem Statement

- A developer cloning the repo runs `pnpm dev`, opens `https://signal.localhost`, and gets `database_unavailable` until they create a Neon branch and paste its URL into `.env.local`. `docs/database.md` documents local dev as "Neon `dev` branch".
- `knip` (run 2026-10-30) reports about 50 unused component files under `components/`, 6 unused dependencies (`@shadcn/react`, `cmdk`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `react-resizable-panels`), one unused devDependency (`is-agentic`), and about 80 unused exports across `app/`, `lib/`, and `components/`. Some are false positives (Eve agent entry points, `mcp-app/src`, scripts, skills under `.agents/` and `.claude/`).
- Spec 010 removed the direct Anthropic provider, but traces remain: `lib/starter-content.ts` advertises "optional Anthropic key" on `/markdown/home`, and `tests/signal/domain/reasoning-model.test.ts` still stubs `ANTHROPIC_API_KEY`.

## Solution

1. **Gateway only.** Every model call goes through `@ai-sdk/gateway` (`gatewayModel()` in `lib/ai/models.ts`) with `AI_GATEWAY_API_KEY` or Vercel OIDC. No `@ai-sdk/anthropic`, no `ANTHROPIC_API_KEY`, no Anthropic-direct copy anywhere in app, lib, scripts, env examples, or user-facing text. Gateway model ids (`anthropic/claude-sonnet-5.5`) and Gateway-forwarded `providerOptions.anthropic` stay: they are Gateway routing, not a direct provider.
2. **Unused code removed.** Delete files, dependencies, and exports that nothing in the app, agents, MCP app, scripts, evals, or tests uses, after checking each `knip` hit by hand.
3. **Local dev on Docker.** `DATABASE_URL` defaults to `signal_dev` in the compose stack; one command (`pnpm db:dev`) brings the stack up, creates the database, migrates, and seeds the demo workspace when empty. `pnpm dev` then serves `signal.localhost` with data.

## User Stories

1. As a developer on a fresh clone, I want `pnpm db:dev && pnpm dev` to give me a working `signal.localhost` with demo data, so I can work without a Neon account.
2. As a developer who wants shared data, I want to set `DATABASE_URL` to a Neon branch and have everything still work, so the Docker default is not a lock-in.
3. As a maintainer, I want no code path that can call Anthropic directly, so billing and credentials stay on the Gateway.
4. As a reader of the code, I want no dead components or exports, so what exists is what runs.

## Implementation Decisions

**Anthropic sweep.**

- `lib/starter-content.ts`: replace "optional Anthropic key" with the Gateway (`AI_GATEWAY_API_KEY` or OIDC).
- `tests/signal/domain/reasoning-model.test.ts`: drop the `ANTHROPIC_API_KEY` stubs (the BYOK assertion they guarded is gone since decision 0007). Edit only; do not run.
- Confirm with `grep -rniE "@ai-sdk/anthropic|createAnthropic|ANTHROPIC_" app lib agents/*/agent scripts evals mcp-app providers hooks components .env.example docs/database.md` returning nothing. Decision records and accepted specs keep their history untouched.
- Eve agents (`agents/*/agent/agent.ts`): confirm their model resolves through the Gateway, not Eve's `anthropic-api/` provider prefix. Built `.output/` folders are gitignored and out of scope.

**Unused code.**

- Tool: `pnpm dlx knip@5` (no config committed unless it removes false positives cheaply; if one is added, it is `knip.json` with entries for `agents/*/agent/**`, `mcp-app/src/main.tsx`, `scripts/**`, `tooling/**`, `evals/**`, and ignores `.agents/**`, `.claude/**`).
- Delete an unused `components/*.tsx` only after confirming nothing imports it by path or by registry string (GenUI's catalog in `lib/genui/registry/` and `lib/genui/react/` resolves components; check before deleting). Components that GenUI or the MCP app can render stay.
- Remove the unused dependencies from `package.json` and refresh `pnpm-lock.yaml`. Add `postcss` as a devDependency if `postcss.config.mjs` needs it listed.
- Unused exports: un-export (keep the symbol) when it is used inside its file; delete when it is used nowhere. Exports used only by tests stay exported. Leave `lib/genui/index.ts`'s public barrel alone unless a symbol is used nowhere at all.
- Out of bounds: `.agents/`, `.claude/`, `tooling/hooks/`, `scripts/vercel-build.mjs` (referenced from `vercel.json`).

**Local dev database** (decision [0009](../decisions/0009-local-dev-on-docker-postgres.md)).

- `.env.example`: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/signal_dev`, with a comment that a Neon branch URL also works.
- New `scripts/db-dev-setup.ts`, run by `pnpm db:dev` = `pnpm db:up && node --env-file-if-exists=.env.local --import tsx scripts/db-dev-setup.ts`: refuses non-local hosts (`isLocalDatabaseHost` from `lib/signal/db.ts`), creates the database if missing (reuse the create step in `lib/db/prepare-database.ts`), applies `drizzle/` migrations the same way `scripts/db-migrate.ts` does, and runs the demo seed only when the Signal tables are empty.
- No change to `lib/signal/db.ts`: `localhost` already routes through the proxy on port 4444 over plain WebSocket.
- `signal.localhost`: `pnpm dev` (portless, `name: signal`) already sets `PORTLESS_URL`; `lib/site-url.ts` uses it. Confirm the Ledger, submit wizard, and `/operator` load against the local database. If portless needs `pnpm setup:portless` first, say so in `README.md`.
- `docs/database.md`: the Local dev row becomes "Docker Postgres `signal_dev` (`pnpm db:dev`); optional Neon `dev` branch". `ARCHITECTURE.md` and `README.md` quick start name `pnpm db:dev`.
- Your `.env.local` currently points `DATABASE_URL` at Neon. The build switches it to the Docker URL locally (never committed) so the manual check exercises the new path.

**Exposure.** No new deployable behaviour: production and previews keep the Neon integration and Gateway OIDC. `db:dev` refuses any non-local host, so it cannot seed or migrate Neon.

## Testing Decisions

Per the delivery mode, no test runs. Gates: `pnpm lint`, `pnpm check-types`, `pnpm build:mcp-app` (it imports components, so it catches a wrongly deleted one), and the manual journey below. CI runs the full suite on the PR as usual.

**Acceptance scenario.** Actor: a developer with Docker running and `AI_GATEWAY_API_KEY` set; `.env.local` has `DATABASE_URL=postgres://postgres:postgres@localhost:5432/signal_dev`; no `signal_dev` database exists.

1. `pnpm db:dev` → compose stack healthy; log says `signal_dev` was created, migrations applied, demo workspace seeded.
2. `pnpm db:dev` again → no error; log says schema current and seed skipped (data present).
3. `pnpm dev`, open `https://signal.localhost` → the Ledger lists the seeded needs; no `database_unavailable`.
4. Open `/submit`, type a signal → preview shows matches (Gateway embedder and judge answer).
5. Open `/operator` with the operator secret → console loads with the pending count.
6. Set `DATABASE_URL` to a Neon URL and run `scripts/db-dev-setup.ts` → it refuses with a non-local-host message and changes nothing.
7. The Anthropic grep in Implementation Decisions returns nothing; `pnpm lint` and `pnpm check-types` pass; `knip` reports no unused files or dependencies outside its documented ignores.

## Direction changes

- `docs/database.md` → Local dev: from "Neon `dev` branch" to "Docker Postgres `signal_dev`, Neon optional" (decision 0009).

## Out of Scope

- Running tests or evals (user instruction; CI covers the suite).
- Deleting unused code in evals beyond dead exports; the Crewday harness stays as is.
- Changing Gateway model ids, provider options, or which models are used.
- Production or preview database changes.

## Further Notes

- `knip` false positives seen: `agents/*/agent/**` (Eve entry points), `mcp-app/src/*` (Vite entry), `scripts/vercel-build.mjs`, `tooling/**`, `lib/genui/scripts/eval-live.ts`, `lib/agent-tools/generate-demo-data.ts` (used by agents), skills under `.agents/` and `.claude/`.
- Open assumption: the GenUI component registry resolves `components/*.tsx` through static imports. If it loads them by name at runtime, `knip`'s unused-file list for `components/` is wrong and those files stay.
