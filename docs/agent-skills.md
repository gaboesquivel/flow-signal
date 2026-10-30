# Agent skills

This template commits its [Agent Skills](https://agentskills.io), so a fresh clone gives your agent the [Flow](https://github.com/gaboesquivel/flow-skills) methodology and the stack's technical skills with nothing to install. Start a product with `/start` (or say "start a new project").

## Layout

| Path                     | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `skills-lock.json`       | Skill sources and content hashes               |
| `.agents/skills/<name>/` | Installed skills (Codex, Cursor, other agents) |
| `.claude/skills`         | Link to `.agents/skills` for Claude Code       |

## Commands

```bash
pnpm skills:update    # refresh every skill from its source (maintainers)
pnpm skills:install   # restore skills from the lock (pnpm setup runs it when .agents/skills is missing)
```

## Skills

**Flow (workflow):** every skill in [gaboesquivel/flow-skills](https://github.com/gaboesquivel/flow-skills/blob/main/docs/skills.md). Flow owns discovery, specs, delivery, debugging, domain language, and prototyping, so the bundle carries no other workflow skills.

**Runtime and UI:** `ai-sdk`, `eve`, `typesafe-ai`, `nextjs`, `next-dev-loop`, `shadcn`, `building-components`, `nuqs`, `portless`, `vercel-cli`, `vercel-react-best-practices`, `vercel-composition-patterns`, `web-design-guidelines`

**MCP and testing:** `mcp-builder`, `agent-browser`, `vitest`, `playwright`, `test-driven-development`
