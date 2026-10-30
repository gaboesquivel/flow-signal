import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import { destructiveStatements } from "../../lib/db/migration-safety";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf-8");
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;

it("deploys only run the guarded migration runner: no push, no force, no seed", () => {
  const vercel = JSON.parse(read("vercel.json"));
  expect(vercel.buildCommand).toBe("node scripts/vercel-build.mjs");
  const build = read("scripts/vercel-build.mjs");
  const commands = [...build.matchAll(/run\("(?<cmd>[^"]+)"\)/gu)].map((m) => m.groups?.cmd);
  expect(commands).toEqual(["pnpm db:migrate", "pnpm build"]);
  expect(scripts["db:migrate"]).toBe("node --import tsx scripts/db-migrate.ts");
  for (const name of ["build", "db:migrate", "postinstall", "prebuild", "postbuild"]) {
    const script = scripts[name] ?? "";
    expect(script, name).not.toMatch(
      /drizzle-kit\s+push|--force|db:seed|db-seed|--allow-destructive/u,
    );
  }
});

it("keeps every committed migration non-destructive", () => {
  const journal: { entries: { tag: string }[] } = JSON.parse(read("drizzle/meta/_journal.json"));
  for (const { tag } of journal.entries)
    expect(destructiveStatements(read(`drizzle/${tag}.sql`)), tag).toEqual([]);
});
