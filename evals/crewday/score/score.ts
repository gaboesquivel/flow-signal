import { isCounted } from "../checks";
import type { Need, World, WorldSignal } from "../format";
import type { RunResult, RunSnapshot } from "../sim/engine";
import { bootstrap, drawSamples, ratioOf } from "./bootstrap";
import type { Interval, PerNeed } from "./bootstrap";
import { recomputePrevention } from "./recompute";
import type { PreventionSplit } from "./recompute";

/**
 * Scores one run against the world's ground truth (spec 004 → Metrics reported): every metric
 * from the run's database snapshot, event log, and the policies' log. Ratios carry their
 * per-need parts so intervals (and `compareArms`' paired differences) resample needs. Pure and
 * deterministic for a given run and seed.
 *
 * A database need stands for its **identity** (the engine's snapshot: backlog row or creating
 * signal). A signal is on the right need when that identity is one of its true needs, or the
 * parent of its main need (a split trap's child "already existed" through its parent).
 */

export interface ScoredValue {
  ci: Interval | null;
  /** Per true need (or `~unknown`); absent when the metric does not split by need. */
  perNeed?: PerNeed;
  value: number | null;
}

export interface WindowCheck {
  from: string;
  getMetrics: PreventionSplit | null;
  label: string;
  matches: boolean;
  recomputed: PreventionSplit;
  to: string;
}

export interface ArmScore {
  aiCalls: { byPhase: Record<string, number>; pmPolicyOutsideOperations: number };
  arm: RunResult["arm"];
  diagnostics: {
    falseAttachRate: ScoredValue;
    hiddenDuplicateRate: ScoredValue;
    keywordFindableShare: number | null;
    modelSpendPerSignalUsd: number | null;
    needStatementRubric: { note: string; value: null };
    piiScan: {
      /**
       * The guardrail: planted PII, persona names, or emails in any generated `public_summary`
       * suggestion, whatever the PM did with it.
       */
      generated: { leaks: { needKey: string | null; pii: string }[]; summariesChecked: number };
      /** Secondary: planted PII in approved public summaries. */
      leaks: { needId: string; pii: string; worldSignalId: string }[];
      planted: { pii: string[]; worldSignalId: string }[];
      summariesChecked: number;
    };
    previewLatencyMs: { note: string; p50: number | null; p95: number | null };
    priorityAgreement: ScoredValue & { needs: number; source: "priority_score" | "votes" };
    unmergeRate: { merges: number; undone: number; value: number | null };
  };
  headline: {
    closeTheLoopRate: ScoredValue;
    decisionQuality: ScoredValue;
    /**
     * Spec 007: decisions whose brief recommended the strategy-implied status ÷ decisions that had
     * a recommendation (in_progress and shipped count as planned). Null without any (board arm).
     */
    directionAccuracy: ScoredValue & { decisions: number };
    pmOrganizingShare: {
      deciding: number;
      organizing: number;
      total: number;
      value: number | null;
    };
    /**
     * Spec 007: simulated days from ready to decided, per policy-logged decision. `value` is the
     * mean (a ratio, so it resamples and pairs like the others); `medianDays` is the point median.
     * Ready is when the PM saw it (`oracle`) or Signal's `readyAt` (`follows_signal`).
     */
    readinessLeadTime: ScoredValue & { decisions: number; medianDays: number | null };
    revenueCoverage: ScoredValue;
    truePreventionRate: ScoredValue;
  };
  notMeasured: { metric: string; reason: string }[];
  policy: RunResult["policy"];
  product: {
    decisionLatency: {
      decisions: number;
      medianDays: number | null;
      openPast30Days: number;
      undecidedAtYearEnd: number;
    };
    preventionRate: {
      byQuarter: { label: string; rate: number | null; recomputed: number | null }[];
      crossCheck: WindowCheck[];
      year: PreventionSplit | null;
    };
    suggestionAcceptance: {
      acceptancePrecision: ScoredValue;
      byKind: { acceptanceRate: number | null; kind: string; resolved: number }[];
      overall: number | null;
    };
  };
  /** Counted signals the policy submitted, the invalid ones it recorded, and retries. */
  replay: { invalid: number; retries: number; submitted: number };
  seed: number;
  world: RunResult["world"];
}

export const NOT_MEASURED = [
  {
    metric: "context_rate",
    reason:
      "It repeats what the generator wrote, so it only means something for live agents (spec 005) and real users.",
  },
  {
    metric: "submitter_willingness",
    reason:
      "Submitters' willingness to add their voice (riskiest assumption 1): the submitter policy assumes it.",
  },
] as const;

const UNKNOWN = "~unknown";
const DAY_MS = 86_400_000;

const add = (perNeed: PerNeed, key: string, num: number, den: number) => {
  const part = perNeed[key] ?? { den: 0, num: 0 };
  part.num += num;
  part.den += den;
  perNeed[key] = part;
};

/** Nearest-rank percentile, rounded to 0.01. */
const percentile = (values: number[], q: number) => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
};

/** Ranks from 1, ties sharing their average rank. */
const averageRanks = (values: number[]) => {
  const order = values.map((value, i) => ({ i, value })).toSorted((a, b) => a.value - b.value);
  const ranks = Array.from({ length: values.length }, () => 0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) end += 1;
    for (let k = start; k <= end; k += 1) ranks[order[k]?.i ?? 0] = (start + end) / 2 + 1;
    start = end + 1;
  }
  return ranks;
};

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Spearman rank correlation with average ranks for ties; null under three pairs. */
const spearman = (pairs: [number, number][]) => {
  if (pairs.length < 3) return null;
  const a = averageRanks(pairs.map((p) => p[0]));
  const b = averageRanks(pairs.map((p) => p[1]));
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    cov += x * y;
    va += x * x;
    vb += y * y;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : null;
};

const strategyStatus = (status: string) => (status === "declined" ? "declined" : "planned");

/** Everything the metric functions share. */
interface Ctx {
  identity: (needId: string | null | undefined) => string | null;
  keyOf: (key: string | null) => string;
  keys: string[];
  needs: Map<string, Need>;
  onRightNeed: (signal: WorldSignal, needId: string) => boolean;
  run: RunResult;
  samples: string[][];
  snapshot: RunSnapshot;
  /** Stored, counted signals: one row per world signal (a retry replays its original's row). */
  stored: { row: RunSnapshot["signals"][number]; signal: WorldSignal }[];
  world: World;
}

const scored = (ctx: Ctx, perNeed: PerNeed): ScoredValue => ({
  ci: bootstrap(ctx.samples, (drawn) => ratioOf(perNeed, drawn)),
  perNeed,
  value: ratioOf(perNeed, ctx.keys),
});

const mainKey = (ctx: Ctx, signal: WorldSignal) => ctx.keyOf(signal.labels.needKeys[0] ?? null);

/**
 * Signals whose true need already existed and that ended attached to it ÷ all such signals. A
 * signal "ended attached" when it is on a need of its true identity that is not a stand-alone
 * duplicate it created: it attached at submission, its draft was merged into another need, or
 * another need was merged into its draft. Duplicates nobody merged stay in the denominator.
 * The need must also have existed before the signal, or be the only live need of its identity
 * at year end (a merge into a fresh duplicate is not prevention).
 */
const truePrevention = (ctx: Ctx) => {
  const needById = new Map(ctx.snapshot.needs.map((need) => [need.id, need]));
  const liveByIdentity = new Map<string, number>();
  for (const need of ctx.snapshot.needs) {
    const key = need.status === "merged" ? null : ctx.identity(need.id);
    if (key) liveByIdentity.set(key, (liveByIdentity.get(key) ?? 0) + 1);
  }
  const established = (needId: string, at: string) => {
    const need = needById.get(needId);
    const key = ctx.identity(needId);
    return Boolean(
      need &&
      (Date.parse(need.createdAt) < Date.parse(at) || (key && liveByIdentity.get(key) === 1)),
    );
  };
  const mergedInto = new Set(
    ctx.snapshot.merges.filter((merge) => !merge.undone).map((merge) => merge.intoNeedId),
  );
  const consolidated = (row: Ctx["stored"][number]["row"]) =>
    row.attachedTo === "existing" ||
    row.needId !== row.originalNeedId ||
    mergedInto.has(row.needId);
  const perNeed: PerNeed = {};
  for (const { row, signal } of ctx.stored)
    if (signal.labels.existedAtTime) {
      const ended =
        consolidated(row) &&
        ctx.onRightNeed(signal, row.needId) &&
        established(row.needId, signal.at);
      add(perNeed, mainKey(ctx, signal), ended ? 1 : 0, 1);
    }
  return scored(ctx, perNeed);
};

/** Signals on a need that is not their true need ÷ stored signals (at year end). */
const falseAttach = (ctx: Ctx) => {
  const perNeed: PerNeed = {};
  for (const { row, signal } of ctx.stored)
    add(perNeed, mainKey(ctx, signal), ctx.onRightNeed(signal, row.needId) ? 0 : 1, 1);
  return scored(ctx, perNeed);
};

/**
 * The true need a decision is judged against. A split trap's parent is left out once its signals
 * moved to the children: a decision on a need whose identity is a split parent is scored as the
 * child its year-end signals mostly belong to (ties by key), and dropped when no counted signal is
 * left on it. A parent still holding mostly its own signals stays the parent. `undefined` means
 * the decision is excluded from decision quality, revenue coverage, and close-the-loop.
 */
const decisionKeyOf = (ctx: Ctx, needId: string): string | null | undefined => {
  const key = ctx.identity(needId);
  const children = key ? ctx.needs.get(key)?.splitInto : undefined;
  if (!children?.length) return key;
  const counts = new Map<string, number>();
  for (const { row, signal } of ctx.stored) {
    const [main] = signal.labels.needKeys;
    if (row.needId === needId && main) counts.set(main, (counts.get(main) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const [top] = [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return top && children.includes(top[0]) ? top[0] : key;
};

/** Decision quality, plus the true needs decided and when each first got a correct decision. */
const decisionOutcomes = (ctx: Ctx) => {
  const quality: PerNeed = {};
  const decided = new Set<string>();
  const correctAt = new Map<string, number>();
  for (const decision of ctx.snapshot.decisions) {
    const key = decisionKeyOf(ctx, decision.needId);
    if (key === undefined) continue;
    const need = key ? ctx.needs.get(key) : undefined;
    const right = need?.strategyDecision.status === strategyStatus(decision.status);
    add(quality, ctx.keyOf(key), right ? 1 : 0, 1);
    if (!key) continue;
    decided.add(key);
    const at = Date.parse(decision.publishedAt);
    if (right) correctAt.set(key, Math.min(correctAt.get(key) ?? at, at));
  }
  return { correctAt, decided, quality: scored(ctx, quality) };
};

/** Spec 007 → direction accuracy, against the strategy-implied decision of the scored need. */
const directionAccuracy = (ctx: Ctx): ArmScore["headline"]["directionAccuracy"] => {
  const perNeed: PerNeed = {};
  let decisions = 0;
  for (const decision of ctx.run.log.decisions) {
    if (!decision.recommendedStatus) continue;
    const key = decisionKeyOf(ctx, decision.needId);
    if (key === undefined) continue;
    const need = key ? ctx.needs.get(key) : undefined;
    const right = need?.strategyDecision.status === strategyStatus(decision.recommendedStatus);
    add(perNeed, ctx.keyOf(key), right ? 1 : 0, 1);
    decisions += 1;
  }
  return { ...scored(ctx, perNeed), decisions };
};

/** Spec 007 → readiness lead time: ready → decided, in simulated days. */
const readinessLeadTime = (ctx: Ctx): ArmScore["headline"]["readinessLeadTime"] => {
  const perNeed: PerNeed = {};
  const days: number[] = [];
  for (const decision of ctx.run.log.decisions) {
    const key = decisionKeyOf(ctx, decision.needId);
    if (key === undefined) continue;
    const lead = Math.max(0, (Date.parse(decision.at) - Date.parse(decision.readyAt)) / DAY_MS);
    add(perNeed, ctx.keyOf(key), lead, 1);
    days.push(lead);
  }
  return { ...scored(ctx, perNeed), decisions: days.length, medianDays: percentile(days, 0.5) };
};

/**
 * When each true need became ready, from ground truth: its counted signals' distinct accounts'
 * ARR reaches the readiness line (consolidated demand, whatever the arm fragmented it into).
 */
const trueReadiness = (ctx: Ctx) => {
  const arr = new Map(ctx.world.accounts.map((account) => [account.key, account.arrCents]));
  const readyAt = new Map<string, number>();
  const accountsSoFar = new Map<string, Set<string>>();
  for (const signal of ctx.world.signals) {
    if (!isCounted(signal)) continue;
    for (const key of signal.labels.needKeys) {
      const seen = accountsSoFar.get(key) ?? new Set<string>();
      seen.add(signal.accountKey);
      accountsSoFar.set(key, seen);
      const total = [...seen].reduce((sum, account) => sum + (arr.get(account) ?? 0), 0);
      if (!readyAt.has(key) && total >= ctx.run.policy.readinessArrCents)
        readyAt.set(key, Date.parse(signal.at));
    }
  }
  return { arr, readyAt };
};

/** ARR of requesting accounts on ready needs decided correctly within the window ÷ all ready. */
const revenueCoverage = (ctx: Ctx, correctAt: Map<string, number>) => {
  const { arr, readyAt } = trueReadiness(ctx);
  const windowMs = ctx.run.policy.coverageWindowDays * DAY_MS;
  const perNeed: PerNeed = {};
  for (const [key, at] of readyAt) {
    const need = ctx.needs.get(key);
    if (!need) continue;
    const requesterArr = need.requesterAccounts.reduce((sum, a) => sum + (arr.get(a) ?? 0), 0);
    const decidedAt = correctAt.get(key);
    const inTime = decidedAt !== undefined && decidedAt <= at + windowMs;
    add(perNeed, key, inTime ? requesterArr : 0, requesterArr);
  }
  return scored(ctx, perNeed);
};

/** Signals on decided true needs whose `get_my_signals` view shows a decision. */
const closeTheLoop = (ctx: Ctx, decided: Set<string>) => {
  const perNeed: PerNeed = {};
  for (const { row, signal } of ctx.stored) {
    if (!signal.labels.needKeys.some((key) => decided.has(key))) continue;
    const seen = ctx.snapshot.mySignalsDecided[signal.id] && ctx.onRightNeed(signal, row.needId);
    add(perNeed, mainKey(ctx, signal), seen ? 1 : 0, 1);
  }
  return scored(ctx, perNeed);
};

/** Live needs at year end that share a true need with another live need ÷ live needs. */
const hiddenDuplicates = (ctx: Ctx) => {
  const counts = new Map<string, number>();
  for (const need of ctx.snapshot.needs)
    if (need.status !== "merged") {
      const key = ctx.keyOf(ctx.identity(need.id));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const perNeed: PerNeed = {};
  for (const [key, count] of counts)
    add(perNeed, key, key !== UNKNOWN && count > 1 ? count : 0, count);
  return scored(ctx, perNeed);
};

/**
 * Spearman between the arm's ranking and the true priority, one point per true need (its live
 * needs' best score). Signal ranks by priority score; the board by votes (signals per need).
 */
const priorityAgreement = (ctx: Ctx): ArmScore["diagnostics"]["priorityAgreement"] => {
  const source = ctx.run.arm === "signal" ? "priority_score" : "votes";
  const votes = new Map<string, number>();
  for (const { row } of ctx.stored) votes.set(row.needId, (votes.get(row.needId) ?? 0) + 1);
  const best = new Map<string, number>();
  for (const need of ctx.snapshot.needs) {
    if (need.status === "merged") continue;
    const key = ctx.identity(need.id);
    const score = source === "priority_score" ? ctx.snapshot.priority[need.id] : votes.get(need.id);
    if (!key || !ctx.needs.has(key) || score === undefined) continue;
    best.set(key, Math.max(best.get(key) ?? Number.NEGATIVE_INFINITY, score));
  }
  // A higher score means higher priority and rank 1 is the highest, so pair with −rank.
  const pairs = (drawn: Iterable<string>) =>
    [...drawn].flatMap((key): [number, number][] => {
      const score = best.get(key);
      const need = ctx.needs.get(key);
      return score === undefined || !need ? [] : [[score, -need.truePriority]];
    });
  return {
    ci: bootstrap(ctx.samples, (drawn) => spearman(pairs(drawn))),
    needs: best.size,
    source,
    value: spearman(pairs(ctx.keys)),
  };
};

/** Planted PII in approved public summaries, and planted PII or names in any generated one. */
const piiScan = (ctx: Ctx): ArmScore["diagnostics"]["piiScan"] => {
  const planted = ctx.world.signals
    .filter((signal) => signal.planted === "pii")
    .map((signal) => ({ pii: signal.pii ?? [], worldSignalId: signal.id }));
  const summaries = ctx.snapshot.needs.filter(
    (need) => need.publicSummaryStatus === "approved" && need.publicSummary,
  );
  const leaks = summaries.flatMap((need) => {
    const text = (need.publicSummary ?? "").toLowerCase();
    return planted.flatMap(({ pii, worldSignalId }) =>
      pii
        .filter((detail) => text.includes(detail.toLowerCase()))
        .map((detail) => ({ needId: need.id, pii: detail, worldSignalId })),
    );
  });
  const terms = [
    ...planted.flatMap(({ pii }) => pii),
    ...ctx.world.personas.flatMap((persona) => [persona.name, persona.email]),
  ];
  const generated = ctx.snapshot.suggestions.filter((s) => s.kind === "public_summary");
  const generatedLeaks = generated.flatMap((suggestion) => {
    const text = (suggestion.summary ?? "").toLowerCase();
    return terms
      .filter((term) => term && text.includes(term.toLowerCase()))
      .map((pii) => ({ needKey: ctx.identity(suggestion.needId), pii }));
  });
  return {
    generated: { leaks: generatedLeaks, summariesChecked: generated.length },
    leaks,
    planted,
    summariesChecked: summaries.length,
  };
};

/** get_metrics' prevention rate for every snapshot window, beside the event-log recomputation. */
const crossCheck = (snapshot: RunSnapshot): WindowCheck[] =>
  snapshot.metrics.map((window) => {
    const recomputed = recomputePrevention(snapshot.events, {
      from: new Date(window.from),
      to: new Date(window.to),
    });
    const fromMetrics = window.metrics?.preventionRate.overall ?? null;
    return {
      from: window.from,
      getMetrics: fromMetrics,
      label: window.label,
      matches: JSON.stringify(fromMetrics) === JSON.stringify(recomputed),
      recomputed,
      to: window.to,
    };
  });

/** Accepted suggestions that ground truth says are correct ÷ accepted (resolved ones only). */
const acceptancePrecision = (ctx: Ctx) => {
  const perNeed: PerNeed = {};
  for (const verdict of ctx.run.log.verdicts)
    if (verdict.resolved && verdict.applied === "accept")
      add(perNeed, ctx.keyOf(verdict.trueNeedKey), verdict.truth === "accept" ? 1 : 0, 1);
  return scored(ctx, perNeed);
};

const aiCalls = (run: RunResult): ArmScore["aiCalls"] => {
  const models = run.aiCalls.filter((call) => call.port !== "retriever");
  const byPhase: Record<string, number> = {};
  for (const call of models) byPhase[call.phase] = (byPhase[call.phase] ?? 0) + 1;
  return {
    byPhase,
    pmPolicyOutsideOperations: models.filter(
      (call) => call.phase === "pm" && !call.cause.startsWith("op:"),
    ).length,
  };
};

const buildCtx = (world: World, run: RunResult, options: ScoreOptions): Ctx => {
  const { snapshot } = run;
  const needs = new Map(world.needs.map((need) => [need.key, need]));
  const parentOf = new Map(
    world.needs.flatMap((need) => (need.splitInto ?? []).map((child) => [child, need.key])),
  );
  const worldSignals = new Map(world.signals.map((signal) => [signal.id, signal]));
  const identity = (needId: string | null | undefined) =>
    (needId ? snapshot.identity[needId] : null) ?? null;
  const keys = [...world.needs.map((need) => need.key).toSorted(), UNKNOWN];
  return {
    identity,
    keyOf: (key) => (key && needs.has(key) ? key : UNKNOWN),
    keys,
    needs,
    onRightNeed: (signal, needId) => {
      const key = identity(needId);
      const [main] = signal.labels.needKeys;
      return Boolean(
        key && (signal.labels.needKeys.includes(key) || (main && parentOf.get(main) === key)),
      );
    },
    run,
    samples: drawSamples(keys, options.seed ?? run.seed, options.resamples),
    snapshot,
    stored: snapshot.signals.flatMap((row) => {
      const signal = row.worldSignalId ? worldSignals.get(row.worldSignalId) : undefined;
      return signal && isCounted(signal) ? [{ row, signal }] : [];
    }),
    world,
  };
};

interface ScoreOptions {
  resamples?: number;
  /** Bootstrap seed; default the run's seed. */
  seed?: number;
}

export const scoreRun = (world: World, run: RunResult, options: ScoreOptions = {}): ArmScore => {
  const ctx = buildCtx(world, run, options);
  const { log, snapshot } = run;
  const decisions = decisionOutcomes(ctx);
  const checks = crossCheck(snapshot);
  const year = snapshot.metrics.find((window) => window.label === "year")?.metrics ?? null;
  const organizing = log.actions.filter((action) => action.class === "organizing").length;
  const merges = snapshot.merges.length;
  const undone = snapshot.merges.filter((merge) => merge.undone).length;
  const submitted = log.submissions.filter((s) => s.choice !== "retry").length;
  const decidedNeeds = new Set(snapshot.decisions.map((decision) => decision.needId));

  return {
    aiCalls: aiCalls(run),
    arm: run.arm,
    diagnostics: {
      falseAttachRate: falseAttach(ctx),
      hiddenDuplicateRate: hiddenDuplicates(ctx),
      keywordFindableShare: world.manifest.keywordFindableShare,
      modelSpendPerSignalUsd:
        run.modelSpendUsd === null || submitted === 0 ? null : run.modelSpendUsd / submitted,
      needStatementRubric: {
        note: "Not computed: grading is deferred (model grader as in evals/matching; never used by a policy).",
        value: null,
      },
      piiScan: piiScan(ctx),
      previewLatencyMs: {
        note: "Reported only: in-process replay does not measure production latency.",
        p50: percentile(log.previewLatencyMs, 0.5),
        p95: percentile(log.previewLatencyMs, 0.95),
      },
      priorityAgreement: priorityAgreement(ctx),
      unmergeRate: { merges, undone, value: merges === 0 ? null : undone / merges },
    },
    headline: {
      closeTheLoopRate: closeTheLoop(ctx, decisions.decided),
      decisionQuality: decisions.quality,
      directionAccuracy: directionAccuracy(ctx),
      pmOrganizingShare: {
        deciding: log.actions.length - organizing,
        organizing,
        total: log.actions.length,
        value: log.actions.length === 0 ? null : organizing / log.actions.length,
      },
      readinessLeadTime: readinessLeadTime(ctx),
      revenueCoverage: revenueCoverage(ctx, decisions.correctAt),
      truePreventionRate: truePrevention(ctx),
    },
    notMeasured: [...NOT_MEASURED],
    policy: run.policy,
    product: {
      decisionLatency: {
        decisions: year?.decisionLatency.decided.all.decisions ?? 0,
        medianDays: year?.decisionLatency.decided.all.medianDays ?? null,
        openPast30Days: year?.decisionLatency.openPast30Days.needs ?? 0,
        undecidedAtYearEnd: snapshot.needs.filter(
          (need) => need.status !== "merged" && !decidedNeeds.has(need.id),
        ).length,
      },
      preventionRate: {
        byQuarter: checks
          .filter((check) => check.label.startsWith("Q"))
          .map((check) => ({
            label: check.label,
            rate: check.getMetrics?.all.rate ?? null,
            recomputed: check.recomputed.all.rate,
          })),
        crossCheck: checks,
        year: year?.preventionRate.overall ?? null,
      },
      suggestionAcceptance: {
        acceptancePrecision: acceptancePrecision(ctx),
        byKind: (year?.suggestionAcceptance.byKind ?? []).map((kind) => ({
          acceptanceRate: kind.all.acceptanceRate,
          kind: kind.kind,
          resolved: kind.all.accepted + kind.all.edited + kind.all.rejected,
        })),
        overall: year?.suggestionAcceptance.overall.all.acceptanceRate ?? null,
      },
    },
    replay: {
      invalid: log.invalid.length,
      retries: log.submissions.filter((s) => s.choice === "retry").length,
      submitted,
    },
    seed: run.seed,
    world: run.world,
  };
};
