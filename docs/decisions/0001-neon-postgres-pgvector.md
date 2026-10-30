# 0001 — Neon Postgres with pgvector for Signal's data and similarity search

Status: Proposed (2026-10-30)

## Context

Signal needs durable relational data (needs, signals, merges, suggestions, decisions, an append-only event log) and nearest-neighbour search over need embeddings on every submission. The template ships Drizzle and the Neon serverless driver, but the project was set up with the `minimal` preset, so it started without a database. Provisioning Neon creates external resources, so it waited for the user's explicit yes (given 2026-10-30).

## Options

1. **Neon Postgres with pgvector**, through the template's Drizzle and Neon seams.
2. Postgres plus a separate vector store (Pinecone, Turbopuffer).
3. In-memory or file storage for the demo only.

## Decision

Option 1. One store holds relational data, events, and vectors, so a signal, its event, and its embedding commit in one transaction; metrics are plain SQL; `pnpm neon:setup` provisions it and writes `DATABASE_URL` locally and on Vercel. Tests run against a dedicated Neon `test` branch, so they exercise the same Postgres and pgvector as production ([docs/database.md](../database.md)).

## Consequences

- Similarity search scale is bounded by pgvector on one Neon branch: fine for thousands of needs, revisit at hundreds of thousands.
- Choosing a different store later means rewriting the repository and metric queries, which is why this is a record.
- Provisioning was approved by the user on 2026-10-30 and runs through `pnpm neon:setup`. Without `DATABASE_URL`, signal endpoints fail with `database_unavailable`.
- Tests need network access and a `DATABASE_URL_TEST` secret in CI; in exchange there is no drift between a test database and production. Each test file resets its own tables.
