import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Runner safety (spec 004 → Commands, Exposure): the simulation writes only to a test database,
 * in-process PGlite or local Docker Postgres (decision 0003). Every runner calls
 * `assertSimDatabase` before opening anything; it refuses any other URL, any Neon host, and the
 * `DATABASE_URL` from `.env.local` (the developer's own database) even when that is local.
 */

export type SimDatabaseTarget = { kind: "pglite" } | { kind: "url"; url: string };

export class UnsafeDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run the Crewday simulation: ${reason}`);
    this.name = "UnsafeDatabaseError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** `DATABASE_URL` as written in `.env.local`, if the file names one. */
const envLocalDatabaseUrl = (envFile: string) => {
  if (!existsSync(envFile)) return;
  return parseEnv(readFileSync(envFile, "utf-8")).DATABASE_URL?.trim() || undefined;
};

/** Compares two connection strings by host, port, database, and user (ignores the password). */
const sameDatabase = (left: URL, right: string) => {
  try {
    const other = new URL(right);
    return (
      left.hostname === other.hostname &&
      (left.port || "5432") === (other.port || "5432") &&
      left.pathname === other.pathname &&
      left.username === other.username
    );
  } catch {
    return false;
  }
};

/** Throws `UnsafeDatabaseError` unless the target is PGlite or a local Docker test database. */
export const assertSimDatabase = (
  target: SimDatabaseTarget,
  { envFile = path.join(repoRoot, ".env.local") }: { envFile?: string } = {},
) => {
  if (target.kind === "pglite") return target;
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new UnsafeDatabaseError("the database URL does not parse.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new UnsafeDatabaseError(`${url.protocol} is not a Postgres URL.`);
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".neon.tech") || host.endsWith(".neon.build"))
    throw new UnsafeDatabaseError(`${host} is a Neon database; use PGlite or local Docker.`);
  if (!LOCAL_HOSTS.has(host))
    throw new UnsafeDatabaseError(
      `${host} is not local Docker (localhost or 127.0.0.1); use PGlite or local Docker.`,
    );
  const devUrl = envLocalDatabaseUrl(envFile);
  if (devUrl && sameDatabase(url, devUrl))
    throw new UnsafeDatabaseError(
      "the URL is DATABASE_URL from .env.local; use a separate test database.",
    );
  return target;
};
