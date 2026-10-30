# Dev loop: Flow skills to merged PR

How work moves through this repo. Skills live in `.agents/skills/` (linked at `.claude/skills`), pinned by `skills-lock.json`. Source: [AGENTS.md](../../AGENTS.md), [docs/agent-skills.md](../agent-skills.md), [spec 010](../specs/010-retro-remediation.md).

## Idea to production

```mermaid
flowchart LR
  I[Idea] --> EX[explore<br/>problem, users, uncertainty]
  EX --> IN[interview / grill<br/>pin intent, stress-test]
  IN --> SP[to-spec<br/>docs/specs/NNN draft → accepted]
  SP --> DEC[decision record<br/>docs/decisions, when lasting]
  SP --> TK[to-tasks<br/>vertical slices in the spec]
  TK --> BU[build<br/>branch or worktree, TDD, review, fix, checks]
  BU --> RV[review<br/>against spec: correctness, readability,<br/>architecture, security, performance]
  RV --> PR[PR to main]
  PR --> CK[gh pr checks --watch passes]
  CK --> MG[merge + liveness check]
  MG --> FL[flow: update the docs<br/>PRODUCT, DESIGN, GLOSSARY, ARCHITECTURE]
```

Side skills: `design` (visual direction → DESIGN.md), `prototype` (HTML rounds in `docs/design/`), `debug`, `domain-modeling` (GLOSSARY.md), `board` (spec progress from git), `align` / `measure`, `retro` (spec 010 came from one), `handoff`.

## Building one operation (test-first)

```mermaid
flowchart LR
  A[defineOperation contract<br/>name, access, http, input, output, errors, effects] --> B[parity table · red]
  B --> C[domain tests · red]
  C --> D[implement run<br/>domain/ + transaction + recordEvent]
  D --> E[green: REST, MCP, Eve,<br/>OpenAPI picked up automatically]
  E --> F[pnpm signal:client<br/>regenerate typed client]
  F --> S{schema changed?}
  S -->|yes| MG[pnpm db:generate<br/>additive migration]
  F --> G{agent-facing text changed?}
  G -->|yes| H[pnpm eval:agents]
```

## Agent environment

```mermaid
flowchart LR
  P[User prompt] --> HK[UserPromptSubmit hook<br/>log-prompt.mjs → prompts.txt]
  HK --> AG[Agent works]
  AG --> PERM{.claude/settings.json}
  PERM -->|allow| AL[gh pr, vercel env/logs, neonctl list,<br/>pnpm qa, test:changed, cheap evals, docker db]
  PERM -->|ask| AS[deletes, db:seed, db:migrate]
  WT[New worktree] --> WI[.worktreeinclude copies<br/>.env.local and .vercel/]
  AG --> RESP[append Response line to prompts.txt]
```

## Gates

```mermaid
flowchart LR
  subgraph Local
    PC[pre-commit · simple-git-hooks<br/>block secret files + lint/format staged]
    TC[pnpm test:changed<br/>+ lint + types for touched files]
    EV[matched eval, on demand]
  end
  subgraph GitHub
    CI[CI verify<br/>security:check + pnpm qa on PGlite]
    PT[PR title check]
  end
  subgraph Vercel
    PV[preview deploy<br/>no schema changes]
    PR[production deploy from main<br/>vercel-build.mjs applies migrations]
  end
  PC --> TC --> CI --> PV --> PR
  PT --> PV
  EV -.-> TC
```

Each check runs once: workers run changed tests, CI runs the full suite. Don't re-run a green suite to confirm it.

## Local runtime

```mermaid
flowchart LR
  SET[pnpm setup<br/>deps, .env.local, skills] --> DEV[pnpm dev<br/>Portless → signal.localhost]
  PULL[vercel env pull .env.local<br/>Gateway OIDC token, ~12 h] --> DEV
  DBU[pnpm db:up<br/>Docker db :5432 + neon-proxy :4444] --> TST[DATABASE_URL_TEST=... pnpm test:changed]
  SEED[pnpm db:seed --replace<br/>8 accounts, 4 themes, 25 needs, 150 signals] --> DEV
```
