import { chooseMatches } from "@/lib/signal/domain/matching";

import type { CaseKind } from "./dataset";

/**
 * Matching eval metrics (PRODUCT.md → AI quality). Pure: they read recorded runs, so one live run
 * scores every threshold in a sweep without calling a model again.
 *
 * Definitions, at a judge threshold t (matches shown = `chooseMatches`, at most 3):
 * - precision@3: of all matches shown across the set, the share that are a correct need.
 *   Undefined (null) when nothing is shown.
 * - false-match rate: of all submissions, the share shown at least one wrong need.
 * - new-need recall: of submissions labeled new (`expected` empty), the share shown no match.
 * - match recall@3 (diagnostic, the tuning objective): of submissions with a catalog need, the
 *   share where a correct need is shown.
 * - multi-ask detection (diagnostic): of multi-ask submissions, the share whose draft has an
 *   additional ask. Independent of t.
 * A submission whose pipeline failed counts as showing no match (preview degrades that way).
 */

export interface RecordedJudgement {
  needId: string;
  probability: number;
  reason: string;
}

export interface CaseRun {
  additionalAsks: string[];
  /** Retrieved candidates with their similarity (needId is the catalog key). */
  candidates: { needId: string; similarity: number }[];
  caseId: string;
  draftStatement?: string;
  error?: string;
  expected: string[];
  judgements: RecordedJudgement[];
  kind: CaseKind;
  /** Wall time of extract → embed → retrieve → judge for this submission. */
  latencyMs: number;
}

export interface ThresholdScore {
  correctShown: number;
  falseMatchRate: number;
  matchRecallAt3: number | null;
  newNeedRecall: number | null;
  precisionAt3: number | null;
  shown: number;
  threshold: number;
}

interface Targets {
  maxFalseMatchRate: number;
  minNewNeedRecall: number;
  minPrecisionAt3: number;
}

/** PRODUCT.md → Success metrics → AI quality, and the guardrails. */
export const PRODUCT_TARGETS: Targets = {
  maxFalseMatchRate: 0.05,
  minNewNeedRecall: 0.9,
  minPrecisionAt3: 0.9,
};
export const MIN_RUBRIC_SCORE = 4;
export const MAX_P95_LATENCY_MS = 2000;
export const MAX_COST_PER_SIGNAL_USD = 0.01;

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export const shownMatches = (run: CaseRun, threshold: number) =>
  run.error
    ? []
    : chooseMatches({ candidates: run.candidates, judgements: run.judgements, threshold });

export const scoreAt = (runs: CaseRun[], threshold: number): ThresholdScore => {
  let shown = 0;
  let correctShown = 0;
  let withWrong = 0;
  let newCases = 0;
  let newClean = 0;
  let existingCases = 0;
  let existingHit = 0;
  for (const run of runs) {
    const matches = shownMatches(run, threshold);
    const correct = matches.filter((match) => run.expected.includes(match.needId)).length;
    shown += matches.length;
    correctShown += correct;
    if (correct < matches.length) withWrong += 1;
    if (run.expected.length === 0) {
      newCases += 1;
      if (matches.length === 0) newClean += 1;
    } else {
      existingCases += 1;
      if (correct > 0) existingHit += 1;
    }
  }
  return {
    correctShown,
    falseMatchRate: runs.length === 0 ? 0 : withWrong / runs.length,
    matchRecallAt3: ratio(existingHit, existingCases),
    newNeedRecall: ratio(newClean, newCases),
    precisionAt3: ratio(correctShown, shown),
    shown,
    threshold,
  };
};

/** Every target met; an undefined precision (nothing shown) or recall does not meet its target. */
export const meetsTargets = (score: ThresholdScore, targets: Targets = PRODUCT_TARGETS) =>
  score.precisionAt3 !== null &&
  score.precisionAt3 >= targets.minPrecisionAt3 &&
  score.falseMatchRate <= targets.maxFalseMatchRate &&
  score.newNeedRecall !== null &&
  score.newNeedRecall >= targets.minNewNeedRecall;

/**
 * Worst shortfall against the targets, as a fraction of each target's allowed range (0 when
 * all are met, more negative is worse). Ranks thresholds when none meets every target.
 */
const targetSlack = (score: ThresholdScore, targets: Targets = PRODUCT_TARGETS) =>
  Math.min(
    0,
    ((score.precisionAt3 ?? 0) - targets.minPrecisionAt3) / targets.minPrecisionAt3,
    (targets.maxFalseMatchRate - score.falseMatchRate) / (1 - targets.maxFalseMatchRate),
    ((score.newNeedRecall ?? 0) - targets.minNewNeedRecall) / targets.minNewNeedRecall,
  );

/** Thresholds from `from` to `to` inclusive, rounded to avoid float drift (0.1 + 0.2 …). */
export const thresholdRange = (from: number, to: number, step: number) => {
  if (!(step > 0) || from > to) throw new Error("A sweep needs from ≤ to and a positive step.");
  const values: number[] = [];
  for (let index = 0; ; index += 1) {
    const value = Math.round((from + index * step) * 1e6) / 1e6;
    if (value > to + 1e-9) break;
    values.push(value);
  }
  return values;
};

export const sweep = (runs: CaseRun[], thresholds: number[]) =>
  thresholds.map((threshold) => scoreAt(runs, threshold));

interface BestThreshold {
  meetsTargets: boolean;
  score: ThresholdScore;
}

/**
 * Best threshold: among those meeting every target, the one that shows a correct match most
 * often (match recall@3), then the lower false-match rate, then the higher threshold. If none
 * meets the targets, the one with the smallest worst shortfall (then the same tie-breaks), so
 * the report says how far the set is from the kill criterion.
 */
export const pickBestThreshold = (
  scores: ThresholdScore[],
  targets: Targets = PRODUCT_TARGETS,
): BestThreshold | undefined => {
  const passing = scores.filter((score) => meetsTargets(score, targets));
  const pool = passing.length > 0 ? passing : scores;
  const [best] = pool.toSorted(
    (a, b) =>
      (passing.length > 0 ? 0 : targetSlack(b, targets) - targetSlack(a, targets)) ||
      (b.matchRecallAt3 ?? 0) - (a.matchRecallAt3 ?? 0) ||
      a.falseMatchRate - b.falseMatchRate ||
      b.threshold - a.threshold,
  );
  return best && { meetsTargets: passing.length > 0, score: best };
};

/** Nearest-rank percentile (p in 0–100); undefined for no values. */
export const percentile = (values: number[], p: number) => {
  if (values.length === 0) return;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

export const multiAskDetection = (runs: CaseRun[]) => {
  const multi = runs.filter((run) => run.kind === "multi_ask" && !run.error);
  return ratio(multi.filter((run) => run.additionalAsks.length > 0).length, multi.length);
};

/** Scores split by case kind (precision and false matches per kind), for the report. */
export const scoreByKind = (runs: CaseRun[], threshold: number) => {
  const kinds = [...new Set(runs.map((run) => run.kind))];
  return Object.fromEntries(
    kinds.map((kind) => [
      kind,
      scoreAt(
        runs.filter((run) => run.kind === kind),
        threshold,
      ),
    ]),
  ) as Record<CaseKind, ThresholdScore>;
};
