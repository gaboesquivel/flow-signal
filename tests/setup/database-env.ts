import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Runs before every test file. Tests reach Postgres only through `DATABASE_URL_TEST` (local
 * Docker behind the Neon proxy), read from the shell or else `.env.local`; without it they use
 * in-process PGlite (tests/signal/support/database.ts). `DATABASE_URL` is pointed at the test
 * database or removed, so no route handler under test can reach the dev or production database.
 */
const envFile = path.join(import.meta.dirname, "..", "..", ".env.local");
// An explicitly empty DATABASE_URL_TEST (`DATABASE_URL_TEST= pnpm test`) skips the file.
if (process.env.DATABASE_URL_TEST === undefined && existsSync(envFile)) {
  const fromFile = parseEnv(readFileSync(envFile, "utf-8")).DATABASE_URL_TEST?.trim();
  if (fromFile) process.env.DATABASE_URL_TEST = fromFile;
}

const testUrl = process.env.DATABASE_URL_TEST?.trim();
if (testUrl) process.env.DATABASE_URL = testUrl;
else delete process.env.DATABASE_URL;
