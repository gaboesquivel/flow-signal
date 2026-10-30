import { neonConfig, Pool } from "@neondatabase/serverless";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "@/lib/db/schema";

/**
 * The domain is written against Drizzle's generic Postgres database type, so the same code runs
 * on Neon (production), on local Docker Postgres behind the Neon proxy (local tests), and on
 * in-process PGlite (CI tests). Production and local use the Neon serverless Pool (WebSocket),
 * which supports interactive transactions: every write and its `recordEvent` share one
 * `db.transaction`. (The `neon-http` driver cannot do that.)
 */
export type SignalDb = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
/** A database handle or an open transaction; domain functions accept either. */
export type SignalTx = Parameters<Parameters<SignalDb["transaction"]>[0]>[0];
export type SignalQueryable = SignalDb | SignalTx;

/** Port of the local Neon HTTP/WebSocket proxy in docker-compose.yml. */
export const LOCAL_NEON_PROXY_PORT = 4444;

export const isLocalDatabaseHost = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || /(?:^|\.)localtest\.me$/u.test(host);

let localProxyConfigured = false;

/**
 * Routes local hosts (`db.localtest.me`, `localhost`) through the docker-compose Neon proxy
 * over plain HTTP/WS. Other hosts keep Neon's endpoints, so production is unchanged; the
 * insecure-WebSocket switch is only flipped in a process that opened a local URL.
 */
const configureLocalProxy = () => {
  if (localProxyConfigured) return;
  localProxyConfigured = true;
  neonConfig.fetchEndpoint = (host) =>
    isLocalDatabaseHost(host)
      ? `http://${host}:${LOCAL_NEON_PROXY_PORT}/sql`
      : `https://${host}/sql`;
  neonConfig.wsProxy = (host) =>
    isLocalDatabaseHost(host) ? `${host}:${LOCAL_NEON_PROXY_PORT}/v2` : `${host}/v2`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
};

/** Prepares `@neondatabase/serverless` for a URL (local proxy or Neon) before `neon()`/`Pool`. */
export const configureNeonFor = (databaseUrl: string) => {
  if (isLocalDatabaseHost(new URL(databaseUrl).hostname)) configureLocalProxy();
};

export const createSignalDb = (databaseUrl: string) => {
  configureNeonFor(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    close: () => pool.end(),
    db: drizzle({ client: pool, schema }) as unknown as SignalDb,
  };
};

const open = new Map<string, ReturnType<typeof createSignalDb>>();

/** One pooled client per connection string for the process lifetime. */
export const signalDbFor = (databaseUrl: string): SignalDb => {
  let entry = open.get(databaseUrl);
  if (!entry) {
    entry = createSignalDb(databaseUrl);
    open.set(databaseUrl, entry);
  }
  return entry.db;
};

export const closeSignalDbs = async () => {
  const entries = [...open.values()];
  open.clear();
  await Promise.all(entries.map((entry) => entry.close()));
};
