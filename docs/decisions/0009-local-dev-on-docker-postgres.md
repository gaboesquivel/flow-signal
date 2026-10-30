# 0009 — Local development runs on Docker Postgres by default

Status: Accepted (2026-10-30). Amends [0003](./0003-local-test-databases.md) (the development database only).

## Context

[0003](./0003-local-test-databases.md) put local tests on Docker Postgres 18 + pgvector behind the local Neon proxy, and kept Neon cloud (a `dev` branch) for `DATABASE_URL` in development. In practice, `pnpm dev` at `signal.localhost` needs a Neon branch, network access, and a copied connection string before any Signal page renders data; without one, Signal endpoints return `database_unavailable`. The Docker stack (`pnpm db:up`) already runs the production driver against the same engine and is on every developer machine.

## Options

1. **Keep Neon `dev` branch for development** (0003 as written).
2. **Docker Postgres by default for development**, on its own database (`signal_dev`) in the same compose stack as tests; Neon `dev` stays available by setting `DATABASE_URL` to it.
3. **PGlite for development**, in-process, no Docker.

## Decision

Option 2, chosen by the user (2026-10-30).

- `.env.example` sets `DATABASE_URL=postgres://postgres:postgres@localhost:5432/signal_dev`. `lib/signal/db.ts` already routes `localhost` through the proxy on port 4444.
- One command prepares it: start the stack, create `signal_dev` if missing, apply migrations, and seed the demo workspace when it is empty.
- Vercel production and previews are unchanged (Neon integration). Tests are unchanged (`DATABASE_URL_TEST`, a separate database).

## Consequences

- `pnpm dev` works offline after one setup command; no Neon credentials are needed to develop.
- Development data is local and disposable; anything that must be shared lives on a Neon branch, chosen by overriding `DATABASE_URL`.
- Docker becomes a development prerequisite, not only a test one. Without Docker, a developer points `DATABASE_URL` at a Neon branch as before.
