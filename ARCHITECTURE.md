# Signal — architecture

## Foundation

Initialized from [`flow-next`](https://github.com/gaboesquivel/flow-next) at commit `4dcbf0f`.

## Runtime surfaces

| Surface          | Path                                | Notes                                 |
| ---------------- | ----------------------------------- | ------------------------------------- |
| Web home         | `/`                                 | Replaceable stub                      |
| GenUI playground | `/genui`                            | OpenUI compose + preview              |
| Public MCP       | `/api/mcp`, `/.well-known/mcp.json` | Streamable HTTP                       |
| Operator         | `/operator`, `/api/mcp/operator`    | Protected; fail closed without secret |

Cross-template interoperability details live in `docs/INTEROP.md` from the template (upstream template names may appear there by design).

## Local development

- `pnpm setup` — dependencies and template technical skills
- `pnpm dev` — Portless at `signal.localhost`

## Data

Neon Postgres with pgvector, through Drizzle (`lib/db/schema.ts`) and the Neon serverless driver ([decision 0001](./docs/decisions/0001-neon-postgres-pgvector.md)). Provisioning, branches, environment variables, and schema changes: [docs/database.md](./docs/database.md).

## Signal operations

Every capability is one operation in `lib/signal/operations/`, exposed through thin adapters as REST routes, MCP tools (public or Operator), and Eve agent tools; the UI uses the generated typed client. A parity test suite keeps the surfaces consistent ([spec 001](./docs/specs/001-signal-mvp.md)).

## Testing

- **Automated tests cover the API, MCP, and agent surfaces only:** operation contracts, the parity suite (REST, MCP, and agent tools agree on output, error codes, events, and access), domain behaviour on a test database, migration safety, and agent tool behaviour. Parity proves the surfaces agree; behaviour cases belong in domain tests.
- **No UI tests:** no component, unit, or browser (Playwright) tests for pages or components. UI is checked by hand in a browser against [DESIGN.md](./DESIGN.md) → Checking rendered output.
- **CI is light:** `pnpm qa` (lint, types, and unit/parity/domain tests on in-process PGlite). Live-model evals (`pnpm eval`) run on demand and whenever agent code changes, never in CI.
