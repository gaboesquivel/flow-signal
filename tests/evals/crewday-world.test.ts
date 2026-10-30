import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { checkRecipePair } from "@/evals/crewday/checks";
import type { Recipe, World } from "@/evals/crewday/format";
import { signalKinds, trapKinds } from "@/evals/crewday/format";
import { HELD_OUT } from "@/evals/crewday/held-out";
import {
  crewdayRoot,
  loadRecipe,
  loadWorld,
  parseRecipe,
  parseWorld,
  WorldFormatError,
} from "@/evals/crewday/world";

// Offline: the Crewday world format (spec 004, task 01). The fixture world loads clean and covers
// every label kind and planted case; each consistency rule rejects a crafted bad world; and no
// tuning code under evals/crewday can reach the held-out test world.

const fixture = await loadWorld("fixture", "v1");

/** The problems `parseWorld` reports after `mutate` edits a copy of the fixture. */
const problemsAfter = (mutate: (world: World) => void): string[] => {
  const world = structuredClone(fixture);
  mutate(world);
  try {
    parseWorld(world);
  } catch (error) {
    if (error instanceof WorldFormatError) return error.problems;
    throw error;
  }
  return [];
};

const signal = (world: World, id: string) => {
  const found = world.signals.find((s) => s.id === id);
  if (!found) throw new Error(`fixture has no signal ${id}`);
  return found;
};

describe("crewday fixture world", () => {
  test("loads clean", () => {
    expect(fixture.signals.length).toBeGreaterThanOrEqual(45);
    expect(fixture.needs.length).toBeGreaterThanOrEqual(10);
    expect(fixture.personas.length).toBeGreaterThanOrEqual(15);
    expect(fixture.themes.length).toBeGreaterThanOrEqual(2);
  });

  test("covers every label kind, trap kind, and planted case", () => {
    const kinds = new Set(fixture.signals.map((s) => s.labels.kind));
    expect([...kinds].toSorted()).toEqual([...signalKinds].toSorted());
    const traps = new Set(fixture.needs.map((need) => need.trap?.kind).filter(Boolean));
    expect([...traps].toSorted()).toEqual([...trapKinds].toSorted());
    const planted = new Set(fixture.signals.map((s) => s.planted).filter(Boolean));
    expect([...planted].toSorted()).toEqual(["invalid", "pii", "retry"]);
    const backlogNeeds = fixture.backlog.map((row) => row.trueNeedKey);
    expect(new Set(backlogNeeds).size).toBeLessThan(backlogNeeds.length);
    expect(fixture.personas.some((p) => p.actorKind === "agent")).toBe(true);
    expect(fixture.signals.some((s) => s.labels.existedAtTime === false)).toBe(true);
  });

  test("spreads signals across all 12 months", () => {
    const months = new Set(fixture.signals.map((s) => new Date(s.at).getUTCMonth()));
    expect(months.size).toBe(12);
  });
});

describe("crewday world consistency", () => {
  const rejects: [rule: string, mutate: (world: World) => void, problem: RegExp][] = [
    [
      "a signal labeled with an unknown need",
      (w) => (signal(w, "fx-s01").labels.needKeys = ["no-such-need"]),
      /fx-s01.*unknown need "no-such-need"/u,
    ],
    [
      "a signal from an unknown account",
      (w) => (signal(w, "fx-s02").accountKey = "nowhere"),
      /fx-s02.*unknown account/u,
    ],
    [
      "a signal from an unknown persona",
      (w) => (signal(w, "fx-s02").personaKey = "nobody"),
      /fx-s02.*unknown persona/u,
    ],
    [
      "a channel that differs from its persona's",
      (w) => (signal(w, "fx-s01").channel = "mcp"),
      /fx-s01.*channel mcp differs/u,
    ],
    [
      "a need in an unknown theme",
      (w) => (w.needs[0]!.themeKey = "space-travel"),
      /unknown theme "space-travel"/u,
    ],
    [
      "a need requested by an unknown account",
      (w) => w.needs[0]!.requesterAccounts.push("ghost-co"),
      /unknown requester account "ghost-co"/u,
    ],
    [
      "a repeated truePriority",
      (w) => (w.needs[1]!.truePriority = w.needs[0]!.truePriority),
      /truePriority 1 is used by more than one need/u,
    ],
    [
      "splitInto on a need that is not a split trap",
      (w) => (w.needs.find((n) => n.key === "fx-availability")!.splitInto = ["fx-shift-swap"]),
      /fx-availability.*splitInto is only allowed on a "split" trap/u,
    ],
    [
      "a split trap with no parent",
      (w) => delete w.needs.find((n) => n.key === "fx-site-clock-in")!.splitInto,
      /trap group "fx-clock-in".*exactly one need with splitInto/u,
    ],
    [
      "a shared-solution trap whose needs share no solution",
      (w) => (w.needs.find((n) => n.key === "fx-union-audit-records")!.solutions = ["Audit log"]),
      /fx-union-audit-records" shares no solution/u,
    ],
    [
      "a backlog row for a need not in the backlog",
      (w) => (w.backlog[0]!.trueNeedKey = "fx-availability"),
      /fx-bl-1.*not marked inBacklog/u,
    ],
    [
      "signals out of time order",
      (w) => (signal(w, "fx-s05").at = "2026-01-01T00:00:00Z"),
      /fx-s05": out of order/u,
    ],
    [
      "a signal outside the world's 12 months",
      (w) => {
        const last = w.signals.at(-1)!;
        last.at = "2027-01-02T00:00:00Z";
      },
      /fx-s50": .*outside the world's 12 months/u,
    ],
    [
      "a retry whose body differs from its original",
      (w) => (signal(w, "fx-s10").body = "Something else entirely."),
      /fx-s10": a retry repeats its original's persona, title, and body/u,
    ],
    [
      "a retry of a later signal",
      (w) => (signal(w, "fx-s10").retryOf = "fx-s20"),
      /fx-s10": retryOf "fx-s20" is not an earlier signal/u,
    ],
    [
      "firstOccurrence that disagrees with the order",
      (w) => (signal(w, "fx-s05").labels.firstOccurrence = true),
      /fx-s05": firstOccurrence should be false/u,
    ],
    [
      "existedAtTime that disagrees with the order",
      (w) => (signal(w, "fx-s04").labels.existedAtTime = true),
      /fx-s04": existedAtTime should be false/u,
    ],
    [
      "a multi_ask with one need",
      (w) => (signal(w, "fx-s09").labels.needKeys = ["fx-shift-swap"]),
      /fx-s09": multi_ask signals have exactly two needKeys/u,
    ],
    [
      "a planted invalid signal that submit_signal would accept",
      (w) => (signal(w, "fx-s16").body = "A real body."),
      /fx-s16": planted invalid but submit_signal validation accepts it/u,
    ],
    [
      "an unplanted signal that submit_signal would reject",
      (w) => (signal(w, "fx-s01").title = ""),
      /fx-s01": submit_signal validation rejects it/u,
    ],
    [
      "planted pii that is not in the text",
      (w) => signal(w, "fx-s15").pii!.push("Jane Doe"),
      /fx-s15": pii "Jane Doe" is not in its title or body/u,
    ],
    [
      "a label kind the format does not know",
      (w) => ((signal(w, "fx-s01").labels as { kind: string }).kind = "rumour"),
      /signals\.json\[0\]\[labels\]\[kind\]/u,
    ],
  ];

  test.each(rejects)("rejects %s", (_rule, mutate, problem) => {
    expect(problemsAfter(mutate).join("\n")).toMatch(problem);
  });

  test("lists every problem, not just the first", () => {
    const problems = problemsAfter((w) => {
      signal(w, "fx-s01").labels.needKeys = ["no-such-need"];
      w.needs[0]!.themeKey = "space-travel";
    });
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(() => parseWorld(structuredClone({ ...fixture, needs: [] }))).toThrow(
      /world is invalid \(\d+ problems\):\n- /u,
    );
  });
});

describe("crewday recipes", () => {
  const recipeFrom = (world: RecipeWorld, name: Recipe["world"]) =>
    parseRecipe(
      {
        accounts: world.accounts,
        backlog: world.backlog,
        company: "Crewday makes shift scheduling software.",
        needs: world.needs,
        personaMix: {
          count: 15,
          roles: [
            { channel: "web", role: "Frontline staff", share: 0.6, writingStyle: "short" },
            { channel: "mcp", role: "Support copilot", share: 0.4, writingStyle: "formal" },
          ],
        },
        strategy: "Scheduling first.",
        themes: world.themes,
      },
      name,
    );
  type RecipeWorld = Pick<World, "accounts" | "backlog" | "needs" | "themes">;

  test("a recipe built from the fixture's need set is consistent", () => {
    expect(recipeFrom(fixture, "dev").needs).toHaveLength(fixture.needs.length);
  });

  test("rejects persona shares that do not sum to 1", () => {
    expect(() =>
      parseRecipe(
        {
          accounts: [],
          backlog: [],
          company: "c",
          needs: [],
          personaMix: {
            count: 1,
            roles: [{ channel: "web", role: "r", share: 0.5, writingStyle: "w" }],
          },
          strategy: "s",
          themes: [],
        },
        "dev",
      ),
    ).toThrow(/role shares sum to 0.5, not 1/u);
  });

  test("rejects a trap group, need, or account in both the dev and test recipes", () => {
    const dev = recipeFrom(fixture, "dev");
    const other = structuredClone(dev);
    other.world = "test";
    expect(checkRecipePair(dev, other).join("\n")).toMatch(
      /trap group "fx-coverage" is in both[\s\S]*need "fx-shift-swap" is in both[\s\S]*account "fx-harbor" is in both/u,
    );
    const renamed = structuredClone(other);
    for (const need of renamed.needs) {
      need.key = `t-${need.key}`;
      if (need.trap) need.trap.group = `t-${need.trap.group}`;
    }
    for (const account of renamed.accounts) account.key = `t-${account.key}`;
    expect(checkRecipePair(dev, renamed)).toEqual([]);
  });
});

describe("crewday held-out test world", () => {
  test("cannot be loaded without the held-out capability", async () => {
    await expect(loadWorld("test", "v1")).rejects.toThrow(/held out/u);
    await expect(loadRecipe("test")).rejects.toThrow(/held out/u);
    // A forged token does not open it either.
    const forged = Symbol("crewday held-out test world") as never;
    await expect(loadWorld("test", "v1", { heldOut: forged })).rejects.toThrow(/held out/u);
  });

  test("opens with the capability (and then fails only on what is on disk)", async () => {
    await expect(loadWorld("test", "does-not-exist", { heldOut: HELD_OUT })).rejects.toThrow(
      WorldFormatError,
    );
  });

  /**
   * Files under evals/, scripts/, and tests/ allowed to name the test world or the held-out token.
   * Keep it small:
   * - held-out.ts defines the token.
   * - world.ts is the loader that checks it (and `checkRecipes`, which loads both recipes).
   * - generate/run.ts reads the test recipe and writes the frozen test world (task 02).
   * - run.ts is the `pnpm eval:crewday` entry point; `--world test` is the acceptance run
   *   (spec 004 → Acceptance scenario).
   * - tests/evals/crewday-worlds.test.ts checks the frozen worlds' sizes and labels (task 02).
   * - this guard test, which exercises the lock.
   */
  const guardTest = "tests/evals/crewday-world.test.ts";
  const allowlist = new Set([
    "evals/crewday/generate/run.ts",
    "evals/crewday/held-out.ts",
    "evals/crewday/run.ts",
    "evals/crewday/world.ts",
    "tests/evals/crewday-worlds.test.ts",
    guardTest,
  ]);
  const forbidden = [
    /worlds[\\/]test/u,
    /recipe[\\/]test/u,
    /["'`]worlds["'`]\s*,\s*["'`]test["'`]/u,
    /(?:loadWorld|loadRecipe|worldDir)\(\s*["'`]test["'`]/u,
    /parseWorld\([^)]*test/u,
    /HELD_OUT/u,
    /held-out/u,
  ];
  const repoRoot = path.resolve(crewdayRoot, "..", "..");

  test("the guard's patterns catch the obvious ways in", () => {
    for (const sample of [
      'readFile("evals/crewday/worlds/test/v1/signals.json")',
      'path.join(root, "worlds", "test", "v1")',
      'await loadWorld("test", "v1")',
      'worldDir("test", "v1")',
      'parseWorld(await readJson("worlds/test/v1"))',
      'import { HELD_OUT } from "./held-out";',
    ]) {
      expect(forbidden.some((pattern) => pattern.test(sample))).toBe(true);
    }
  });

  test("no tuning code under evals/, scripts/, or tests/ references the test world or the token", async () => {
    const files = (
      await Promise.all(
        ["evals", "scripts", "tests"].map(async (dir) =>
          (await readdir(path.join(repoRoot, dir), { recursive: true })).map((file) =>
            path.posix.join(dir, file.split(path.sep).join("/")),
          ),
        ),
      )
    )
      .flat()
      .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/u.test(file));
    for (const file of allowlist) expect(files).toContain(file);
    const offenders: string[] = [];
    for (const file of files.filter((f) => !allowlist.has(f))) {
      const source = await readFile(path.join(repoRoot, file), "utf-8");
      const hits = forbidden.filter((pattern) => pattern.test(source));
      if (hits.length) offenders.push(`${file}: ${hits.map(String).join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
