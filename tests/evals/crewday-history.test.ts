import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  aggregateCells,
  appendHistory,
  changeOf,
  compareEntries,
  readHistory,
} from "@/evals/crewday/history";
import type { Estimate, HistoryEntry } from "@/evals/crewday/history";
import { offlineDeps, parseCrewdayArgs, runTagged } from "@/evals/crewday/run";
import { defaultPolicy } from "@/evals/crewday/sim";

// Offline (spec 004, task 06): tagged runs append one history entry; a metric is improved or
// regressed against the previous tagged run only when the intervals do not overlap.

const estimate = (value: number, lo: number, hi: number): Estimate => ({
  ci: [lo, hi],
  n: 3,
  value,
});

const entry = (tag: string, metrics: HistoryEntry["metrics"]): HistoryEntry => ({
  criteria: {},
  gitSha: { dirty: false, sha: `sha-${tag}` },
  metrics,
  mode: "live",
  models: { embedding: "e", fast: "f", oracleEmbedding: "o", reasoning: "r" },
  policy: defaultPolicy,
  ranAt: "2026-10-30T00:00:00.000Z",
  schema: "crewday-history@1",
  seeds: [1, 2, 3],
  spendUsd: 1,
  tag,
  world: { name: "test", version: "v1" },
});

const one = (signal: Estimate) => ({ board: null, lift: null, signal });

describe("--tag flag", () => {
  test("is rejected on the dev and fixture worlds and with a partial run", () => {
    expect(() => parseCrewdayArgs(["--tag", "x"])).toThrow(/test world only/u);
    expect(() => parseCrewdayArgs(["--world", "dev", "--tag", "x"])).toThrow(/test world only/u);
    expect(() => parseCrewdayArgs(["--world", "fixture", "--tag", "x"])).toThrow(/test world/u);
    expect(() => parseCrewdayArgs(["--world", "test", "--tag", "x", "--limit-weeks", "2"])).toThrow(
      /whole year/u,
    );
    expect(() => parseCrewdayArgs(["--world", "test", "--tag", "x", "--arm", "signal"])).toThrow(
      /both arms/u,
    );
    expect(parseCrewdayArgs(["--world", "test", "--tag", "v1-baseline"]).tag).toBe("v1-baseline");
  });
});

describe("the regression rule", () => {
  test("higher-is-better: improved and regressed only without overlap", () => {
    const before = estimate(0.5, 0.4, 0.6);
    expect(changeOf("true_prevention_rate", before, estimate(0.75, 0.65, 0.85))).toBe("improved");
    expect(changeOf("true_prevention_rate", before, estimate(0.25, 0.15, 0.35))).toBe("regressed");
    expect(changeOf("true_prevention_rate", before, estimate(0.65, 0.55, 0.75))).toBe(
      "no detectable change",
    );
    // Touching intervals overlap.
    expect(changeOf("true_prevention_rate", before, estimate(0.7, 0.6, 0.8))).toBe(
      "no detectable change",
    );
  });

  test("lower-is-better metrics flip the direction; world properties have none", () => {
    const before = estimate(0.1, 0.08, 0.12);
    expect(changeOf("false_attach_rate", before, estimate(0.02, 0.01, 0.03))).toBe("improved");
    expect(changeOf("false_attach_rate", before, estimate(0.3, 0.2, 0.4))).toBe("regressed");
    expect(changeOf("keyword_findable_share", before, estimate(0.3, 0.3, 0.3))).toBe("changed");
  });

  test("compares synthetic history entries metric by metric", () => {
    const previous = entry("a", {
      false_attach_rate: one(estimate(0.1, 0.08, 0.12)),
      revenue_coverage: one(estimate(0.5, 0.4, 0.6)),
      true_prevention_rate: one(estimate(0.5, 0.4, 0.6)),
    });
    const current = entry("b", {
      decision_quality: one(estimate(0.9, 0.85, 0.95)),
      false_attach_rate: one(estimate(0.3, 0.2, 0.4)),
      revenue_coverage: one(estimate(0.55, 0.45, 0.65)),
      true_prevention_rate: one(estimate(0.8, 0.7, 0.9)),
    });
    const { changes, previous: prev } = compareEntries(previous, current);
    expect(prev.tag).toBe("a");
    expect(Object.fromEntries(changes.map((c) => [c.key, c.change]))).toEqual({
      false_attach_rate: "regressed",
      revenue_coverage: "no detectable change",
      true_prevention_rate: "improved",
    });
  });

  test("repeats aggregate to the mean and the envelope of their intervals", () => {
    expect(
      aggregateCells([
        { ci: [0.4, 0.6], value: 0.5 },
        { ci: null, value: 0.7 },
        { ci: [0.3, 0.5], value: 0.4 },
        null,
        { ci: null, value: null },
      ]),
    ).toEqual({ ci: [0.3, 0.7], n: 3, value: (0.5 + 0.7 + 0.4) / 3 });
    expect(aggregateCells([null, { ci: null, value: null }])).toBeNull();
  });
});

describe("the history file", () => {
  test("appends one line per entry and never rewrites earlier ones", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "crewday-history-")), "h.jsonl");
    await writeFile(file, "");
    await appendHistory(entry("a", {}), file);
    const before = await readFile(file, "utf-8");
    await appendHistory(entry("b", {}), file);
    const after = await readFile(file, "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect((await readHistory(file)).map((e) => e.tag)).toEqual(["a", "b"]);
  });
});

const fixtureEntry = (tag: string, version: string) => ({
  ...entry(tag, { true_prevention_rate: one(estimate(0, 0, 0)) }),
  world: { name: "fixture", version },
});

describe("a tagged run [pglite]", () => {
  test("runs 3 seeds, appends exactly one entry, and compares with the previous one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crewday-tagged-"));
    const file = path.join(dir, "tagged-runs.jsonl");
    // Earlier history: the previous run on this world version, then one on another version.
    await appendHistory(fixtureEntry("earlier", "v1"), file);
    await appendHistory(fixtureEntry("other-version", "v0"), file);
    const before = await readFile(file, "utf-8");

    // The CLI only tags the test world; the module function runs the fixture offline.
    const options = {
      ...parseCrewdayArgs(["--world", "fixture", "--out", path.join(dir, "latest.json")]),
      tag: "offline",
    };
    const { comparison, entry: added } = await runTagged(options, offlineDeps(), file);

    expect(added.seeds).toEqual([1, 2, 3]);
    expect(added.metrics.true_prevention_rate?.signal?.n).toBe(3);
    expect(added.metrics.true_prevention_rate?.lift).not.toBeNull();
    expect(added.criteria.true_prevention_lift).toHaveLength(3);
    const history = await readHistory(file);
    expect(history.map((e) => e.tag)).toEqual(["earlier", "other-version", "offline"]);
    expect((await readFile(file, "utf-8")).startsWith(before)).toBe(true);
    expect(comparison?.previous.tag).toBe("earlier");
    expect(comparison?.changes.map((c) => `${c.key}.${c.series}`)).toEqual([
      "true_prevention_rate.signal",
    ]);
  }, 300_000);
});
