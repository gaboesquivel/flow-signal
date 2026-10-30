// Enables the Postgres extensions the Drizzle schema needs before `drizzle-kit push`,
// which does not create extensions itself. Reads DATABASE_URL like drizzle.config.ts.
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("[db-extensions] DATABASE_URL is not set; nothing to do.");
  process.exit(1);
}

await neon(url)`CREATE EXTENSION IF NOT EXISTS vector`;
console.log("[db-extensions] pgvector enabled.");
