# Database

Signal stores everything in Neon Postgres with the pgvector extension ([decision 0001](./decisions/0001-neon-postgres-pgvector.md)), accessed through Drizzle (`lib/db/schema.ts`) and `@neondatabase/serverless`.

## Branches

| Neon branch | Env var             | Used by                                                  |
| ----------- | ------------------- | -------------------------------------------------------- |
| `main`      | `DATABASE_URL`      | Local dev and all Vercel environments                    |
| `test`      | `DATABASE_URL_TEST` | Domain, contract, and parity tests (`pnpm test`), and CI |

Tests never touch `main`. Each test file resets the tables it uses.

## Current project

Provisioned on 2026-10-30:

- Neon project `signal` (`wispy-paper-65345567`) in the **Gabo** org (`org-rough-dust-14948184`), region `aws-us-east-1` (next to Vercel's default `iad1`), Postgres 18.
- Branches `main` and `test`; schema pushed to both.
- `DATABASE_URL` (pooled `main`) set on the Vercel project `flow-signal` for production, preview, and development as a sensitive variable.
- Locally, `.env.local` holds `DATABASE_URL` and `DATABASE_URL_TEST` (gitignored). Get them again with `neonctl connection-string <branch> --project-id wispy-paper-65345567 --pooled`.

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
