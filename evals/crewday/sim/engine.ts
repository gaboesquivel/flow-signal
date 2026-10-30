import { asc } from "drizzle-orm";

import {
  accounts,
  decisions,
  events,
  merges,
  needs,
  priorityScores,
  signals,
  suggestions,
  themes,
} from "@/lib/db/schema";
import type { Embedder, SignalAi } from "@/lib/signal/ai/ports";
import type { Actor } from "@/lib/signal/context";
import type { SignalDb } from "@/lib/signal/db";
import { embedNeeds } from "@/lib/signal/domain/embeddings";
import {
  configureSuggestionScheduler,
  resetSuggestionScheduler,
} from "@/lib/signal/domain/suggestion-generation";
import { recordEvent } from "@/lib/signal/events";
import type { Metrics } from "@/lib/signal/metrics";
import { executeOperation } from "@/lib/signal/operations/execute";
import { findOperation } from "@/lib/signal/operations/registry";
import { configureAutoBriefs, resetAutoBriefs } from "@/lib/signal/domain/readiness";
import { configureSignalRuntime, resetSignalRuntime } from "@/lib/signal/runtime";

import { worldStart } from "../checks";
import type { World } from "../format";
import { createBoardAi } from "./board-ai";
import { createSimClock } from "./clock";
import { openSimDatabase } from "./database";
import { createAiMeter, meterAi } from "./meter";
import type { AiCall } from "./meter";
import { createOfflineSignalAi } from "./offline-ai";
import { createNearestNeed, createOracleEmbedder, indexWorld, weightedScore } from "./oracle";
import { createPmMemory, runPmWeek } from "./pm";
import { resolvePolicy } from "./policy";
import type { PolicyParams } from "./policy";
import type { SimDatabaseTarget } from "./safety";
import { identityOf } from "./state";
import type { Arm, SimLog, SimState } from "./state";
import { writeStrategy } from "./strategy";
import { createSurfaceRouter } from "./surfaces";
import type { Surface } from "./surfaces";
import { replaySignal } from "./submitter";

/**
 * The discrete-event engine (spec 004 → Simulation): replays a world in timestamp order in
 * simulated time through `configureSignalRuntime({ clock, db, ai })`, so every `created_at`,
 * decision, and event carries world time.
 *
 * - Day 0: the world's themes and accounts are configured, and the migrated backlog is loaded as
 *   approved (`open`) needs, duplicates included, each with its `need.created` event.
 * - Day 0, `follows_signal` only (spec 007): the world's strategy is written with `set_strategy`
 *   (`./strategy`), so Signal marks readiness and drafts briefs against it.
 * - Each signal: the submitter policy previews and submits it on its persona's surface; any
 *   suggestion generation `submit_signal` scheduled runs right after, at the same world time
 *   (no background timers; the board arm schedules none).
 * - Each simulated week: the PM policy, at the end of the week, after that week's signals.
 * - Year end: a snapshot of the database, the event log, `get_metrics`, and every submitter's
 *   `get_my_signals` view, which `scoreRun` reads.
 *
 * Runtime overrides are process-wide, so runs in one process are sequential.
 */

export interface RunArmOptions {
  /** Signal arm AI ports; default the offline fakes. Ignored by the board arm. */
  ai?: SignalAi;
  arm: Arm;
  /** Where to run; `assertSimDatabase` refuses anything but PGlite or local Docker. */
  db: SimDatabaseTarget;
  /** Extra `get_metrics` windows to snapshot (the scorer cross-checks each one). */
  metricsWindows?: { from: Date; to: Date }[];
  /**
   * Smoke runs only: stop the replay after this many simulated weeks (signals after it are not
   * sent). Never for results; the runner passes the same truncated world to the scorer.
   */
  limitWeeks?: number;
  /**
   * The embedder for the oracle's "nearest need in the world" lookup, independent of Signal's
   * (`createOracleEmbedder({ live })`). Default: the offline fake. Unmetered, so it never counts
   * as a PM model call; its `spendUsd` is subtracted from the arm's model spend.
   */
  oracleEmbedder?: Embedder & { spendUsd?: () => number };
  onProgress?: (message: string) => void;
  policy?: Partial<PolicyParams>;
  seed: number;
  /** Model spend so far in USD, e.g. from a Gateway cost meter; omitted offline. */
  spendUsd?: () => number;
  world: World;
}

export interface MetricsSnapshot {
  from: string;
  label: string;
  metrics: Metrics | null;
  to: string;
}

export interface RunSnapshot {
  decisions: { needId: string; publishedAt: string; status: string }[];
  events: {
    actorKind: string;
    needId: string | null;
    occurredAt: string;
    payload: Record<string, unknown>;
    signalId: string | null;
    suggestionId: string | null;
    type: string;
  }[];
  /** Database need id → true need key (null when it cannot be told). */
  identity: Record<string, string | null>;
  merges: { fromNeedId: string; id: string; intoNeedId: string; undone: boolean }[];
  metrics: MetricsSnapshot[];
  /** World signal id → whether its submitter's `get_my_signals` shows a published decision. */
  mySignalsDecided: Record<string, boolean>;
  needs: {
    createdAt: string;
    id: string;
    mergedIntoId: string | null;
    publicSummary: string | null;
    publicSummaryStatus: string;
    statement: string;
    status: string;
  }[];
  /** Weighted priority score per scored need (default criteria weights). */
  priority: Record<string, number>;
  signals: {
    actorKind: string;
    attachedTo: string;
    createdAt: string;
    id: string;
    needId: string;
    originalNeedId: string;
    /** The world signal it came from. */
    worldSignalId: string | null;
  }[];
  suggestions: {
    id: string;
    kind: string;
    needId: string | null;
    relatedNeedId: string | null;
    status: string;
    /** A `public_summary` suggestion's generated text, whatever the PM did with it. */
    summary?: string;
  }[];
}

export interface RunResult {
  aiCalls: AiCall[];
  arm: Arm;
  end: string;
  log: SimLog;
  modelSpendUsd: number | null;
  policy: PolicyParams;
  seed: number;
  snapshot: RunSnapshot;
  start: string;
  surfaceMix: Record<Surface, number>;
  weeks: number;
  world: { name: string; version: string };
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const SIM_OPERATOR_SECRET = "crewday-simulation-operator-secret";
const BACKLOG_ACTOR: Actor = { kind: "human", ref: "import:backlog" };
const SCORER_ACTOR: Actor = { kind: "human", ref: "crewday:scorer" };

const addUtcMonths = (date: Date, months: number) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

/** Configures the workspace and loads the migrated backlog as approved needs (day 0). */
const loadDayZero = async (state: SimState, ai: SignalAi, start: Date) => {
  const { db, world } = state;
  if (world.themes.length)
    await db.insert(themes).values(
      world.themes.map((theme) => ({
        description: theme.description,
        name: theme.name,
        strategicWeight: theme.strategicWeight,
      })),
    );
  if (world.accounts.length)
    await db.insert(accounts).values(
      world.accounts.map((account) => ({
        arrCents: account.arrCents,
        name: account.name,
        openDealCents: account.openDealCents,
        plan: account.plan,
      })),
    );
  const ids: string[] = [];
  for (const [i, row] of world.backlog.entries()) {
    // One millisecond apart, so the backlog keeps its spreadsheet order wherever age breaks ties.
    const at = new Date(start.getTime() + i);
    const statement = row.body.trim() ? `${row.title.trim()}: ${row.body.trim()}` : row.title;
    const id = await db.transaction(async (tx) => {
      const [need] = await tx
        .insert(needs)
        .values({ approvedAt: at, createdAt: at, statement, status: "open" })
        .returning({ id: needs.id });
      if (!need) throw new Error("Backlog need insert returned no row.");
      await recordEvent(tx, {
        actor: BACKLOG_ACTOR,
        needId: need.id,
        occurredAt: at,
        payload: { rowId: row.rowId, source: "backlog" },
        type: "need.created",
      });
      return need.id;
    });
    ids.push(id);
    state.identity.set(id, row.trueNeedKey);
    state.readQueue.push(id);
  }
  await embedNeeds(db, ai.embedder, ids).catch(() => 0);
};

const iso = (value: Date | string) => new Date(value).toISOString();

const readMetrics = async (label: string, from: Date, to: Date): Promise<MetricsSnapshot> => {
  const operation = findOperation("get_metrics");
  if (!operation) throw new Error("get_metrics is not registered");
  const result = await executeOperation(
    operation,
    { from: from.toISOString(), to: to.toISOString() },
    SCORER_ACTOR,
  );
  return {
    from: from.toISOString(),
    label,
    metrics: result.ok ? (result.data as Metrics) : null,
    to: to.toISOString(),
  };
};

const mySignalsDecided = async (state: SimState) => {
  const operation = findOperation("get_my_signals");
  if (!operation) throw new Error("get_my_signals is not registered");
  const seen: Record<string, boolean> = {};
  for (const submission of state.log.submissions) {
    if (submission.choice === "retry") continue;
    const result = await executeOperation(operation, { token: submission.token }, SCORER_ACTOR);
    const rows = result.ok
      ? (result.data as { signals: { decisions: unknown[]; signalId: string }[] }).signals
      : [];
    seen[submission.worldSignalId] = rows.some(
      (row) => row.signalId === submission.signalId && row.decisions.length > 0,
    );
  }
  return seen;
};

const takeSnapshot = async (
  state: SimState,
  windows: { from: Date; label: string; to: Date }[],
): Promise<RunSnapshot> => {
  const { db } = state;
  const needRows = await db
    .select()
    .from(needs)
    .orderBy(asc(needs.createdAt), asc(needs.statement));
  const identity: Record<string, string | null> = {};
  for (const need of needRows) identity[need.id] = await identityOf(state, need.id);
  const scoreRows = await db.select().from(priorityScores);
  const priority: Record<string, Record<string, number>> = {};
  for (const row of scoreRows) (priority[row.needId] ??= {})[row.criterion] = row.score;
  const metrics: MetricsSnapshot[] = [];
  for (const window of windows)
    metrics.push(await readMetrics(window.label, window.from, window.to));
  return {
    decisions: (await db.select().from(decisions).orderBy(asc(decisions.publishedAt))).map((d) => ({
      needId: d.needId,
      publishedAt: iso(d.publishedAt),
      status: d.status,
    })),
    events: (await db.select().from(events).orderBy(asc(events.occurredAt), asc(events.type))).map(
      (event) => ({
        actorKind: event.actorKind,
        needId: event.needId,
        occurredAt: iso(event.occurredAt),
        payload: event.payload,
        signalId: event.signalId,
        suggestionId: event.suggestionId,
        type: event.type,
      }),
    ),
    identity,
    merges: (await db.select().from(merges).orderBy(asc(merges.createdAt))).map((merge) => ({
      fromNeedId: merge.fromNeedId,
      id: merge.id,
      intoNeedId: merge.intoNeedId,
      undone: merge.undoneAt !== null,
    })),
    metrics,
    mySignalsDecided: await mySignalsDecided(state),
    needs: needRows.map((need) => ({
      createdAt: iso(need.createdAt),
      id: need.id,
      mergedIntoId: need.mergedIntoId,
      publicSummary: need.publicSummary,
      publicSummaryStatus: need.publicSummaryStatus,
      statement: need.statement,
      status: need.status,
    })),
    priority: Object.fromEntries(
      Object.entries(priority).flatMap(([needId, scores]) => {
        const score = weightedScore(scores);
        return score === null ? [] : [[needId, score]];
      }),
    ),
    signals: (await db.select().from(signals).orderBy(asc(signals.createdAt))).map((signal) => ({
      actorKind: signal.actorKind,
      attachedTo: signal.attachedTo,
      createdAt: iso(signal.createdAt),
      id: signal.id,
      needId: signal.needId,
      originalNeedId: signal.originalNeedId,
      worldSignalId: state.signalOrigin.get(signal.id) ?? null,
    })),
    suggestions: (await db.select().from(suggestions).orderBy(asc(suggestions.createdAt))).map(
      (s) => ({
        id: s.id,
        kind: s.kind,
        needId: s.needId,
        relatedNeedId: s.relatedNeedId,
        status: s.status,
        ...(s.kind === "public_summary" && typeof s.payload.summary === "string"
          ? { summary: s.payload.summary }
          : {}),
      }),
    ),
  };
};

/** The world's four quarters and the whole year, for the prevention-by-quarter report. */
export const metricsWindowsFor = (start: Date) => [
  ...[0, 1, 2, 3].map((q) => ({
    from: addUtcMonths(start, q * 3),
    label: `Q${q + 1}`,
    to: addUtcMonths(start, q * 3 + 3),
  })),
  { from: start, label: "year", to: addUtcMonths(start, 12) },
];

const drain = async (state: SimState) => {
  state.meter.setPhase("generation");
  while (state.pending.length > 0) await state.pending.shift()?.();
};

/** Replays one world through one arm and returns everything the scorer needs. */
export const runArm = async (options: RunArmOptions): Promise<RunResult> => {
  const { arm, world, seed } = options;
  const resolved = resolvePolicy(options.policy);
  // The board arm has no briefs or readiness in Signal: it always runs the oracle PM.
  const policy: PolicyParams = arm === "board" ? { ...resolved, pmPolicy: "oracle" } : resolved;
  const start = worldStart(world);
  if (!start) throw new Error("The world has no signals and no startsAt.");
  const year = addUtcMonths(start, 12);
  const end = options.limitWeeks
    ? new Date(Math.min(year.getTime(), start.getTime() + options.limitWeeks * WEEK_MS))
    : year;
  const progress = options.onProgress ?? (() => null);

  const opened = await openSimDatabase(options.db);
  const meter = createAiMeter();
  const signalAi = options.ai ?? createOfflineSignalAi();
  const baseAi = arm === "signal" ? signalAi : createBoardAi();
  const ai = meterAi(baseAi, meter);
  const clock = createSimClock(start);
  const priorSecret = process.env.OPERATOR_SECRET;
  process.env.OPERATOR_SECRET = SIM_OPERATOR_SECRET;

  const oracle = options.oracleEmbedder ?? createOracleEmbedder({ live: false });
  const state: SimState = {
    arm,
    clock,
    db: opened.db as SignalDb,
    identity: new Map(),
    index: indexWorld(world),
    log: {
      actions: [],
      decisions: [],
      invalid: [],
      previewLatencyMs: [],
      submissions: [],
      verdicts: [],
    },
    meter,
    nearest: createNearestNeed(world, oracle),
    pending: [],
    policy,
    readQueue: [],
    router: createSurfaceRouter({ meter, operatorSecret: SIM_OPERATOR_SECRET }),
    seed,
    sent: new Map(),
    signalOrigin: new Map(),
    world,
  };

  configureSignalRuntime({ ai, clock, db: state.db });
  // The oracle PM drafts its own briefs; Signal's automatic ones would only add model calls.
  configureAutoBriefs(policy.pmPolicy === "follows_signal");
  configureSuggestionScheduler((task) => {
    if (arm === "signal") state.pending.push(task);
  });

  try {
    meter.setPhase("setup");
    await loadDayZero(state, ai, start);
    progress(`[${arm}] day 0: ${world.backlog.length} backlog needs loaded`);
    if (arm === "signal" && policy.pmPolicy === "follows_signal") {
      const strategy = await writeStrategy(state);
      await drain(state);
      progress(
        `[${arm}] day 0: strategy written (${strategy.focusThemeIds.length} focus themes, readiness ${strategy.readinessArrCents} cents)`,
      );
    }

    const weeks = Math.ceil((end.getTime() - start.getTime()) / WEEK_MS);
    const pmTime = (week: number) =>
      new Date(Math.min(start.getTime() + (week + 1) * WEEK_MS, end.getTime()) - 60_000);
    const memory = createPmMemory();
    let week = 0;
    const runWeeksUntil = async (limit: number) => {
      while (week < weeks && pmTime(week).getTime() <= limit) {
        clock.set(pmTime(week));
        meter.setPhase("pm");
        await runPmWeek(state, memory, week);
        await drain(state);
        week += 1;
        if (week % 13 === 0)
          progress(
            `[${arm}] week ${week}/${weeks}: rest ${state.router.mix.rest}, public MCP ${state.router.mix.public_mcp}, Operator MCP ${state.router.mix.operator_mcp}`,
          );
      }
    };

    for (const signal of world.signals) {
      const at = new Date(signal.at);
      if (at.getTime() >= end.getTime()) break;
      await runWeeksUntil(at.getTime());
      clock.set(at);
      meter.setPhase("submitter");
      await replaySignal(state, signal);
      await drain(state);
    }
    await runWeeksUntil(end.getTime());

    clock.set(end);
    meter.setPhase("score");
    const windows = [
      ...metricsWindowsFor(start),
      ...(options.metricsWindows ?? []).map((window, i) => ({ ...window, label: `extra${i + 1}` })),
    ];
    const snapshot = await takeSnapshot(state, windows);
    progress(`[${arm}] done: ${state.log.submissions.length} submissions, ${weeks} weeks`);
    return {
      aiCalls: meter.calls,
      arm,
      end: end.toISOString(),
      log: state.log,
      modelSpendUsd: options.spendUsd
        ? Math.max(0, options.spendUsd() - (oracle.spendUsd?.() ?? 0))
        : null,
      policy,
      seed,
      snapshot,
      start: start.toISOString(),
      surfaceMix: { ...state.router.mix },
      weeks,
      world: { name: world.manifest.world, version: world.manifest.version },
    };
  } finally {
    resetSignalRuntime();
    resetAutoBriefs();
    resetSuggestionScheduler();
    if (priorSecret === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = priorSecret;
    await opened.close();
  }
};
