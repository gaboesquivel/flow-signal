import { describe, expect, it } from "vitest";

import {
  destructiveStatements,
  pendingMigrations,
  seedRefusal,
} from "../../lib/db/migration-safety";

describe("destructiveStatements", () => {
  it("allows additive DDL", () => {
    expect(
      destructiveStatements(`CREATE TABLE "a" ("id" uuid PRIMARY KEY);--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "b" text;--> statement-breakpoint
CREATE INDEX "a_b" ON "a" ("b");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TYPE "public"."status" ADD VALUE 'archived';`),
    ).toEqual([]);
  });

  it.each([
    ['DROP TABLE "needs" CASCADE;', "DROP TABLE"],
    ['ALTER TABLE "needs" DROP COLUMN "statement";', "DROP COLUMN"],
    [
      'ALTER TABLE "needs" ALTER COLUMN "statement" SET DATA TYPE varchar(10);',
      "column type change",
    ],
    ['ALTER TABLE "needs" RENAME COLUMN "statement" TO "text";', "RENAME"],
    ['ALTER TABLE "needs" RENAME TO "old_needs";', "RENAME"],
    ['DROP TYPE "public"."need_status";', "DROP TYPE"],
    ['DROP SCHEMA "public" CASCADE;', "DROP SCHEMA"],
    ["TRUNCATE TABLE needs;", "TRUNCATE"],
    ["DELETE FROM needs WHERE true;", "DELETE"],
    ["UPDATE needs SET statement = '';", "UPDATE"],
  ])("flags %s", (sql, kind) => {
    const found = destructiveStatements(sql);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(kind);
  });

  it("ignores keywords inside comments and string literals", () => {
    expect(
      destructiveStatements(`-- we never DROP TABLE here
COMMENT ON TABLE "needs" IS 'DELETE FROM needs is forbidden';`),
    ).toEqual([]);
  });
});

describe("pendingMigrations", () => {
  const journal = [
    { tag: "0000_baseline", when: 100 },
    { tag: "0001_add_x", when: 200 },
    { tag: "0002_add_y", when: 300 },
  ];

  it("returns every migration when none were applied", () => {
    expect(pendingMigrations(journal, null).map((m) => m.tag)).toEqual([
      "0000_baseline",
      "0001_add_x",
      "0002_add_y",
    ]);
  });

  it("returns migrations newer than the last applied one", () => {
    expect(pendingMigrations(journal, 200).map((m) => m.tag)).toEqual(["0002_add_y"]);
  });
});

describe("seedRefusal", () => {
  const base = { env: {}, hasData: false, replace: false, target: "DATABASE_URL" as const };

  it("refuses anywhere on Vercel or in CI", () => {
    expect(seedRefusal({ ...base, env: { VERCEL: "1" } })).toMatch(/Vercel/u);
    expect(seedRefusal({ ...base, env: { VERCEL_ENV: "production" } })).toMatch(/Vercel/u);
    expect(seedRefusal({ ...base, env: { CI: "true" } })).toMatch(/CI/u);
  });

  it("refuses to wipe a database that already has data unless --replace is passed", () => {
    expect(seedRefusal({ ...base, hasData: true })).toMatch(/--replace/u);
    expect(seedRefusal({ ...base, hasData: true, replace: true })).toBeNull();
  });

  it("allows an empty database and the local test database", () => {
    expect(seedRefusal(base)).toBeNull();
    expect(seedRefusal({ ...base, hasData: true, target: "DATABASE_URL_TEST" })).toBeNull();
  });
});
