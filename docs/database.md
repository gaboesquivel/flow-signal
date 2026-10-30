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

## Current project

Provisioned on 2026-10-30:

- Neon project `signal` (`wispy-paper-65345567`) in the **Gabo** org (`org-rough-dust-14948184`), region `aws-us-east-1` (next to Vercel's default `iad1`), Postgres 18.
- Branch `main` with the schema pushed. (A `test` branch existed briefly for tests and was removed when tests moved to Docker and PGlite.)
- `DATABASE_URL` (pooled `main`) set on the Vercel project `flow-signal` for production, preview, and development as a sensitive variable.
- Locally, `.env.local` holds `DATABASE_URL` (gitignored). Get it again with `neonctl connection-string main --project-id wispy-paper-65345567 --pooled`.

## First-time setup with signed-in CLIs

This is how the current project was created; it needs no tokens, only `neonctl` and `vercel` signed in. Pass `--org-id` when your Neon account has more than one org.

```bash
neonctl projects create --name signal --org-id <neon org id> --region-id aws-us-east-1
```

```bash
neonctl branches create --project-id <project id> --name test
```

Write `neonctl connection-string main --project-id <project id> --pooled` to `DATABASE_URL` and the `test` equivalent to `DATABASE_URL_TEST` in `.env.local`, then add `DATABASE_URL` to Vercel for each environment (the value is read from stdin; don't paste it into shell history):

```bash
vercel env add DATABASE_URL production --sensitive
```

Repeat for `preview` and `development`, then push the schema to both branches as below.

## First-time setup with tokens

Needs a Neon API key and a Vercel token, passed for this one command only (never written to files):

```bash
NEON_API_KEY=<neon key> VERCEL_TOKEN=<vercel token> VERCEL_TEAM_ID=<vercel team id> pnpm neon:setup
```

`pnpm neon:setup` runs the template setup with `FLOW_PRESET=neon` (`tooling/setup/data-preset.mjs`). It is idempotent:

- finds or creates the Neon project named after the package (`signal`), Postgres 17;
- writes its pooled connection string to `DATABASE_URL` in `.env.local` (gitignored), only when empty;
- adds `DATABASE_URL` to the linked Vercel project (`.vercel/project.json`) for production, preview, and development, only when missing.

`VERCEL_TEAM_ID` is the `orgId` in `.vercel/project.json` and is required because the project lives under a Vercel team.

Then create the test branch and the schema:

```bash
neonctl branches create --project-id <project id> --name test
```

```bash
neonctl connection-string test --project-id <project id> --pooled
```

Put that string in `.env.local` as `DATABASE_URL_TEST`, then push the schema to both branches:

`drizzle-kit` does not read `.env.local`, so load it into the shell first:

```bash
set -a && . ./.env.local && set +a && pnpm db:migrate
```

```bash
set -a && . ./.env.local && set +a && DATABASE_URL="$DATABASE_URL_TEST" pnpm db:migrate
```

Spec 001's schema enables pgvector (`CREATE EXTENSION IF NOT EXISTS vector`) on each branch when it is pushed.

## Schema changes

Edit `lib/db/schema.ts`, then run `pnpm db:migrate` (Drizzle `push`) against `test` first, then `main`. Production builds on Vercel apply the schema automatically when `DATABASE_URL` is set (`scripts/vercel-build.mjs`).

## Without a database

Signal endpoints return `database_unavailable` (503) and tests that need a database are skipped locally with a message. In CI, `DATABASE_URL_TEST` is a required secret and missing it fails the run.
