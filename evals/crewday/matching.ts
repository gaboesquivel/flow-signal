import { MATCH_THRESHOLD } from "@/lib/signal/domain/matching";
import type { Embedder, MatchJudge, NeedExtractor } from "@/lib/signal/ai/ports";

import { summarizeCost } from "../matching/cost";
import type { CostSummary, PriceTable, UsageMeter } from "../matching/cost";
import type { CaseKind, CatalogNeed, LabeledSubmission } from "../matching/dataset";
import { meanScore } from "../matching/grader";
import type { gatewayGrader, Grade } from "../matching/grader";
import {
  MAX_COST_PER_SIGNAL_USD,
  MAX_P95_LATENCY_MS,
  MIN_RUBRIC_SCORE,
  multiAskDetection,
  percentile,
  PRODUCT_TARGETS,
  scoreAt,
} from "../matching/metrics";
import type { CaseRun, ThresholdScore } from "../matching/metrics";
import { indexCatalog, mapLimit, runPipeline } from "../matching/pipeline";

import { isCounted } from "./checks";
import type { SignalKind, World } from "./format";
import { keywordFindability } from "./generate/leakage";

/**
 * The harder matching set (spec 004, task 07): `pnpm eval:crewday --component matching` runs
 * Signal's preview hot path over a Crewday world's signals against that world's needs, through
 * `evals/matching`'s pipeline, metrics, grader, and cost meter (not copies). `evals/matching`
 * stays the MVP kill criterion; this set lets matching quality move again.
 *
 * - Catalog: the world's hand-written need statements. Each signal is matched only against the
 *   needs that existed when it arrived: the backlog, plus every need an earlier counted signal
 *   raised (the leakage check's rule, `generate/leakage.ts`). Signals are grouped by that set and
 *   each group runs through `runPipeline` with the shared catalog index filtered to it.
 * - Expected: the signal's true needs that existed then (a split child not yet raised counts
 *   through its parent). None existed: a new need, and no match should be shown.
 * - Splits: by the main need's trap kind, and keyword-findable vs. needs meaning (signals whose
 *   true need existed; new-need signals are their own group).
 * Planted retries and validation failures are not matching cases (`isCounted`).
 */

export const EASY_SET_REFERENCE =
  "evals/matching (131 cases, 30-need catalog): precision@3 0.99, new-need recall 1.0 (spec 004 → Problem Statement)";

export interface CrewdayCase extends LabeledSubmission {
  findable: boolean | null;
  trap: string;
  worldKind: SignalKind;
}

interface CaseGroup {
  cases: CrewdayCase[];
  existing: string[];
}

const caseKind = (kind: SignalKind, expected: string[]): CaseKind => {
  if (kind === "multi_ask" || kind === "same_solution") return kind;
  return expected.length === 0 ? "new" : "paraphrase";
};

/** The world's labeled matching cases, grouped by the needs that existed when each arrived. */
export const buildMatchingSet = (world: World) => {
  const catalog: CatalogNeed[] = world.needs.map(({ key, solutions, statement }) => ({
    key,
    solutions,
    statement,
  }));
  const needs = new Map(world.needs.map((need) => [need.key, need]));
  const parentOf = new Map(
    world.needs.flatMap((need) => (need.splitInto ?? []).map((child) => [child, need.key])),
  );
  const findability = keywordFindability(world).bySignal;
  const existing = new Set(world.needs.filter((need) => need.inBacklog).map((need) => need.key));
  const groups: CaseGroup[] = [];
  const signals = world.signals
    .filter(isCounted)
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const signal of signals) {
    const expected = [
      ...new Set(
        signal.labels.needKeys.flatMap((key) => {
          if (existing.has(key)) return [key];
          const parent = parentOf.get(key);
          return parent && existing.has(parent) ? [parent] : [];
        }),
      ),
    ];
    const [main = ""] = signal.labels.needKeys;
    const item: CrewdayCase = {
      body: signal.body,
      expected,
      findable: expected.length === 0 ? null : (findability.get(signal.id)?.findable ?? null),
      id: signal.id,
      kind: caseKind(signal.labels.kind, expected),
      title: signal.title,
      trap: needs.get(main)?.trap?.kind ?? "none",
      worldKind: signal.labels.kind,
    };
    const last = groups.at(-1);
    if (last && last.existing.length === existing.size) last.cases.push(item);
    else groups.push({ cases: [item], existing: [...existing] });
    for (const key of signal.labels.needKeys) existing.add(key);
  }
  return { cases: groups.flatMap((group) => group.cases), catalog, groups };
};

type StatementGrader = ReturnType<typeof gatewayGrader>;

export interface MatchingDeps {
  concurrency?: number;
  grader?: StatementGrader;
  /** First n cases only (smoke runs; never a result). */
  limit?: number | null;
  log?: (line: string) => void;
  ports: { embedder: Embedder; extractor: NeedExtractor; judge: MatchJudge };
  prices?: PriceTable;
  /** Live spend meter (AI SDK telemetry); omitted offline. */
  usage?: Pick<UsageMeter, "take">;
}

interface SliceScore extends ThresholdScore {
  cases: number;
  multiAskDetection: number | null;
}

export interface MatchingComponentReport {
  byFindable: Record<"keyword_findable" | "needs_meaning" | "new_need", SliceScore>;
  byTrap: Record<string, SliceScore>;
  cases: number;
  catalog: number;
  cost: { grader: CostSummary | null; perSignalUsd: number | null; pipeline: CostSummary | null };
  easySet: string;
  errors: number;
  graderModel: string | null;
  latency: { p50: number | null; p95: number | null };
  limit: number | null;
  overall: SliceScore;
  rubric: number | null;
  runs: (CaseRun & { findable: boolean | null; grade?: Grade; trap: string })[];
  schema: "crewday-matching@1";
  threshold: number;
}

const slice = (runs: CaseRun[]): SliceScore => ({
  ...scoreAt(runs, MATCH_THRESHOLD),
  cases: runs.length,
  multiAskDetection: multiAskDetection(runs),
});

export const runMatchingComponent = async (
  world: World,
  deps: MatchingDeps,
): Promise<MatchingComponentReport> => {
  const log = deps.log ?? console.log;
  const { catalog, groups } = buildMatchingSet(world);
  const limit = deps.limit ?? null;
  let budget = limit ?? Number.POSITIVE_INFINITY;
  const limited = groups.flatMap((group) => {
    const cases = group.cases.slice(0, Math.max(0, budget));
    budget -= cases.length;
    return cases.length ? [{ ...group, cases }] : [];
  });
  const total = limited.reduce((sum, group) => sum + group.cases.length, 0);
  log(
    `[eval:crewday] matching component: ${total} signals, ${catalog.length} catalog needs, ${limited.length} catalog snapshots; threshold ${MATCH_THRESHOLD}${limit ? `; SMOKE first ${limit}` : ""}`,
  );
  const index = await indexCatalog(catalog, deps.ports.embedder);
  deps.usage?.take();
  const concurrency = deps.concurrency ?? 4;
  let done = 0;
  const grouped = await mapLimit(limited, 2, (group) => {
    const existing = new Set(group.existing);
    return runPipeline({
      catalog,
      concurrency,
      index: index.filter((need) => existing.has(need.needId)),
      onCase: () => {
        done += 1;
        if (done % 50 === 0 || done === total) log(`  ${done}/${total}`);
      },
      ports: deps.ports,
      submissions: group.cases,
    });
  });
  const pipelineCalls = deps.usage?.take();
  const cases = limited.flatMap((group) => group.cases);
  const runs = grouped.flat();
  const caseOf = new Map(cases.map((item) => [item.id, item]));

  let grades: (Grade | undefined)[] = [];
  if (deps.grader) {
    const { grader } = deps;
    log(`[eval:crewday] grading drafted need statements with ${grader.model}`);
    grades = await mapLimit(runs, concurrency, async (run) => {
      const item = caseOf.get(run.caseId);
      if (!item || run.draftStatement === undefined) return;
      try {
        return await grader.grade({ ...item, statement: run.draftStatement });
      } catch {
        // An ungraded draft is left out of the rubric mean.
      }
    });
  }
  const graderCalls = deps.usage?.take();
  const prices = deps.prices ?? {};
  const pipeline = pipelineCalls ? summarizeCost(pipelineCalls, prices) : null;

  const where = (keep: (item: CrewdayCase) => boolean) =>
    runs.filter((run) => {
      const item = caseOf.get(run.caseId);
      return item ? keep(item) : false;
    });
  const traps = [...new Set(cases.map((item) => item.trap))].toSorted();
  const latencies = runs.filter((run) => !run.error).map((run) => run.latencyMs);
  return {
    byFindable: {
      keyword_findable: slice(where((item) => item.findable === true)),
      needs_meaning: slice(where((item) => item.findable === false)),
      new_need: slice(where((item) => item.expected.length === 0)),
    },
    byTrap: Object.fromEntries(traps.map((trap) => [trap, slice(where((i) => i.trap === trap))])),
    cases: runs.length,
    catalog: catalog.length,
    cost: {
      grader: graderCalls && deps.grader ? summarizeCost(graderCalls, prices) : null,
      perSignalUsd: pipeline && runs.length ? pipeline.totalUsd / runs.length : null,
      pipeline,
    },
    easySet: EASY_SET_REFERENCE,
    errors: runs.filter((run) => run.error).length,
    graderModel: deps.grader?.model ?? null,
    latency: { p50: percentile(latencies, 50) ?? null, p95: percentile(latencies, 95) ?? null },
    limit,
    overall: slice(runs),
    rubric: meanScore(grades),
    runs: runs.map((run, position) => {
      const item = caseOf.get(run.caseId);
      return {
        ...run,
        findable: item?.findable ?? null,
        trap: item?.trap ?? "none",
        ...(grades[position] ? { grade: grades[position] } : {}),
      };
    }),
    schema: "crewday-matching@1",
    threshold: MATCH_THRESHOLD,
  };
};

const pct = (value: number | null) => (value === null ? "  n/a" : `${(value * 100).toFixed(1)}%`);

const sliceLine = (label: string, s: SliceScore) =>
  `  ${label.padEnd(18)}${String(s.cases).padStart(5)}  ${pct(s.precisionAt3).padStart(6)}  ${pct(s.falseMatchRate).padStart(6)}  ${pct(s.newNeedRecall).padStart(6)}  ${pct(s.matchRecallAt3).padStart(6)}  ${pct(s.multiAskDetection).padStart(6)}`;

export const renderMatching = (report: MatchingComponentReport, world: string): string[] => [
  `Crewday matching set: world ${world}, ${report.cases} signals against ${report.catalog} needs, threshold ${report.threshold}${report.limit ? ` (SMOKE: first ${report.limit}; never a result)` : ""}`,
  `Easy set for comparison: ${report.easySet}`,
  `Targets: precision@3 ≥ ${PRODUCT_TARGETS.minPrecisionAt3}, false-match ≤ ${PRODUCT_TARGETS.maxFalseMatchRate}, new-need recall ≥ ${PRODUCT_TARGETS.minNewNeedRecall}, rubric ≥ ${MIN_RUBRIC_SCORE}`,
  "",
  `  ${"Slice".padEnd(18)}${"cases".padStart(5)}  ${"prec@3".padStart(6)}  ${"false".padStart(6)}  ${"newrec".padStart(6)}  ${"match".padStart(6)}  ${"multi".padStart(6)}`,
  sliceLine("overall", report.overall),
  "  by trap kind (main need):",
  ...Object.entries(report.byTrap).map(([trap, s]) => sliceLine(`  ${trap}`, s)),
  "  by keyword findability:",
  sliceLine("  keyword-findable", report.byFindable.keyword_findable),
  sliceLine("  needs meaning", report.byFindable.needs_meaning),
  sliceLine("  new need", report.byFindable.new_need),
  "",
  `Need-statement rubric: ${report.rubric === null ? "n/a (not graded)" : `${report.rubric.toFixed(2)}/5`}`,
  `Latency p50/p95: ${report.latency.p50 === null ? "n/a" : Math.round(report.latency.p50)} / ${report.latency.p95 === null ? "n/a" : Math.round(report.latency.p95)} ms (guardrail ≤ ${MAX_P95_LATENCY_MS} ms)`,
  `Cost per signal: ${report.cost.perSignalUsd === null ? "not metered" : `$${report.cost.perSignalUsd.toFixed(5)}`} (guardrail ≤ $${MAX_COST_PER_SIGNAL_USD})${report.cost.grader ? `; grader $${report.cost.grader.totalUsd.toFixed(4)}` : ""}`,
  `${report.errors} signals failed (counted as no match shown).`,
];
