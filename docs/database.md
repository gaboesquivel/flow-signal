# Database

Signal stores everything in Neon Postgres with the pgvector extension ([decision 0001](./decisions/0001-neon-postgres-pgvector.md)), accessed through Drizzle (`lib/db/schema.ts`) and `@neondatabase/serverless`.

## Databases

| Where                       | Env var             | Database                                                                    |
| --------------------------- | ------------------- | --------------------------------------------------------------------------- |
| Local dev and all of Vercel | `DATABASE_URL`      | Neon `main` branch                                                          |
| Local tests                 | `DATABASE_URL_TEST` | Docker Postgres 18 + pgvector behind a local Neon HTTP proxy (`pnpm db:up`) |
| CI, or tests without it set | (unset)             | In-process PGlite with the `vector` extension                               |

Tests never touch Neon. Each test file resets the tables it uses; parallel workers use separate database names on the Docker server. See [decision 0003](./decisions/0003-local-test-databases.md).

## Local test database

```bash
pnpm db:up
```

Then set `DATABASE_URL_TEST=postgres://postgres:postgres@db.localtest.me:5432/signal_test` in `.env.local` (the default in `.env.example`). The test harness creates the database, enables pgvector, and applies the schema. Stop it with `pnpm db:down`. Without Docker, leave `DATABASE_URL_TEST` empty and tests run on PGlite.

## Current setup

Since 2026-10-30 the database comes from Vercel's **Neon integration** (Vercel Marketplace):

- Resource `signal` (`store_a1g5Ym4xwQ9EDfP4`), Neon free plan, region `iad1`, in the Vercel-managed Neon org, connected to the Vercel project `flow-signal` for production, preview, and development.
- The integration owns `DATABASE_URL`, `POSTGRES_URL`, `PGHOST`, `NEON_PROJECT_ID`, and related variables on Vercel. Don't set them by hand.
- **Preview deployments get their own Neon branch** when the connection's deployments configuration has Preview set to create a branch (Vercel project → Storage → `signal` → Settings). The branch is created from `main` for each preview deployment, so previews never write to production data.
- Locally, `.env.local` holds the development `DATABASE_URL` (gitignored). Refresh it without overwriting other local values: pull to a temporary file with `vercel env pull <tmp file> --environment development` and copy only `DATABASE_URL` across. Plain `vercel env pull` replaces `.env.local` and drops local-only values such as `OPERATOR_SECRET`.
- **Known gaps:** `scripts/vercel-build.mjs` applies the schema on production builds only, so a preview of a pull request that changes the schema runs against its branch's old schema until the change reaches `main`. The development environment (and so local dev) uses the production `main` database unless the connection's Development setting creates a branch.
- An earlier hand-made project (`signal`, `wispy-paper-65345567`, in the **Gabo** Neon org) is no longer used.

## First-time setup with the Vercel integration

Needs only `vercel` signed in and the project linked:

```bash
vercel integration add neon -n signal -m region=iad1 -m auth=false --no-env-pull
```

Then enable the Preview branch setting described above, copy `DATABASE_URL` into `.env.local`, and push the schema (below).

## Without the integration (tokens)

Only for projects that don't use the Vercel integration; it sets `DATABASE_URL` by hand and gives previews no branch. Needs a Neon API key and a Vercel token, passed for this one command only (never written to files):

```bash
NEON_API_KEY=<neon key> VERCEL_TOKEN=<vercel token> VERCEL_TEAM_ID=<vercel team id> pnpm neon:setup
```

`pnpm neon:setup` runs the template setup with `FLOW_PRESET=neon` (`tooling/setup/data-preset.mjs`). It is idempotent:

- finds or creates the Neon project named after the package (`signal`), Postgres 17;
- writes its pooled connection string to `DATABASE_URL` in `.env.local` (gitignored), only when empty;
- adds `DATABASE_URL` to the linked Vercel project (`.vercel/project.json`) for production, preview, and development, only when missing.

`VERCEL_TEAM_ID` is the `orgId` in `.vercel/project.json` and is required because the project lives under a Vercel team.

Then push the schema:

```bash
set -a && . ./.env.local && set +a && pnpm db:migrate
```

`drizzle-kit` does not read `.env.local`, so the command loads it into the shell first.

Spec 001's schema enables pgvector (`CREATE EXTENSION IF NOT EXISTS vector`) when it is pushed.

## Schema changes

Edit `lib/db/schema.ts` and make the tests pass (Docker or PGlite apply the schema themselves), then run `pnpm db:migrate` (Drizzle `push`) against the development database. Production builds on Vercel apply the schema automatically when `DATABASE_URL` is set (`scripts/vercel-build.mjs`).

## Without a database

Signal endpoints return `database_unavailable` (503). Tests never need Neon: without `DATABASE_URL_TEST` they run on PGlite.
