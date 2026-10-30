import { execSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const run = (cmd) => execSync(cmd, { cwd: root, env: process.env, stdio: "inherit" });

// Production applies the versioned migrations in drizzle/ (scripts/db-migrate.ts), which stops
// the build rather than run anything destructive. Deployments never seed, never run
// `drizzle-kit push`, and never pass --allow-destructive (tests/db/deploy-safety.test.ts).
const migrate =
  Boolean(process.env.DATABASE_URL?.trim()) && process.env.VERCEL_ENV === "production";

if (migrate) run("pnpm db:migrate");
else console.warn("[vercel-build] Skipping db:migrate (needs DATABASE_URL on a production build).");

run("pnpm build");
