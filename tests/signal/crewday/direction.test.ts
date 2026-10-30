import { beforeAll, describe, expect, test } from "vitest";

import { parseCrewdayArgs } from "@/evals/crewday/run";
import { compareArms, scoreRun } from "@/evals/crewday/score";
import {
  createOfflineSignalAi,
  defaultPolicy,
  runArm,
  strategyBriefHandler,
} from "@/evals/crewday/sim";
import type { RunResult } from "@/evals/crewday/sim";
import type { DecisionRecord } from "@/evals/crewday/sim/state";
import { focusThemeNames, strategyInputFor } from "@/evals/crewday/sim/strategy";
import { loadWorld } from "@/evals/crewday/world";
import type { World } from "@/evals/crewday/format";
import { findOperation } from "@/lib/signal/operations/registry";

// Offline (spec 007 → Testing Decisions → Crewday): the `follows_signal` PM policy on the fixture
// world with fake AI ports on PGlite, and the direction-accuracy and readiness-lead-time scorer.
//
// The `follows_signal` runs call `set_strategy` and `list_ready_needs`, which spec 007's operations
// slice adds to the registry. Until it is merged those runs throw "Unknown operation set_strategy"
// and the tests in "follows_signal runs" fail; every other test here runs today.

const SEED = 7;
/** Per-run random ids: UUIDs and `preview_signal`'s `previewId` (spec 012). */
const uuid = /pv_[\w-]{22}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

const normalizeIds = (value: unknown) => {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value).replaceAll(uuid, (id) => {
      if (!ids.has(id)) ids.set(id, `<id:${ids.size}>`);
      return ids.get(id) ?? id;
    }),
  ) as unknown;
};

/** The policies' own log, without tracking tokens and preview latency (random per run). */
const policyLog = ({ log }: RunResult) => ({
  actions: log.actions,
  decisions: log.decisions,
  strategy: log.strategy,
  verdicts: log.verdicts,
});

let world: World;

/** A score without wall-clock latency. */
const comparable = (run: RunResult) => {
  const score = scoreRun(world, run);
  return { ...score, diagnostics: { ...score.diagnostics, previewLatencyMs: null } };
};

beforeAll(async () => {
  world = await loadWorld("fixture", "v1");
});

describe("follows_signal policy and flags", () => {
  test("defaults keep spec 004's oracle PM; flags set the policy and override rate", () => {
    expect(defaultPolicy).toMatchObject({ pPmOverride: 0.2, pmPolicy: "oracle" });
    expect(parseCrewdayArgs([])).toMatchObject({ pPmOverride: 0.2, pmPolicy: "oracle" });
    expect(parseCrewdayArgs(["--pm-policy", "follows_signal", "--pm-override", "0"])).toMatchObject(
      { pPmOverride: 0, pmPolicy: "follows_signal" },
    );
    expect(() => parseCrewdayArgs(["--pm-policy", "x"])).toThrow(/--pm-policy/u);
    expect(() => parseCrewdayArgs(["--pm-override", "2"])).toThrow(/--pm-override/u);
  });

  test("the strategy maps the memo's focus themes to Signal's theme ids and the policy's line", () => {
    expect(focusThemeNames(world)).toEqual(["Scheduling"]);
    const input = strategyInputFor(
      world,
      new Map([
        ["Scheduling", "00000000-0000-4000-8000-000000000001"],
        ["Time and attendance", "00000000-0000-4000-8000-000000000002"],
      ]),
      { ...defaultPolicy, readinessArrCents: 12_345 },
    );
    expect(input).toMatchObject({
      capacityPerQuarter: 12,
      focusThemeIds: ["00000000-0000-4000-8000-000000000001"],
      readinessArrCents: 12_345,
      readinessSupporters: 0,
    });
  });

  test("the board arm ignores follows_signal and runs the oracle PM", async () => {
    const run = await runArm({
      arm: "board",
      db: { kind: "pglite" },
      policy: { pmPolicy: "follows_signal" },
      seed: SEED,
      world,
    });
    expect(run.policy.pmPolicy).toBe("oracle");
    expect(run.log.strategy).toBeUndefined();
    expect(run.log.actions.some((action) => action.what === "list_ready_needs")).toBe(false);
    expect(run.log.decisions.every((decision) => decision.recommendedStatus === null)).toBe(true);
    expect(scoreRun(world, run).headline.directionAccuracy.value).toBeNull();
  }, 60_000);
});

/** A run with one logged decision per entry, on needs n0, n1, … (identity = the given key). */
const scoredRun = (
  entries: { key: string; leadDays: number; recommended: DecisionRecord["recommendedStatus"] }[],
): RunResult =>
  ({
    aiCalls: [],
    arm: "signal",
    end: "2027-01-01T00:00:00.000Z",
    log: {
      actions: [],
      decisions: entries.map((entry, i) => ({
        at: new Date(
          Date.parse("2026-06-01T00:00:00Z") + entry.leadDays * 86_400_000,
        ).toISOString(),
        needId: `n${i}`,
        needKey: entry.key,
        readyAt: "2026-06-01T00:00:00.000Z",
        recommendedStatus: entry.recommended,
        status: "planned",
        via: "brief",
      })),
      invalid: [],
      previewLatencyMs: [],
      submissions: [],
      verdicts: [],
    },
    modelSpendUsd: null,
    policy: defaultPolicy,
    seed: 1,
    snapshot: {
      decisions: [],
      events: [],
      identity: Object.fromEntries(entries.map((entry, i) => [`n${i}`, entry.key])),
      merges: [],
      metrics: [],
      mySignalsDecided: {},
      needs: [],
      priority: {},
      signals: [],
      suggestions: [],
    },
    start: "2026-01-01T00:00:00.000Z",
    surfaceMix: { operator_mcp: 0, public_mcp: 0, rest: 0 },
    weeks: 52,
    world: { name: "fixture", version: "v1" },
  }) as RunResult;

describe("crewday scorer: direction accuracy and readiness lead time", () => {
  test("compares recommendations with the strategy, skipping decisions without one", () => {
    const planned = world.needs.find((need) => need.strategyDecision.status === "planned");
    const declined = world.needs.find((need) => need.strategyDecision.status === "declined");
    if (!planned || !declined) throw new Error("fixture needs a planned and a declined need");
    const score = scoreRun(
      world,
      scoredRun([
        { key: planned.key, leadDays: 0, recommended: "in_progress" },
        { key: declined.key, leadDays: 4, recommended: "planned" },
        { key: declined.key, leadDays: 8, recommended: "declined" },
        { key: planned.key, leadDays: 20, recommended: null },
      ]),
    );
    expect(score.headline.directionAccuracy.decisions).toBe(3);
    expect(score.headline.directionAccuracy.value).toBeCloseTo(2 / 3);
    expect(score.headline.directionAccuracy.ci).not.toBeNull();
    expect(score.headline.readinessLeadTime.decisions).toBe(4);
    expect(score.headline.readinessLeadTime.value).toBeCloseTo(8);
    expect(score.headline.readinessLeadTime.medianDays).toBe(4);

    const board = scoreRun(world, { ...scoredRun([]), arm: "board" });
    expect(board.headline.directionAccuracy.value).toBeNull();
    const comparison = compareArms(score, board);
    expect(comparison.lift.directionAccuracy.value).toBeNull();
    expect(comparison.lift.readinessLeadTimeDays.value).toBeNull();
  });
});

const hasDirectionOperations = () =>
  Boolean(findOperation("set_strategy") && findOperation("list_ready_needs"));

describe("follows_signal runs [pglite] (need set_strategy and list_ready_needs)", () => {
  const runs: Record<string, RunResult> = {};
  const follows = (name: string, brief: "strategy" | "opposite" | "offline", pPmOverride: number) =>
    runArm({
      ai: createOfflineSignalAi(
        brief === "offline" ? {} : { decisionBrief: strategyBriefHandler(world, brief) },
      ),
      arm: "signal",
      db: { kind: "pglite" },
      policy: { pPmOverride, pmPolicy: "follows_signal" },
      seed: SEED,
      world,
    }).then((run) => {
      runs[name] = run;
      return run;
    });
  const get = (name: string) => {
    const run = runs[name];
    if (!run) throw new Error(`run ${name} did not complete`);
    return run;
  };

  beforeAll(async () => {
    if (!hasDirectionOperations()) return;
    await follows("offline", "offline", 0.2);
    await follows("offlineAgain", "offline", 0.2);
    await follows("right", "strategy", 0);
    await follows("wrong", "opposite", 0);
    await follows("wrongHalf", "opposite", 0.5);
    runs.oracle = await runArm({
      arm: "signal",
      db: { kind: "pglite" },
      policy: { pPmError: 0 },
      seed: SEED,
      world,
    });
  }, 300_000);

  test("the operations are registered (spec 007 operations slice)", () => {
    expect(hasDirectionOperations()).toBe(true);
  });

  test("a follows_signal run is deterministic for a seed", () => {
    const first = get("offline");
    const second = get("offlineAgain");
    expect(first.log.strategy).toMatchObject({
      readinessArrCents: defaultPolicy.readinessArrCents,
    });
    expect(first.log.decisions.length).toBeGreaterThan(0);
    expect(first.log.actions.some((action) => action.what === "list_ready_needs")).toBe(true);
    expect(normalizeIds(second.snapshot.events)).toEqual(normalizeIds(first.snapshot.events));
    expect(normalizeIds(policyLog(second))).toEqual(normalizeIds(policyLog(first)));
    expect(comparable(second)).toEqual(comparable(first));
  });

  test("with no override and a brief that follows the strategy, direction accuracy is 100%", () => {
    const right = scoreRun(world, get("right"));
    const oracle = scoreRun(world, get("oracle"));
    expect(right.headline.directionAccuracy.decisions).toBeGreaterThan(0);
    expect(right.headline.directionAccuracy.value).toBe(1);
    expect(get("right").log.decisions.every((decision) => decision.overridden === false)).toBe(
      true,
    );
    // The PM publishes what the strategy implies, as the noiseless oracle PM does.
    expect(right.headline.decisionQuality.value).toBe(oracle.headline.decisionQuality.value);
  });

  test("an always-wrong brief drops decision quality by the share the PM follows", () => {
    const wrong = scoreRun(world, get("wrong"));
    expect(wrong.headline.directionAccuracy.value).toBe(0);
    expect(wrong.headline.decisionQuality.value).toBe(0);

    // With override p, only the overridden decisions are right.
    const half = get("wrongHalf");
    const halfScore = scoreRun(world, half);
    const overridden = half.log.decisions.filter((decision) => decision.overridden).length;
    expect(overridden).toBeGreaterThan(0);
    expect(overridden).toBeLessThan(half.log.decisions.length);
    expect(halfScore.headline.decisionQuality.value).toBeCloseTo(
      overridden / half.log.decisions.length,
    );
  });
});
