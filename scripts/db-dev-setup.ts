// `pnpm db:dev`: prepares the local development database (decision 0009, spec 011). After
// `pnpm db:up`, it creates the DATABASE_URL database behind the local Neon proxy if missing,
// applies the migrations (`scripts/db-migrate.ts`), and seeds the demo workspace
// (`scripts/db-seed.ts`) only when it has no needs yet. Refuses any non-local host, so it never
// touches Neon.
import { execFileSync } from "node:child_process";
import path from "node:path";

import { neon } from "@neondatabase/serverless";

import { configureNeonFor, isLocalDatabaseHost } from "@/lib/signal/db";

const log = (message: string) => console.log(`[db:dev] ${message}`);
const fail = (message: string): never => {
  console.error(`[db:dev] ${message}`);
  process.exit(1);
};

const databaseUrl =
  process.env.DATABASE_URL?.trim() || fail("DATABASE_URL is not set (see .env.example).");
const url = new URL(databaseUrl);
if (!isLocalDatabaseHost(url.hostname))
  fail(`DATABASE_URL points at ${url.hostname}, not a local host; nothing was changed.`);
const name = decodeURIComponent(url.pathname.slice(1));
if (!/^[a-z0-9_]+$/u.test(name))
  fail(`Database name must be lowercase letters, digits, or _: ${name}`);

configureNeonFor(databaseUrl);
const admin = new URL(databaseUrl);
admin.pathname = "/postgres";
const adminSql = neon(admin.toString());
const existing = await adminSql.query("select 1 from pg_database where datname = $1", [name]);
if (existing.length === 0) {
  await adminSql.query(`create database ${name}`);
  log(`created ${name}.`);
} else log(`${name} exists.`);

const script = (file: string) =>
  execFileSync(process.execPath, ["--import", "tsx", path.resolve(import.meta.dirname, file)], {
    env: process.env,
    stdio: "inherit",
  });

script("db-migrate.ts");

const sql = neon(databaseUrl);
const [{ count } = { count: 0 }] = (await sql.query(
  "select count(*)::int as count from needs",
)) as {
  count: number;
}[];
if (count > 0) log(`seed skipped (${count} needs present).`);
else script("db-seed.ts");
