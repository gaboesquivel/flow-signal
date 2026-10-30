import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { REPORT_CRITERIA, REPORT_METRIC_KEYS } from "@/evals/crewday/report";
import { offlineDeps, parseCrewdayArgs, runCrewday } from "@/evals/crewday/run";
import { scoreRun } from "@/evals/crewday/score";
import { defaultPolicy } from "@/evals/crewday/sim";
import type { RunResult } from "@/evals/crewday/sim";
import { loadWorld } from "@/evals/crewday/world";

// Offline (spec 004, task 04): the `pnpm eval:crewday` runner on the fixture world with fake AI
// ports on PGlite, called as a module function; plus the scorer's split-trap rule.

describe("pnpm eval:crewday runner [pglite]", () => {
  test("parses flags with the spec's defaults", () => {
    expect(parseCrewdayArgs([])).toMatchObject({
      arm: "both",
      db: { kind: "pglite" },
      limitWeeks: null,
      out: "evals/crewday/results/latest.json",
      seed: 1,
      world: "dev",
    });
    expect(() => parseCrewdayArgs(["--world", "prod"])).toThrow(/--world/u);
    expect(() => parseCrewdayArgs(["--arm", "x"])).toThrow(/--arm/u);
  });

  test("reports every metric and criterion for both arms", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crewday-run-"));
    const out = path.join(dir, "report.json");
    const report = await runCrewday(
      { ...parseCrewdayArgs(["--world", "fixture", "--out", out]) },
      offlineDeps(),
    );
    const keys = report.table.map((row) => row.key);
    for (const key of REPORT_METRIC_KEYS) expect(keys).toContain(key);
    const judged = report.table.flatMap((row) => (row.criterion ? [row.criterion.name] : []));
    expect(judged.toSorted()).toEqual(report.comparison?.criteria.map((c) => c.name).toSorted());
    expect(judged.toSorted()).toEqual([...REPORT_CRITERIA].toSorted());
    expect(
      report.table.find((row) => row.key === "true_prevention_rate")?.signal?.ci,
    ).not.toBeNull();
    expect(report.pii.planted.map((p) => p.worldSignalId)).toEqual(["fx-s15"]);
    expect(report.pii.ok).toBe(true);
    expect(report.notMeasured.map((m) => m.metric)).toEqual([
      "context_rate",
      "submitter_willingness",
    ]);
    expect(report.world.keywordFindableShare.source).toBe("runner estimate");
    const written = JSON.parse(await readFile(out, "utf-8")) as { table: unknown[] };
    expect(written.table).toHaveLength(report.table.length);
  }, 180_000);
});

/** A minimal run: one decision on need n1 (a split parent), with the given signals on it. */
const run = (signalIds: string[], status: "planned" | "declined"): RunResult =>
  ({
    aiCalls: [],
    arm: "signal",
    end: "2027-01-01T00:00:00.000Z",
    log: {
      actions: [],
      decisions: [],
      invalid: [],
      previewLatencyMs: [],
      submissions: [],
      verdicts: [],
    },
    modelSpendUsd: null,
    policy: defaultPolicy,
    seed: 1,
    snapshot: {
      decisions: [{ needId: "n1", publishedAt: "2026-10-01T00:00:00.000Z", status }],
      events: [],
      identity: { n1: "fx-site-clock-in" },
      merges: [],
      metrics: [],
      mySignalsDecided: {},
      needs: [],
      priority: {},
      signals: signalIds.map((worldSignalId, i) => ({
        actorKind: "human",
        attachedTo: "existing",
        createdAt: "2026-06-01T00:00:00.000Z",
        id: `s${i}`,
        needId: "n1",
        originalNeedId: "n1",
        worldSignalId,
      })),
      suggestions: [],
    },
    start: "2026-01-01T00:00:00.000Z",
    surfaceMix: { operator_mcp: 0, public_mcp: 0, rest: 0 },
    weeks: 52,
    world: { name: "fixture", version: "v1" },
  }) as RunResult;

describe("crewday scorer: split traps", () => {
  test("a decision on a split parent is scored as the child its signals moved to", async () => {
    const world = await loadWorld("fixture", "v1");
    // fx-site-clock-in (planned) split into fx-clock-in-proof (planned) and -offline (declined).
    const quality = (r: RunResult) => scoreRun(world, r).headline.decisionQuality;

    const offline = quality(run(["fx-s25", "fx-s31", "fx-s08"], "declined"));
    expect(offline.value).toBe(1);
    expect(Object.keys(offline.perNeed ?? {})).toEqual(["fx-clock-in-offline"]);

    const parent = quality(run(["fx-s08", "fx-s17", "fx-s25"], "declined"));
    expect(parent.value).toBe(0);
    expect(Object.keys(parent.perNeed ?? {})).toEqual(["fx-site-clock-in"]);

    // No signals left on the parent: excluded, the children are scored on their own needs.
    expect(quality(run([], "planned")).value).toBeNull();
  });
});
