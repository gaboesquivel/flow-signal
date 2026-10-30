// `pnpm db:migrate`: applies the versioned migrations in `drizzle/` to DATABASE_URL.
// The only schema change a deployment makes (scripts/vercel-build.mjs). Never destructive:
// if a pending migration drops, renames, retypes, or rewrites data, it stops without applying
// anything. Apply such a migration deliberately from a terminal with --allow-destructive
// (refused on Vercel and in CI). See docs/database.md → Migrations and seeds.
//   node --env-file=.env.local --import tsx scripts/db-migrate.ts [--dry-run] [--allow-destructive]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

import { destructiveStatements, pendingMigrations } from "@/lib/db/migration-safety";
import { configureNeonFor } from "@/lib/signal/db";

const folder = path.resolve(import.meta.dirname, "../drizzle");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const allowDestructive = args.has("--allow-destructive");
const log = (message: string) => console.log(`[db:migrate] ${message}`);
const fail = (message: string): never => {
  console.error(`[db:migrate] ${message}`);
  process.exit(1);
};

const databaseUrl = process.env.DATABASE_URL?.trim() || fail("DATABASE_URL is not set.");
if (allowDestructive && (process.env.VERCEL || process.env.VERCEL_ENV || process.env.CI))
  fail("--allow-destructive is refused on Vercel and in CI; run it from a terminal.");

const journal: { tag: string; when: number }[] = JSON.parse(
  readFileSync(path.join(folder, "meta/_journal.json"), "utf-8"),
).entries;
const sqlFor = (tag: string) => readFileSync(path.join(folder, `${tag}.sql`), "utf-8");
/** Drizzle's migrator records sha256(file contents) per migration. */
const hashFor = (tag: string) => createHash("sha256").update(sqlFor(tag)).digest("hex");

configureNeonFor(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl });
try {
  if (!dryRun) {
    await pool.query(`create schema if not exists drizzle`);
    await pool.query(
      `create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
    );
  }
  const lastApplied = async () => {
    const { rows: tracked } = await pool.query(
      `select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
    );
    if (!tracked[0]?.exists) return null;
    const { rows } = await pool.query(
      `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    );
    return rows[0] ? Number(rows[0].created_at) : null;
  };

  // Databases created with `drizzle-kit push` (before versioned migrations) already have the
  // baseline schema: record the baseline as applied instead of re-creating tables.
  let applied = await lastApplied();
  const [baseline] = journal;
  if (applied === null && baseline) {
    const { rows } = await pool.query(`select to_regclass('public.needs') is not null as exists`);
    if (rows[0]?.exists) {
      if (!dryRun)
        await pool.query(
          `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
          [hashFor(baseline.tag), baseline.when],
        );
      log(`${dryRun ? "would adopt" : "adopted"} the existing schema as ${baseline.tag}`);
      applied = baseline.when;
    }
  }

  const pending = pendingMigrations(journal, applied);
  if (pending.length === 0) log("up to date.");
  const blocked = pending.flatMap((entry) =>
    destructiveStatements(sqlFor(entry.tag)).map((found) => ({ ...found, tag: entry.tag })),
  );
  if (blocked.length > 0 && !allowDestructive) {
    for (const { kind, statement, tag } of blocked)
      console.error(`[db:migrate] ${tag}: ${kind}: ${statement.slice(0, 160)}`);
    fail(
      "Pending migrations contain destructive statements; nothing was applied. Use an expand/contract change, or apply it deliberately with --allow-destructive outside a deployment.",
    );
  }
  if (pending.length > 0) {
    log(`${dryRun ? "would apply" : "applying"}: ${pending.map((entry) => entry.tag).join(", ")}`);
    if (!dryRun) await migrate(drizzle({ client: pool }), { migrationsFolder: folder });
  }
} finally {
  await pool.end();
}
