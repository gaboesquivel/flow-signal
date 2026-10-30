# Database

Signal stores everything in Neon Postgres with the pgvector extension ([decision 0001](./decisions/0001-neon-postgres-pgvector.md)), accessed through Drizzle (`lib/db/schema.ts`) and `@neondatabase/serverless`.

## Branches

| Neon branch | Env var             | Used by                                                  |
| ----------- | ------------------- | -------------------------------------------------------- |
| `main`      | `DATABASE_URL`      | Local dev and all Vercel environments                    |
| `test`      | `DATABASE_URL_TEST` | Domain, contract, and parity tests (`pnpm test`), and CI |

Tests never touch `main`. Each test file resets the tables it uses.

## First-time setup

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

```bash
pnpm db:migrate
```

```bash
DATABASE_URL="$DATABASE_URL_TEST" pnpm db:migrate
```

Spec 001's schema enables pgvector (`CREATE EXTENSION IF NOT EXISTS vector`) on each branch when it is pushed.

## Schema changes

Edit `lib/db/schema.ts`, then run `pnpm db:migrate` (Drizzle `push`) against `test` first, then `main`. Production builds on Vercel apply the schema automatically when `DATABASE_URL` is set (`scripts/vercel-build.mjs`).

## Without a database

Signal endpoints return `database_unavailable` (503) and tests that need a database are skipped locally with a message. In CI, `DATABASE_URL_TEST` is a required secret and missing it fails the run.
