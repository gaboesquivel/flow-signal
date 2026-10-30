# Dev loop: Flow skills to shipped commit

How work moves through this repo. Skills live in `.agents/skills/` (linked at `.claude/skills`), pinned by `skills-lock.json`. Source: [AGENTS.md](../../AGENTS.md), [docs/agent-skills.md](../agent-skills.md).

## Idea to production

```mermaid
flowchart LR
  I[Idea] --> EX[explore<br/>problem, users, uncertainty]
  EX --> IN[interview / grill<br/>pin intent, stress-test]
  IN --> SP[to-spec<br/>docs/specs/NNN draft → accepted]
  SP --> DEC[decision record<br/>docs/decisions, when lasting]
  SP --> TK[to-tasks<br/>vertical slices in the spec]
  TK --> BU[build<br/>branch, TDD, review, fix, checks]
  BU --> RV[review<br/>against spec: correctness, readability,<br/>architecture, security, performance]
  RV --> SH{land}
  SH -->|ship| MAIN[merge to main + liveness check]
  SH -->|push| BR[push branch, no PR]
  MAIN --> FL[flow: update the docs<br/>PRODUCT, DESIGN, GLOSSARY, ARCHITECTURE]
```

Side skills: `design` (visual direction → DESIGN.md), `prototype`, `debug`, `domain-modeling` (GLOSSARY.md), `board` (spec progress from git), `align` / `measure`, `retro`, `handoff`.

## Building one operation (test-first)

```mermaid
flowchart LR
  A[defineOperation contract<br/>name, access, http, input, output, errors, effects] --> B[parity table · red]
  B --> C[domain tests · red]
  C --> D[implement run<br/>domain/ + transaction + recordEvent]
  D --> E[green: REST, MCP, Eve,<br/>OpenAPI picked up automatically]
  E --> F[pnpm signal:client<br/>regenerate typed client]
  F --> G{agent-facing text changed?}
  G -->|yes| H[pnpm eval:agents]
```

## Gates

```mermaid
flowchart LR
  subgraph Local
    PC[pre-commit · simple-git-hooks<br/>block secret files + lint/format staged]
    QA[pnpm qa<br/>lint · types · tests]
    EV[pnpm eval<br/>live models, on demand]
  end
  subgraph GitHub
    CI[CI verify<br/>security:check + pnpm qa on PGlite]
    PT[PR title check]
  end
  subgraph Vercel
    PV[preview deploy<br/>no schema changes]
    PR[production deploy from main<br/>vercel-build.mjs applies schema]
  end
  PC --> QA --> CI --> PV --> PR
  PT --> PV
  EV -.-> QA
```

## Local runtime

```mermaid
flowchart LR
  SET[pnpm setup<br/>deps, .env.local, skills] --> DEV[pnpm dev<br/>Portless → signal.localhost]
  DBU[pnpm db:up<br/>Docker db :5432 + neon-proxy :4444] --> TST[DATABASE_URL_TEST=... pnpm test]
  SEED[pnpm db:seed<br/>8 accounts, 4 themes, 25 needs, 150 signals] --> DEV
```

Every prompt to an agent in this repo is also logged to `prompts.txt` (AGENTS.md → Prompt Logging).
