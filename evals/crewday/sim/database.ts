import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { prepareTestDatabase, schemaStatements } from "@/lib/db/prepare-database";
import * as schema from "@/lib/db/schema";
import { signalTableNames } from "@/lib/db/schema";
import { createSignalDb } from "@/lib/signal/db";
import type { SignalDb } from "@/lib/signal/db";

import { assertSimDatabase } from "./safety";
import type { SimDatabaseTarget } from "./safety";

/**
 * Opens the simulation's database after `assertSimDatabase`: a fresh in-process PGlite with the
 * Drizzle schema, or a local Docker database whose schema is brought up to date and whose Signal
 * tables are emptied (a run always starts from nothing).
 */
interface SimDatabase {
  close: () => Promise<void>;
  db: SignalDb;
}

export const openSimDatabase = async (target: SimDatabaseTarget): Promise<SimDatabase> => {
  assertSimDatabase(target);
  if (target.kind === "pglite") {
    const client = new PGlite({ extensions: { vector } });
    for (const statement of await schemaStatements()) await client.exec(statement);
    const db = drizzle({ client, schema }) as unknown as SignalDb;
    return { close: () => client.close(), db };
  }
  await prepareTestDatabase(target.url);
  const { close, db } = createSignalDb(target.url);
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${signalTableNames.join(", ")} RESTART IDENTITY CASCADE`),
  );
  return { close, db };
};
