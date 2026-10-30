# 0003 — Local Docker Postgres for development tests, PGlite in CI

Status: Accepted (2026-10-30). Amends [0001](./0001-neon-postgres-pgvector.md) (test databases only). Amended by [0009](./0009-local-dev-on-docker-postgres.md) (development database: Docker by default).

## Context

Decision 0001 ran the test suites against a dedicated Neon `test` branch. That needs network access, a cloud branch per parallel worker so suites don't reset each other's tables, and a `DATABASE_URL_TEST` secret in CI on a public repository. Docker Desktop is available for local work.

## Options

1. **Neon `test` branches** (0001 as written).
2. **Local Docker Postgres with pgvector behind a local Neon HTTP proxy** for local runs, and **in-process PGlite** with its `vector` extension in CI.
3. Docker everywhere, including CI service containers.
4. Neon's "Neon Local" Docker proxy, which still creates cloud branches and needs an API key.

## Decision

Option 2, chosen by the user.

- **Local:** `docker compose` runs `pgvector/pgvector` on Postgres 18 (matching Neon) and a local Neon HTTP proxy, so tests use the production driver and SQL. Each parallel worker uses its own database name.
- **CI and any run without `DATABASE_URL_TEST`:** PGlite in-process, fresh per test file. CI needs no database service or secret.
- **Neon cloud** stays for development (`DATABASE_URL`) and Vercel.

## Consequences

- Tests run offline and in parallel without cloud branches or CI secrets.
- PGlite is not the production engine; the repository is written against Drizzle's generic Postgres type, and the suite runs locally on both PGlite and Docker Postgres to catch drift. Any query PGlite cannot run is reported, not silently skipped.
- Developers need Docker for the production-like run (`pnpm db:up`); without it, tests still run on PGlite.
