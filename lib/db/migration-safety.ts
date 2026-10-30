/**
 * Rules that keep deployments from destroying data (docs/database.md → Migrations and seeds).
 * Deploys apply only versioned migrations from `drizzle/`, and only when none of the pending
 * ones contains a destructive statement; seeds never run on Vercel or in CI and never wipe a
 * database that already has data unless asked to.
 */

interface DestructiveStatement {
  kind: string;
  statement: string;
}

const destructivePatterns: { kind: string; pattern: RegExp }[] = [
  { kind: "DROP TABLE", pattern: /\bdrop\s+table\b/iu },
  { kind: "DROP COLUMN", pattern: /\bdrop\s+column\b/iu },
  { kind: "DROP TYPE", pattern: /\bdrop\s+type\b/iu },
  { kind: "DROP SCHEMA", pattern: /\bdrop\s+schema\b/iu },
  { kind: "DROP VIEW", pattern: /\bdrop\s+(?:materialized\s+)?view\b/iu },
  { kind: "DROP EXTENSION", pattern: /\bdrop\s+extension\b/iu },
  {
    kind: "column type change",
    pattern: /\balter\s+column\s+\S+\s+(?:set\s+data\s+)?type\b/iu,
  },
  { kind: "RENAME", pattern: /\brename\b/iu },
  { kind: "TRUNCATE", pattern: /\btruncate\b/iu },
  { kind: "DELETE", pattern: /\bdelete\s+from\b/iu },
  { kind: "UPDATE", pattern: /^\s*update\s+\S+\s+set\b/iu },
];

/** Removes comments and string literals so keywords inside them don't count. */
const stripCommentsAndStrings = (sql: string) =>
  sql
    .replaceAll(/--[^\n]*/gu, " ")
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/'(?:[^']|'')*'/gu, "''");

/** The statements in a migration that can lose data or break running code. */
export const destructiveStatements = (sql: string): DestructiveStatement[] =>
  stripCommentsAndStrings(sql)
    .split(/;|--> statement-breakpoint/u)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .flatMap((statement) => {
      const match = destructivePatterns.find(({ pattern }) => pattern.test(statement));
      return match ? [{ kind: match.kind, statement }] : [];
    });

interface JournalEntry {
  tag: string;
  when: number;
}

/** Same rule as Drizzle's migrator: anything newer than the last applied migration is pending. */
export const pendingMigrations = <T extends JournalEntry>(
  journal: T[],
  lastAppliedAt: number | null,
): T[] => journal.filter((entry) => lastAppliedAt === null || entry.when > lastAppliedAt);

interface SeedContext {
  env: Record<string, string | undefined>;
  hasData: boolean;
  replace: boolean;
  target: "DATABASE_URL" | "DATABASE_URL_TEST";
}

/** Why the demo seed (which truncates every Signal table) must not run here, or null. */
export const seedRefusal = ({ env, hasData, replace, target }: SeedContext): string | null => {
  if (env.VERCEL || env.VERCEL_ENV)
    return "Refusing to seed on Vercel: seeds never run as part of a deployment.";
  if (env.CI) return "Refusing to seed in CI.";
  if (target === "DATABASE_URL" && hasData && !replace)
    return "The database already has Signal data; seeding would delete it. Pass --replace if you mean it.";
  return null;
};
