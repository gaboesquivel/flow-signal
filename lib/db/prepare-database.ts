import { createHash } from "node:crypto";

import { neon } from "@neondatabase/serverless";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

import * as schema from "@/lib/db/schema";
import { configureNeonFor } from "@/lib/signal/db";

/**
 * Test-database tooling (never imported by the app): the DDL for `lib/db/schema.ts`, and a
 * function that creates a database behind the local Neon proxy and brings its schema up to date.
 * Used by `pnpm db:test:setup` and the test harness. Neon branches use `pnpm db:migrate`.
 */

/** Every statement that builds the schema from empty, pgvector first. */
export const schemaStatements = async () => [
  "CREATE EXTENSION IF NOT EXISTS vector",
  ...(await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ ...schema }))),
];

const MARKER = "_signal_schema";

/**
 * Creates the database named in `databaseUrl` if missing, then (re)builds its `public` schema
 * when the Drizzle schema changed since the last run (tracked by a hash in `_signal_schema`).
 * Destructive by design: only point it at a test database.
 */
export const prepareTestDatabase = async (databaseUrl: string) => {
  configureNeonFor(databaseUrl);
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+$/u.test(name))
    throw new Error(`Test database name must be lowercase letters, digits, or _: ${name}`);

  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const adminSql = neon(admin.toString());
  const existing = await adminSql.query("select 1 from pg_database where datname = $1", [name]);
  if (existing.length === 0) await adminSql.query(`create database ${name}`);

  const statements = await schemaStatements();
  const hash = createHash("sha256").update(statements.join(";\n")).digest("hex");
  const sql = neon(databaseUrl);
  // Missing marker table (a new database) means "build the schema".
  const marker = await sql.query(`select hash from public.${MARKER} limit 1`).catch(() => []);
  if ((marker[0] as { hash?: string } | undefined)?.hash === hash) return { created: false };

  await sql.query("drop schema if exists public cascade");
  await sql.query("create schema public");
  // DDL is order-dependent (types before tables before foreign keys).
  // oxlint-disable-next-line eslint/no-await-in-loop
  for (const statement of statements) await sql.query(statement);
  await sql.query(`create table public.${MARKER} (hash text not null)`);
  await sql.query(`insert into public.${MARKER} (hash) values ($1)`, [hash]);
  return { created: true };
};
