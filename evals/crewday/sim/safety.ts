import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Runner safety (spec 004 → Commands, Exposure): the simulation writes only to a test database,
 * in-process PGlite or local Docker Postgres (decision 0003). Every runner calls
 * `assertSimDatabase` before opening anything; it refuses any other URL, any Neon host, the
 * developer's own `DATABASE_URL` (from the environment, `.env`, `.env.development.local`, or
 * `.env.local`) even when that is local, and any database whose name does not contain "test"
 * (or equal `DATABASE_URL_TEST`'s).
 */

export type SimDatabaseTarget = { kind: "pglite" } | { kind: "url"; url: string };

export class UnsafeDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run the Crewday simulation: ${reason}`);
    this.name = "UnsafeDatabaseError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** All loopback spellings compare as one host. */
const hostKey = (host: string) => (LOCAL_HOSTS.has(host.toLowerCase()) ? "loopback" : host);

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** A variable as written in an env file, if the file names one. */
const envFileValue = (envFile: string, name: string) => {
  if (!existsSync(envFile)) return;
  return parseEnv(readFileSync(envFile, "utf-8"))[name]?.trim() || undefined;
};

const ENV_FILES = [".env", ".env.development.local", ".env.local"];

/** The database name of a connection string, if it parses. */
const databaseName = (value: string | undefined) => {
  if (!value || !URL.canParse(value)) return;
  return decodeURIComponent(new URL(value).pathname.slice(1));
};

/** Compares two connection strings by host, port, database, and user (ignores the password). */
const sameDatabase = (left: URL, right: string) => {
  try {
    const other = new URL(right);
    return (
      hostKey(left.hostname) === hostKey(other.hostname) &&
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
  {
    env = process.env,
    envFiles = ENV_FILES.map((file) => path.join(repoRoot, file)),
  }: { env?: Record<string, string | undefined>; envFiles?: string[] } = {},
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
  const devUrls = [env.DATABASE_URL, ...envFiles.map((file) => envFileValue(file, "DATABASE_URL"))];
  if (devUrls.some((devUrl) => devUrl && sameDatabase(url, devUrl)))
    throw new UnsafeDatabaseError(
      "the URL is the developer's DATABASE_URL; use a separate test database.",
    );
  const name = databaseName(target.url) ?? "";
  if (!name.toLowerCase().includes("test") && name !== databaseName(env.DATABASE_URL_TEST))
    throw new UnsafeDatabaseError(
      `database "${name}" is not a test database (its name must contain "test").`,
    );
  return target;
};
