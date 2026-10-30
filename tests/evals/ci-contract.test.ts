import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { refuseInCi } from "../../evals/ci-guard";

/**
 * Contract: live evals never run in CI (evals/ci-guard.ts). CI runs `pnpm qa` only; evals are
 * run locally, on demand. These tests fail if a workflow invokes an eval or an entry point drops
 * its guard.
 */
const root = path.resolve(import.meta.dirname, "../..");

/** Every live eval entry point (real model calls). Add new ones here and guard them. */
const liveEntryPoints = [
  "evals/agents/run.ts",
  "evals/crewday/generate/run.ts",
  "evals/crewday/run.ts",
  "evals/matching/run.ts",
  "lib/genui/scripts/eval-live.ts",
];

describe("live evals never run in CI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("no workflow invokes an eval script or entry point", async () => {
    const dir = path.join(root, ".github/workflows");
    const files = (await readdir(dir)).filter((file) => /\.ya?ml$/u.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = (await readFile(path.join(dir, file), "utf-8"))
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect(text, file).not.toMatch(/pnpm\s+(?:run\s+)?(?:eval|crewday:generate)|evals\//u);
    }
  });

  it("every live eval entry point refuses to run in CI", async () => {
    for (const file of liveEntryPoints) {
      const text = await readFile(path.join(root, file), "utf-8");
      expect(text, file).toMatch(/refuseInCi\("[^"]+"\)/u);
    }
  });

  it("every package script that runs a live entry point is a known eval", async () => {
    const { scripts } = JSON.parse(await readFile(path.join(root, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(scripts)) {
      for (const file of liveEntryPoints) {
        if (command.includes(file)) expect(name, command).toMatch(/^(?:eval|crewday:generate)/u);
      }
    }
  });

  it("refuseInCi exits when CI is set and does nothing otherwise", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => null) as never);
    vi.spyOn(console, "error").mockImplementation(() => null);
    vi.stubEnv("CI", "");
    refuseInCi("test");
    expect(exit).not.toHaveBeenCalled();
    vi.stubEnv("CI", "true");
    refuseInCi("test");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
