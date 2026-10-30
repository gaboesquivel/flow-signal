# signal

Single-app agentic Next.js template: public Assistant, protected Operator, Eve, OpenUI Lang GenUI, MCP Streamable HTTP, and MCP Apps.

## Quick start

```bash
gh repo create my-app --private --template gaboesquivel/signal --clone
cd my-app
pnpm setup
```

Then ask your agent to `/start` (or say "start a new project"): Flow's skills ship in this repository, so it defines the product, renames the template, and makes the initial commit. Run `pnpm dev` and open the Portless URL (default host `signal.localhost`).

**First deployment.** Import the repository in [Vercel](https://vercel.com/new); every push to `main` deploys. No environment variables are required: without `AI_GATEWAY_API_KEY` generation falls back to built-in content, and Operator stays closed until `OPERATOR_SECRET` is set. For the database, run `pnpm neon:setup` (needs `NEON_API_KEY` and `VERCEL_TOKEN`); production builds apply the schema. See [docs/database.md](./docs/database.md).

## Scripts

| Script              | Purpose                                                 |
| ------------------- | ------------------------------------------------------- |
| `pnpm setup`        | Dependencies, `.env.local`, optional Neon               |
| `pnpm neon:setup`   | Neon database, local and Vercel `DATABASE_URL`          |
| `pnpm db:migrate`   | Apply versioned migrations (never destructive)          |
| `pnpm db:generate`  | Write a migration from schema changes                   |
| `pnpm db:dev`       | Local Docker database: create, migrate, seed (once)     |
| `pnpm dev`          | Development via Portless                                |
| `pnpm qa`           | Lint, types, tests                                      |
| `pnpm test:changed` | Tests affected by changes since `origin/main`           |
| `pnpm build`        | Production build (includes MCP App bundle)              |
| `pnpm eval`         | Offline GenUI, Eve smoke, live matching and agent evals |
| `pnpm eval:crewday` | Crewday outcome eval (live, dollars; on demand)         |

## Surfaces

- **Assistant** — `/`, `/genui`, `/api/chat`, `/api/mcp`, `/mcp`
- **Operator** — `/operator`, `/api/operator/chat`, `/api/mcp/operator` (requires `OPERATOR_SECRET`)

Cross-template contract: [docs/INTEROP.md](./docs/INTEROP.md).

Agent skills for this stack: [docs/agent-skills.md](./docs/agent-skills.md).

## Deploy

Vercel-first; `vercel.json` runs `scripts/vercel-build.mjs` (schema on production builds with `DATABASE_URL`, then `pnpm build`).
