import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { compareArms, scoreRun } from "@/evals/crewday/score";
import type { ArmScore } from "@/evals/crewday/score";
import { assertSimDatabase, createBoardAi, runArm, UnsafeDatabaseError } from "@/evals/crewday/sim";
import type { RunResult } from "@/evals/crewday/sim";
import { openSimDatabase } from "@/evals/crewday/sim/database";
import { loadWorld } from "@/evals/crewday/world";
import type { World } from "@/evals/crewday/format";
import { needs } from "@/lib/db/schema";
import { executeOperation } from "@/lib/signal/operations/execute";
import { previewSignal } from "@/lib/signal/operations/preview-signal";
import { configureSignalRuntime, resetSignalRuntime } from "@/lib/signal/runtime";

// Offline (spec 004, task 03): the Crewday engine, policies, arms, and scorer on the fixture
// world with fake AI ports on in-process PGlite. Each run opens its own PGlite database.

const SEED = 7;
/** A simulated week holding the planted retry (fx-s09 and its retry fx-s10, 2026-03-10). */
const RETRY_WEEK = { from: new Date("2026-03-09T00:00:00Z"), to: new Date("2026-03-16T00:00:00Z") };

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** Replaces each distinct id with its order of first appearance (ids are random per run). */
const normalizeIds = (value: unknown) => {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value).replaceAll(uuid, (id) => {
      if (!ids.has(id)) ids.set(id, `<id:${ids.size}>`);
      return ids.get(id) ?? id;
    }),
  ) as unknown;
};

/** A score without wall-clock latency, the one thing that legitimately differs between runs. */
const comparableScore = (score: ArmScore) => ({
  ...score,
  diagnostics: { ...score.diagnostics, previewLatencyMs: null },
});

let world: World;
const runs: { board?: RunResult; signal?: RunResult; signalAgain?: RunResult } = {};
const run = (name: keyof typeof runs) => {
  const result = runs[name];
  if (!result) throw new Error(`run ${name} did not complete`);
  return result;
};

beforeAll(async () => {
  world = await loadWorld("fixture", "v1");
  const options = {
    db: { kind: "pglite" } as const,
    metricsWindows: [RETRY_WEEK],
    seed: SEED,
    world,
  };
  runs.signal = await runArm({ ...options, arm: "signal" });
  runs.signalAgain = await runArm({ ...options, arm: "signal" });
  runs.board = await runArm({ ...options, arm: "board" });
}, 180_000);

describe("crewday simulation [pglite]", () => {
  test("replaying the fixture world twice with one seed gives identical events and scores", () => {
    const first = run("signal");
    const second = run("signalAgain");
    expect(first.snapshot.events.length).toBeGreaterThan(100);
    expect(normalizeIds(second.snapshot.events)).toEqual(normalizeIds(first.snapshot.events));
    expect(normalizeIds(second.log.actions)).toEqual(normalizeIds(first.log.actions));
    expect(comparableScore(scoreRun(world, second))).toEqual(
      comparableScore(scoreRun(world, first)),
    );
  });

  test("every event and row carries world time", () => {
    const { end, snapshot, start } = run("signal");
    const inWorld = (at: string) => at >= start && at <= end;
    expect(snapshot.events.every((event) => inWorld(event.occurredAt))).toBe(true);
    expect(snapshot.signals.every((signal) => inWorld(signal.createdAt))).toBe(true);
    expect(snapshot.decisions.every((decision) => inWorld(decision.publishedAt))).toBe(true);
  });

  test("day 0 loads the migrated backlog as approved needs, duplicates included", () => {
    const { snapshot, start } = run("board");
    const backlog = snapshot.events.filter(
      (event) => event.type === "need.created" && event.payload.source === "backlog",
    );
    expect(backlog).toHaveLength(world.backlog.length);
    expect(backlog.every((event) => event.occurredAt.slice(0, 10) === start.slice(0, 10))).toBe(
      true,
    );
    const keys = backlog.map((event) => snapshot.identity[event.needId ?? ""]);
    expect(new Set(keys).size).toBeLessThan(keys.length);
  });

  test.each(["signal", "board"] as const)(
    "%s arm: the scorer's recomputation from events equals get_metrics for a week, the quarters, and the year",
    (arm) => {
      const score = scoreRun(world, run(arm));
      const checks = score.product.preventionRate.crossCheck;
      expect(checks.map((check) => check.label)).toEqual([
        "Q1",
        "Q2",
        "Q3",
        "Q4",
        "year",
        "extra1",
      ]);
      for (const check of checks) expect(check.recomputed, check.label).toEqual(check.getMetrics);
      const week = checks.find((check) => check.label === "extra1");
      expect(week?.from).toBe(RETRY_WEEK.from.toISOString());
      expect(
        (week?.recomputed.all.attachedToExisting ?? 0) + (week?.recomputed.all.mergedDrafts ?? 0),
      ).toBeGreaterThanOrEqual(0);
    },
  );

  test("the planted retry counts once and the planted validation failure not at all", () => {
    for (const arm of ["signal", "board"] as const) {
      const { log, snapshot } = run(arm);
      const retry = log.submissions.find((s) => s.worldSignalId === "fx-s10");
      const original = log.submissions.find((s) => s.worldSignalId === "fx-s09");
      expect(retry?.choice).toBe("retry");
      expect(retry?.signalId).toBe(original?.signalId);
      const created = snapshot.events.filter(
        (event) => event.type === "signal.created" && event.signalId === original?.signalId,
      );
      expect(created).toHaveLength(1);

      expect(log.invalid).toEqual([
        expect.objectContaining({ code: "validation_failed", worldSignalId: "fx-s16" }),
      ]);
      expect(snapshot.signals.some((signal) => signal.worldSignalId === "fx-s16")).toBe(false);

      const counted = world.signals.filter((s) => s.planted !== "retry" && s.planted !== "invalid");
      expect(snapshot.events.filter((event) => event.type === "signal.created")).toHaveLength(
        counted.length,
      );
      const year = snapshot.metrics.find((window) => window.label === "year")?.metrics;
      const overall = year?.preventionRate.overall.all;
      const drafts = snapshot.signals.filter((signal) => signal.attachedTo === "draft").length;
      expect((overall?.attachedToExisting ?? 0) + drafts).toBe(counted.length);
    }
  });

  test("signals filed through the support copilot over public MCP count as agent", () => {
    for (const arm of ["signal", "board"] as const) {
      const { log, snapshot, surfaceMix } = run(arm);
      expect(surfaceMix.public_mcp).toBeGreaterThan(0);
      expect(surfaceMix.operator_mcp).toBeGreaterThan(0);
      expect(surfaceMix.rest).toBeGreaterThan(0);
      const actorOf = new Map(snapshot.signals.map((signal) => [signal.id, signal.actorKind]));
      const fresh = log.submissions.filter((s) => s.choice !== "retry");
      const viaMcp = fresh.filter((s) => s.surface === "public_mcp");
      expect(viaMcp.length).toBe(
        world.signals.filter((s) => s.channel === "mcp" && s.planted !== "retry").length,
      );
      for (const s of viaMcp) expect(actorOf.get(s.signalId)).toBe("agent");
      for (const s of fresh.filter((f) => f.surface === "rest"))
        expect(actorOf.get(s.signalId)).toBe("human");

      const year = snapshot.metrics.find((window) => window.label === "year")?.metrics;
      const agent = year?.preventionRate.overall.agent;
      const agentDrafts = viaMcp.filter((s) => s.attachedTo === "draft").length;
      expect((agent?.attachedToExisting ?? 0) + agentDrafts).toBe(viaMcp.length);
    }
  });

  test("the vote-board arm never emits a suggestion", () => {
    const { aiCalls, snapshot } = run("board");
    expect(snapshot.suggestions).toEqual([]);
    expect(snapshot.events.filter((event) => event.type.startsWith("suggestion."))).toEqual([]);
    expect(aiCalls.filter((call) => call.port === "reasoner")).toEqual([]);
    expect(run("signal").snapshot.suggestions.length).toBeGreaterThan(0);
  });

  test("the vote-board preview returns keyword results for the title only", async () => {
    const opened = await openSimDatabase({ kind: "pglite" });
    try {
      configureSignalRuntime({ ai: createBoardAi(), db: opened.db });
      const statements = [
        "Shift managers need to approve shift swaps from their phone",
        "Staff need to swap shifts with a coworker",
        "Payroll admins need a CSV export of approved hours",
        "Managers need a weekly shift report",
        "Frontline staff need shift reminders",
      ];
      await opened.db
        .insert(needs)
        .values(statements.map((statement) => ({ statement, status: "open" as const })));
      const result = await executeOperation(
        previewSignal,
        { body: "Our payroll team keeps asking for a CSV file.", title: "Shift swap approvals" },
        { kind: "human", ref: "web" },
      );
      expect(result.ok).toBe(true);
      const { data } = result as {
        data: {
          draftNeed: { statement: string };
          matches: { probability: number; reason: string; statement: string }[];
        };
      };
      expect(data.draftNeed.statement).toBe("Shift swap approvals");
      expect(data.matches).toHaveLength(3);
      expect(data.matches[0]?.statement).toBe(statements[0]);
      for (const match of data.matches) {
        expect(match.reason).toBe("");
        expect(match.probability).toBe(1);
        expect(match.statement.toLowerCase()).toMatch(/shift|swap|approv/u);
      }
      expect(data.matches.some((match) => match.statement.includes("CSV"))).toBe(false);
    } finally {
      resetSignalRuntime();
      await opened.close();
    }
  });

  test("the PM policy makes no model call and records organizing and deciding actions", () => {
    for (const arm of ["signal", "board"] as const) {
      const { aiCalls, log } = run(arm);
      const pmModelCalls = aiCalls.filter(
        (call) => call.phase === "pm" && call.port !== "retriever",
      );
      // Only operations the PM called (e.g. draft_decision_brief) reach Signal's models.
      expect(pmModelCalls.filter((call) => !call.cause.startsWith("op:"))).toEqual([]);
      if (arm === "board") expect(pmModelCalls).toEqual([]);
      else expect(pmModelCalls.some((call) => call.cause === "op:draft_decision_brief")).toBe(true);

      const organizing = log.actions.filter((action) => action.class === "organizing");
      const deciding = log.actions.filter((action) => action.class === "deciding");
      expect(organizing.length).toBeGreaterThan(0);
      expect(deciding.length).toBeGreaterThan(0);
      expect(new Set(deciding.map((action) => action.what))).toEqual(
        new Set(
          arm === "signal"
            ? ["draft_decision_brief", "resolve_suggestion", "publish_decision"]
            : ["hand_brief", "publish_decision"],
        ),
      );
      const perWeek = new Map<number, number>();
      for (const action of log.actions)
        perWeek.set(action.week, (perWeek.get(action.week) ?? 0) + 1);
      expect(Math.max(...perWeek.values())).toBeLessThanOrEqual(run(arm).policy.pmActions);
      const score = scoreRun(world, run(arm));
      expect(score.aiCalls.pmPolicyOutsideOperations).toBe(0);
      expect(score.headline.pmOrganizingShare.organizing).toBe(organizing.length);
      expect(score.headline.pmOrganizingShare.deciding).toBe(deciding.length);
    }
  });

  test("the scorer reports every metric with intervals, and compares the arms", () => {
    const signal = scoreRun(world, run("signal"));
    const board = scoreRun(world, run("board"));
    for (const score of [signal, board]) {
      for (const metric of [
        score.headline.truePreventionRate,
        score.headline.decisionQuality,
        score.headline.revenueCoverage,
        score.headline.closeTheLoopRate,
        score.diagnostics.falseAttachRate,
        score.diagnostics.hiddenDuplicateRate,
      ]) {
        expect(metric.value).not.toBeNull();
        expect(metric.ci).not.toBeNull();
        const [low, high] = metric.ci ?? [0, 0];
        expect(low).toBeLessThanOrEqual(high);
      }
      expect(score.product.preventionRate.byQuarter).toHaveLength(4);
      expect(score.diagnostics.piiScan.planted.map((p) => p.worldSignalId)).toEqual(["fx-s15"]);
      expect(score.diagnostics.piiScan.leaks).toEqual([]);
      expect(score.diagnostics.modelSpendPerSignalUsd).toBeNull();
      expect(score.diagnostics.keywordFindableShare).toBeNull();
      expect(score.notMeasured.map((m) => m.metric)).toEqual([
        "context_rate",
        "submitter_willingness",
      ]);
      expect(score.replay).toEqual({ invalid: 1, retries: 1, submitted: 48 });
    }
    expect(signal.product.suggestionAcceptance.acceptancePrecision.value).not.toBeNull();
    expect(signal.diagnostics.priorityAgreement.source).toBe("priority_score");
    expect(board.diagnostics.priorityAgreement.source).toBe("votes");

    const comparison = compareArms(signal, board);
    expect(comparison.criteria.map((c) => c.name)).toEqual([
      "true_prevention_lift",
      "decision_quality",
      "revenue_coverage_ratio",
      "pm_organizing_share",
      "suggestion_acceptance",
      "false_attach_rate",
      "unmerge_rate",
      "planted_pii",
      "model_spend_per_signal",
      "keyword_findable_share",
    ]);
    expect(comparison.lift.truePreventionRate.ci).not.toBeNull();
    expect(typeof comparison.killSignal).toBe("boolean");
    expect(comparison.criteria.find((c) => c.name === "planted_pii")?.pass).toBe(true);
    expect(comparison.criteria.find((c) => c.name === "model_spend_per_signal")?.pass).toBeNull();
    expect(compareArms(signal, board)).toEqual(comparison);
  });
});

describe("crewday runner safety", () => {
  test("refuses any database that is not PGlite or local Docker", async () => {
    const envDir = await mkdtemp(path.join(tmpdir(), "crewday-env-"));
    const envFile = path.join(envDir, ".env.local");
    await writeFile(envFile, "DATABASE_URL=postgres://dev:secret@localhost:5432/signal_dev\n");
    const check = (url: string) => () => assertSimDatabase({ kind: "url", url }, { envFile });

    expect(assertSimDatabase({ kind: "pglite" })).toEqual({ kind: "pglite" });
    expect(check("postgres://postgres:postgres@localhost:5432/signal_test_sim")).not.toThrow();
    expect(check("postgres://postgres:postgres@127.0.0.1:5432/signal_test_sim")).not.toThrow();
    for (const url of [
      "postgres://user:pw@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb",
      "postgres://user:pw@db.example.com:5432/signal",
      "postgres://dev:other@localhost:5432/signal_dev",
      "mysql://root@localhost/signal",
      "not a url",
    ])
      expect(check(url), url).toThrow(UnsafeDatabaseError);

    await expect(
      runArm({
        arm: "board",
        db: { kind: "url", url: "postgres://user:pw@ep-x.eu-central-1.aws.neon.tech/neondb" },
        seed: 1,
        world,
      }),
    ).rejects.toThrow(UnsafeDatabaseError);
  });
});
