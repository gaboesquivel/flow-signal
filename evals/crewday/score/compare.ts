import { bootstrap, drawSamples, ratioOf } from "./bootstrap";
import type { Interval, PerNeed } from "./bootstrap";
import type { ArmScore, ScoredValue } from "./score";

/**
 * Signal vs. the vote board (spec 004 → Success criteria). Differences and ratios between the
 * arms get paired intervals: both arms' per-need parts are resampled with the same drawn needs.
 * A criterion passes only when its whole 95% interval clears the bar; one with no interval (a
 * point-only metric) is judged on its estimate and says so; one with nothing to measure is
 * `pass: null`.
 */

export interface Criterion {
  bar: string;
  /** The interval (or estimate) the verdict reads. */
  ci: Interval | null;
  detail: string;
  name: string;
  /** null: not measured in this run (e.g. offline spend, or a fixture world). */
  pass: boolean | null;
  pointOnly: boolean;
  value: number | null;
}

export interface Comparison {
  /** The policy parameters both arms ran with (including `handBriefActions`), for the report. */
  assumptions: ArmScore["policy"];
  board: ArmScore;
  criteria: Criterion[];
  /** Spec 004 → Outcome kill signal: Signal does not beat the board on true prevention by 20 points. */
  killSignal: boolean;
  lift: {
    decisionQuality: { ci: Interval | null; value: number | null };
    revenueCoverageRatio: { ci: Interval | null; value: number | null };
    truePreventionRate: { ci: Interval | null; value: number | null };
  };
  signal: ArmScore;
}

const parts = (value: ScoredValue): PerNeed => value.perNeed ?? {};

const keysOf = (...values: ScoredValue[]) =>
  [...new Set(values.flatMap((value) => Object.keys(parts(value))))].toSorted();

const paired = (
  a: ScoredValue,
  b: ScoredValue,
  combine: (x: number, y: number) => number | null,
  samples: string[][],
) => {
  const stat = (keys: string[]) => {
    const x = ratioOf(parts(a), keys);
    const y = ratioOf(parts(b), keys);
    return x === null || y === null ? null : combine(x, y);
  };
  const all = keysOf(a, b);
  return { ci: bootstrap(samples, stat), value: stat(all) };
};

const difference = (x: number, y: number) => x - y;
const ratio = (x: number, y: number) => {
  if (y === 0) return x === 0 ? null : Number.POSITIVE_INFINITY;
  return x / y;
};

const fmt = (value: number | null) => {
  if (value === null) return "n/a";
  return Number.isFinite(value) ? value.toFixed(3) : "∞";
};

const intervalAtLeast = (ci: Interval | null, bar: number) => (ci ? ci[0] >= bar : null);
const intervalAtMost = (ci: Interval | null, bar: number) => (ci ? ci[1] <= bar : null);
/** All true; null when any part was not measured. */
const both = (...values: (boolean | null)[]) =>
  values.includes(null) ? null : values.every(Boolean);

export interface CompareOptions {
  resamples?: number;
  seed?: number;
}

export const compareArms = (
  signal: ArmScore,
  board: ArmScore,
  { resamples, seed = signal.seed }: CompareOptions = {},
): Comparison => {
  const keys = keysOf(
    signal.headline.truePreventionRate,
    board.headline.truePreventionRate,
    signal.headline.decisionQuality,
    board.headline.decisionQuality,
    signal.headline.revenueCoverage,
    board.headline.revenueCoverage,
  );
  const samples = drawSamples(keys, seed, resamples);
  const prevention = paired(
    signal.headline.truePreventionRate,
    board.headline.truePreventionRate,
    difference,
    samples,
  );
  const quality = paired(
    signal.headline.decisionQuality,
    board.headline.decisionQuality,
    difference,
    samples,
  );
  const coverage = paired(
    signal.headline.revenueCoverage,
    board.headline.revenueCoverage,
    ratio,
    samples,
  );

  const organizing = signal.headline.pmOrganizingShare.value;
  const boardOrganizing = board.headline.pmOrganizingShare.value;
  const acceptance = signal.product.suggestionAcceptance.overall;
  const precision = signal.product.suggestionAcceptance.acceptancePrecision;
  const falseAttach = signal.diagnostics.falseAttachRate;
  const unmerge = signal.diagnostics.unmergeRate.value ?? 0;
  const leaks = signal.diagnostics.piiScan.generated.leaks.length;
  const approvedLeaks = signal.diagnostics.piiScan.leaks.length;
  const spend = signal.diagnostics.modelSpendPerSignalUsd;
  const findable = signal.diagnostics.keywordFindableShare;

  const criteria: Criterion[] = [
    {
      bar: "≥ +0.20 over the board",
      ci: prevention.ci,
      detail: `Signal − board = ${fmt(prevention.value)}`,
      name: "true_prevention_lift",
      pass: intervalAtLeast(prevention.ci, 0.2),
      pointOnly: false,
      value: prevention.value,
    },
    {
      bar: "≥ 0.85 and not more than 0.05 below the board (non-inferiority)",
      ci: signal.headline.decisionQuality.ci,
      detail: `Signal ${fmt(signal.headline.decisionQuality.value)}, Signal − board ${fmt(quality.value)} (interval ${quality.ci ? quality.ci.map(fmt).join("–") : "n/a"})`,
      name: "decision_quality",
      pass: both(
        intervalAtLeast(signal.headline.decisionQuality.ci, 0.85),
        intervalAtLeast(quality.ci, -0.05),
      ),
      pointOnly: false,
      value: signal.headline.decisionQuality.value,
    },
    {
      bar: "≥ 1.5× the board",
      ci: coverage.ci,
      detail: `Signal ÷ board = ${fmt(coverage.value)}`,
      name: "revenue_coverage_ratio",
      pass: intervalAtLeast(coverage.ci, 1.5),
      pointOnly: false,
      value: coverage.value,
    },
    {
      bar: "≤ half the board's",
      ci: null,
      detail: `Signal ${fmt(organizing)}, board ${fmt(boardOrganizing)} (actions do not split by need: point estimate)`,
      name: "pm_organizing_share",
      pass:
        organizing === null || boardOrganizing === null ? null : organizing <= boardOrganizing / 2,
      pointOnly: true,
      value: organizing,
    },
    {
      bar: "acceptance ≥ 0.70 with precision ≥ 0.95",
      ci: precision.ci,
      detail: `acceptance ${fmt(acceptance)} (get_metrics, point), precision ${fmt(precision.value)}`,
      name: "suggestion_acceptance",
      pass: both(
        acceptance === null ? null : acceptance >= 0.7,
        intervalAtLeast(precision.ci, 0.95),
      ),
      // The acceptance rate is a point estimate (get_metrics); only precision has an interval.
      pointOnly: true,
      value: acceptance,
    },
    {
      bar: "≤ 0.05",
      ci: falseAttach.ci,
      detail: `Signal ${fmt(falseAttach.value)}`,
      name: "false_attach_rate",
      pass: intervalAtMost(falseAttach.ci, 0.05),
      pointOnly: false,
      value: falseAttach.value,
    },
    {
      bar: "< 0.05",
      ci: null,
      detail: `${signal.diagnostics.unmergeRate.undone} of ${signal.diagnostics.unmergeRate.merges} merges undone`,
      name: "unmerge_rate",
      pass: unmerge < 0.05,
      pointOnly: true,
      value: unmerge,
    },
    {
      bar: "0 planted PII in generated public summaries",
      ci: null,
      detail: `${leaks} leak(s) in ${signal.diagnostics.piiScan.generated.summariesChecked} generated summaries; ${approvedLeaks} in ${signal.diagnostics.piiScan.summariesChecked} approved`,
      name: "planted_pii",
      pass: leaks === 0,
      pointOnly: true,
      value: leaks,
    },
    {
      bar: "≤ $0.01 per signal",
      ci: null,
      detail: spend === null ? "not measured (no usage meter)" : `$${spend.toFixed(4)} per signal`,
      name: "model_spend_per_signal",
      pass: spend === null ? null : spend <= 0.01,
      pointOnly: true,
      value: spend,
    },
    {
      bar: "≤ 0.60",
      ci: null,
      detail: findable === null ? "not measured for this world" : `${fmt(findable)}`,
      name: "keyword_findable_share",
      pass: findable === null ? null : findable <= 0.6,
      pointOnly: true,
      value: findable,
    },
  ];

  return {
    assumptions: signal.policy,
    board,
    criteria,
    killSignal: criteria[0]?.pass !== true,
    lift: {
      decisionQuality: quality,
      revenueCoverageRatio: coverage,
      truePreventionRate: prevention,
    },
    signal,
  };
};
