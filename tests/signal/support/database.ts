import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe } from "vitest";

import { prepareTestDatabase, schemaStatements } from "../../../lib/db/prepare-database";
import * as schema from "../../../lib/db/schema";
import { signalTableNames } from "../../../lib/db/schema";
import { createFakeAi } from "../../../lib/signal/ai/fakes";
import { closeSignalDbs, signalDbFor } from "../../../lib/signal/db";
import type { SignalDb } from "../../../lib/signal/db";
import { configureSignalRuntime, resetSignalRuntime } from "../../../lib/signal/runtime";

/**
 * Database harness for `tests/signal/**` (lib/signal/README.md → Tests).
 *
 * - `DATABASE_URL_TEST` set (shell env wins over .env.local): a local Docker Postgres behind
 *   the Neon proxy (`pnpm db:up`), reached with the production driver. The database is created
 *   and its schema applied if needed.
 * - Unset (CI): in-process PGlite with pgvector, fresh per test file, schema from Drizzle.
 *
 * Either way every Signal table is emptied before the file's tests. Tests never skip.
 */

export const testDatabaseUrl = () => process.env.DATABASE_URL_TEST?.trim() || undefined;

export const testDatabaseBackend = () => (testDatabaseUrl() ? "postgres" : "pglite");

const openPglite = async () => {
  const client = new PGlite({ extensions: { vector } });
  for (const statement of await schemaStatements()) await client.exec(statement);
  const db = drizzle({ client, schema }) as unknown as SignalDb;
  return { close: () => client.close(), db };
};

const openPostgres = async (url: string) => {
  await prepareTestDatabase(url);
  return { close: () => closeSignalDbs(), db: signalDbFor(url) };
};

/** Opens the test database for one file (see the module comment for which one). */
export const openTestDatabase = () => {
  const url = testDatabaseUrl();
  return url ? openPostgres(url) : openPglite();
};

/** `describe` for tests that need the database; the name notes the backend. */
export const describeWithDatabase = (name: string, body: () => void) =>
  describe(`${name} [${testDatabaseBackend()}]`, body);

/** Empties every Signal table. */
export const resetDatabase = async (db: SignalDb) => {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${signalTableNames.join(", ")} RESTART IDENTITY CASCADE`),
  );
};

/**
 * Call inside `describeWithDatabase`: opens the database, empties it, routes every adapter to
 * it with fake AI ports (override per test with `configureSignalRuntime`), and closes it after.
 */
export const useTestDatabase = () => {
  const state: { close?: () => Promise<void>; db?: SignalDb } = {};
  beforeAll(async () => {
    const opened = await openTestDatabase();
    state.db = opened.db;
    state.close = opened.close;
    configureSignalRuntime({ ai: createFakeAi(), db: opened.db });
    await resetDatabase(opened.db);
  });
  afterAll(async () => {
    resetSignalRuntime();
    await state.close?.();
  });
  return {
    get db() {
      if (!state.db) throw new Error("The test database opens in beforeAll.");
      return state.db;
    },
  };
};
