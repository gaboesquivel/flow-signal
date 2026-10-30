# Signal — architecture

## Foundation

Initialized from [`flow-next`](https://github.com/gaboesquivel/flow-next) at commit `4dcbf0f`.

## Runtime surfaces

| Surface        | Path                                                                                 | Notes                                                                               |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Public board   | `/`, `/needs/[id]`, `/submit`, `/my/[token]`                                         | Lean Ledger UI ([spec 006](./docs/specs/006-lean-ledger-ui.md))                     |
| Public MCP     | `/api/mcp`, `/.well-known/mcp.json`                                                  | Streamable HTTP                                                                     |
| Operator       | `/operator/{triage,needs,decide,criteria,metrics,reports,chat}`, `/api/mcp/operator` | PM console; protected; fail closed without secret                                   |
| Shared reports | `/r/[token]`                                                                         | Read-only report snapshot; token-gated ([spec 013](./docs/specs/013-pm-reports.md)) |

Cross-template interoperability details live in `docs/INTEROP.md` from the template (upstream template names may appear there by design).

## Local development

- `pnpm setup` — dependencies and template technical skills
- `pnpm db:dev` — local Docker Postgres `signal_dev` behind the Neon proxy, migrated and seeded ([decision 0009](docs/decisions/0009-local-dev-on-docker-postgres.md))
- `pnpm dev` — Portless at `signal.localhost`

## Data

Neon Postgres with pgvector, through Drizzle (`lib/db/schema.ts`) and the Neon serverless driver ([decision 0001](./docs/decisions/0001-neon-postgres-pgvector.md)). Provisioning, branches, environment variables, and schema changes: [docs/database.md](./docs/database.md).

## Signal operations

Every capability is one operation in `lib/signal/operations/`, exposed through thin adapters as REST routes, MCP tools (public or Operator), and Eve agent tools; the UI uses the generated typed client. A parity test suite keeps the surfaces consistent ([spec 001](./docs/specs/001-signal-mvp.md)). PM Reports ([spec 013](./docs/specs/013-pm-reports.md), [decision 0010](./docs/decisions/0010-reports-as-typed-specs-over-named-datasets.md)): a report is a typed spec (`domain/report-spec.ts`) whose blocks reference columns of named datasets (`domain/report-datasets.ts`, `get_report_dataset`); `generate_report` plans and composes it with the reasoner, saved reports re-run their dataset queries with no model call, and `share_report` snapshots one behind `/r/<token>`. `/genui` redirects to `/operator/reports`; `lib/genui` stays for the public `compose_ui` MCP tool and the MCP app. Operator-only reads for the console: `list_operator_needs` (every live need with demand, money, score, and pending suggestions) and `check_public_text` (flags names, accounts, and emails before anything is published) ([spec 006](./docs/specs/006-lean-ledger-ui.md)).

Operator assistant ([spec 014](./docs/specs/014-operator-assistant.md), [decision 0011](./docs/decisions/0011-assistant-writes-are-server-held-proposals.md); experimental behind `OPERATOR_ASSISTANT=on`, read on the server): with the flag on, `/operator/chat` is a `useChat` (`@ai-sdk/react`) view over `POST /api/operator/assistant`, a UI message stream with read tools, `show_data` (an inline report spec run through the report datasets), and `propose_<op>` tools. A proposal is a server-held row in `assistant_actions` with the operation's `preview`; the stream never writes. Only `POST /api/operator/assistant/actions/:id` (`confirm` with optional edits, or `reject`) runs the write, as `console:assistant`, after re-checking the preview; `GET` returns the action's true state for the card. Both routes are Operator-only and `not_found` with the flag off; with it off, Chat is the spec 006 chat.

My signals: signals point to a shared tracking link (`tracking_links`), so a submitter's next submissions join the link they hold; legacy per-signal tokens are adopted on first use ([decision 0005](./docs/decisions/0005-my-signals-link-carries-forward.md)).

## Testing

- **Automated tests cover the API, MCP, and agent surfaces only:** operation contracts, the parity suite (REST, MCP, and agent tools agree on output, error codes, events, and access), domain behaviour on a test database, migration safety, and agent tool behaviour. Parity proves the surfaces agree; behaviour cases belong in domain tests.
- **No UI tests:** no component, unit, or browser (Playwright) tests for pages or components. UI is checked by hand in a browser against [DESIGN.md](./DESIGN.md) → Checking rendered output.
- **CI is light:** `pnpm qa` (lint, types, and unit/parity/domain tests on in-process PGlite). Live-model evals never run in CI.
- **Each check runs once:** workers and the integrator run `pnpm test:changed` plus lint and types for their files; CI runs the full suite once. Don't re-run a green suite to confirm it.
- **Evals match the change, on demand** ([spec 010](./docs/specs/010-retro-remediation.md)). `pnpm eval` is the cheap tier (offline GenUI, Eve smoke, matching, agents); Crewday costs dollars and runs only when asked:

  | Changed path                                      | Eval                                |
  | ------------------------------------------------- | ----------------------------------- |
  | `lib/signal/ai/**`, `lib/signal/domain/matching*` | `pnpm eval:matching`                |
  | `agents/**`, `lib/mcp/**`                         | `pnpm eval:agents`                  |
  | `evals/crewday/**`, policy or metric code         | `pnpm eval:crewday`, when asked for |

- **Models:** every model call goes through the AI Gateway: app and eval code through `lib/ai/models.ts`, Eve agents by Gateway model id. Lint rejects direct provider SDK imports.
