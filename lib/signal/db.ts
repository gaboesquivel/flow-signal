import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

import * as schema from "@/lib/db/schema";

/**
 * Drizzle over the Neon serverless Pool (WebSocket), which supports interactive transactions:
 * every write and its `recordEvent` call run in one `db.transaction`.
 */
export const createSignalDb = (databaseUrl: string) =>
  drizzle({ client: new Pool({ connectionString: databaseUrl }), schema });

export type SignalDb = ReturnType<typeof createSignalDb>;
/** A database handle or an open transaction; domain functions accept either. */
export type SignalTx = Parameters<Parameters<SignalDb["transaction"]>[0]>[0];
export type SignalQueryable = SignalDb | SignalTx;

const pools = new Map<string, SignalDb>();

/** One pooled client per connection string for the process lifetime. */
export const signalDbFor = (databaseUrl: string) => {
  let db = pools.get(databaseUrl);
  if (!db) {
    db = createSignalDb(databaseUrl);
    pools.set(databaseUrl, db);
  }
  return db;
};

export const closeSignalDbs = async () => {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((db) => db.$client.end()));
};
