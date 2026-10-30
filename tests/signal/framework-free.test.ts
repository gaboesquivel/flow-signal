import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../lib/signal");
/** The one bridge allowed to import Next.js; route handlers import it, Eve agents never do. */
const nextBridge = path.join(root, "next.ts");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/u.test(name) ? [full] : [];
  });

it("keeps lib/signal free of Next.js imports so the Eve agent bundles can load it", () => {
  const offenders = sourceFiles(root)
    .filter((file) => file !== nextBridge)
    .filter((file) =>
      /from\s+["']next[/"']|import\(\s*["']next[/"']/u.test(readFileSync(file, "utf-8")),
    )
    .map((file) => path.relative(root, file));
  expect(offenders).toEqual([]);
});
