# 0001 — Neon Postgres with pgvector for Signal's data and similarity search

Status: Proposed (2026-10-30)

## Context

Signal needs durable relational data (needs, signals, merges, suggestions, decisions, an append-only event log) and nearest-neighbour search over need embeddings on every submission. The template ships Drizzle and the Neon serverless driver, but the project was set up with the `minimal` preset, so no database exists yet. Provisioning Neon creates external resources and needs the user's explicit yes.

## Options

1. **Neon Postgres with pgvector**, through the template's Drizzle and Neon seams.
2. Postgres plus a separate vector store (Pinecone, Turbopuffer).
3. In-memory or file storage for the demo only.

## Decision

Option 1. One store holds relational data, events, and vectors, so a signal, its event, and its embedding commit in one transaction; metrics are plain SQL; the template's setup preset provisions it and Vercel integrates it. Tests use PGlite with the `vector` extension so they run without network.

## Consequences

- Similarity search scale is bounded by pgvector on one Neon branch: fine for thousands of needs, revisit at hundreds of thousands.
- Choosing a different store later means rewriting the repository and metric queries, which is why this is a record.
- Provisioning waits for the user's explicit yes (`FLOW_PRESET=neon` setup). Until then, signal endpoints fail with `database_unavailable`.
- PGlite and Neon can drift in extension behaviour; contract tests against a real `DATABASE_URL` run when one is set.
