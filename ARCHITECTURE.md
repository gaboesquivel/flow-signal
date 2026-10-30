# Signal — architecture

## Foundation

Initialized from [`flow-next`](https://github.com/gaboesquivel/flow-next) at commit `4dcbf0f`.

## Runtime surfaces

| Surface          | Path                                                                         | Notes                                                           |
| ---------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Public board     | `/`, `/needs/[id]`, `/submit`, `/my/[token]`                                 | Lean Ledger UI ([spec 006](./docs/specs/006-lean-ledger-ui.md)) |
| GenUI playground | `/genui`                                                                     | OpenUI compose + preview                                        |
| Public MCP       | `/api/mcp`, `/.well-known/mcp.json`                                          | Streamable HTTP                                                 |
| Operator         | `/operator/{triage,needs,decide,criteria,metrics,chat}`, `/api/mcp/operator` | PM console; protected; fail closed without secret               |

Cross-template interoperability details live in `docs/INTEROP.md` from the template (upstream template names may appear there by design).

## Local development

- `pnpm setup` — dependencies and template technical skills
- `pnpm dev` — Portless at `signal.localhost`

## Data

Neon Postgres with pgvector, through Drizzle (`lib/db/schema.ts`) and the Neon serverless driver ([decision 0001](./docs/decisions/0001-neon-postgres-pgvector.md)). Provisioning, branches, environment variables, and schema changes: [docs/database.md](./docs/database.md).

## Signal operations

Every capability is one operation in `lib/signal/operations/`, exposed through thin adapters as REST routes, MCP tools (public or Operator), and Eve agent tools; the UI uses the generated typed client. A parity test suite keeps the surfaces consistent ([spec 001](./docs/specs/001-signal-mvp.md)). Operator-only reads for the console: `list_operator_needs` (every live need with demand, money, score, and pending suggestions) and `check_public_text` (flags names, accounts, and emails before anything is published) ([spec 006](./docs/specs/006-lean-ledger-ui.md)).

My signals: signals point to a shared tracking link (`tracking_links`), so a submitter's next submissions join the link they hold; legacy per-signal tokens are adopted on first use ([decision 0005](./docs/decisions/0005-my-signals-link-carries-forward.md)).

## Testing

- **Automated tests cover the API, MCP, and agent surfaces only:** operation contracts, the parity suite (REST, MCP, and agent tools agree on output, error codes, events, and access), domain behaviour on a test database, migration safety, and agent tool behaviour. Parity proves the surfaces agree; behaviour cases belong in domain tests.
- **No UI tests:** no component, unit, or browser (Playwright) tests for pages or components. UI is checked by hand in a browser against [DESIGN.md](./DESIGN.md) → Checking rendered output.
- **CI is light:** `pnpm qa` (lint, types, and unit/parity/domain tests on in-process PGlite). Live-model evals never run in CI.
- **Each check runs once:** workers run `pnpm test:changed` plus lint and types for their files; the integrator and CI run the full suite once. Don't re-run a green suite to confirm it.
- **Evals match the change, on demand** ([spec 010](./docs/specs/010-retro-remediation.md)). `pnpm eval` is the cheap tier (offline GenUI, Eve smoke, matching, agents); Crewday costs dollars and runs only when asked:

  | Changed path                                      | Eval                                |
  | ------------------------------------------------- | ----------------------------------- |
  | `lib/signal/ai/**`, `lib/signal/domain/matching*` | `pnpm eval:matching`                |
  | `agents/**`, `lib/mcp/**`                         | `pnpm eval:agents`                  |
  | `evals/crewday/**`, policy or metric code         | `pnpm eval:crewday`, when asked for |

- **Models:** every model call goes through the AI Gateway via `lib/ai/models.ts`; lint rejects direct provider SDK imports.
