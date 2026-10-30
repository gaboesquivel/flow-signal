import { execSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const run = (cmd) => execSync(cmd, { cwd: root, env: process.env, stdio: "inherit" });

// Only production applies the schema, so previews never change the shared database.
const migrate =
  Boolean(process.env.DATABASE_URL?.trim()) && process.env.VERCEL_ENV === "production";

if (migrate) run("pnpm db:migrate");
else console.warn("[vercel-build] Skipping db:migrate (needs DATABASE_URL on a production build).");

run("pnpm build");
