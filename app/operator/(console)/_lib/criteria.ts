import type { CriterionKey } from "./console";
import { criterionKeys } from "./console";

/**
 * Criteria weights and the live re-rank preview (spec 006 task 07). Weights are edited in whole
 * hundredths so "sums to 1.00" is exact integer arithmetic; set_criteria gets them back as
 * decimals. A need's score is the weighted sum of its 0–5 criterion scores (a criterion without a
 * score counts as 0), rounded to 0.01, exactly as the server computes it.
 */

export type Weights = Record<CriterionKey, number>;
export type Hundredths = Record<CriterionKey, number>;
export type CriterionScores = Record<CriterionKey, number | null>;

const mapKeys = (fn: (key: CriterionKey) => number) =>
  Object.fromEntries(criterionKeys.map((key) => [key, fn(key)])) as Record<CriterionKey, number>;

export const toHundredths = (weights: Weights): Hundredths =>
  mapKeys((key) => Math.round(weights[key] * 100));

export const fromHundredths = (hundredths: Hundredths): Weights =>
  mapKeys((key) => hundredths[key] / 100);

export const sumHundredths = (hundredths: Hundredths) =>
  criterionKeys.reduce((sum, key) => sum + hundredths[key], 0);

export const sameWeights = (left: Hundredths, right: Hundredths) =>
  criterionKeys.every((key) => left[key] === right[key]);

/** Save needs a change and a total of exactly 1.00 (the set_criteria rule). */
export const saveState = (draft: Hundredths, saved: Hundredths) => {
  const total = sumHundredths(draft);
  const changed = !sameWeights(draft, saved);
  return { canSave: changed && total === 100, changed, total };
};

/**
 * Brings the total back to 1.00 by scaling the other three weights, keeping `kept` as set.
 * Any rounding remainder goes to the largest of the others.
 */
export const balanceOthers = (draft: Hundredths, kept: CriterionKey): Hundredths => {
  const fixed = Math.min(Math.max(draft[kept], 0), 100);
  const others = criterionKeys.filter((key) => key !== kept);
  const rest = 100 - fixed;
  const current = others.reduce((sum, key) => sum + draft[key], 0);
  const next = { ...draft, [kept]: fixed } as Hundredths;
  for (const key of others)
    next[key] =
      current > 0 ? Math.round((draft[key] * rest) / current) : Math.round(rest / others.length);
  const remainder = 100 - sumHundredths(next);
  if (remainder !== 0) {
    const [largest] = others.toSorted((left, right) => next[right] - next[left]);
    if (largest) next[largest] = Math.max(0, next[largest] + remainder);
  }
  return next;
};

/** The priority score under `weights`; null for an unscored need. */
export const scoreWith = (scores: CriterionScores | null, weights: Hundredths): number | null => {
  if (!scores) return null;
  const total = criterionKeys.reduce((sum, key) => sum + (scores[key] ?? 0) * weights[key], 0);
  return Math.round(total) / 100;
};

export interface PreviewNeed {
  criterionScores: CriterionScores | null;
  id: string;
  people: number;
  statement: string;
}

export interface PreviewRow {
  after: number;
  before: number;
  id: string;
  /** Places moved: positive is up, negative down. */
  move: number;
  rank: number;
  statement: string;
}

const rank = (needs: readonly PreviewNeed[], weights: Hundredths) =>
  needs
    .map((need) => ({ need, score: scoreWith(need.criterionScores, weights) ?? 0 }))
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.need.people - left.need.people ||
        left.need.id.localeCompare(right.need.id),
    );

/**
 * Scored needs ranked under the draft weights, each with its score and place under the saved
 * weights. Unscored needs never move (they rank below every scored need), so they are counted.
 */
export const rerankPreview = (
  needs: readonly PreviewNeed[],
  saved: Hundredths,
  draft: Hundredths,
): { rows: PreviewRow[]; unscored: number } => {
  const scored = needs.filter((need) => need.criterionScores !== null);
  const before = new Map(
    rank(scored, saved).map((entry, index) => [entry.need.id, { index, score: entry.score }]),
  );
  const rows = rank(scored, draft).map((entry, index) => {
    const previous = before.get(entry.need.id) ?? { index, score: entry.score };
    return {
      after: entry.score,
      before: previous.score,
      id: entry.need.id,
      move: previous.index - index,
      rank: index + 1,
      statement: entry.need.statement,
    };
  });
  return { rows, unscored: needs.length - scored.length };
};

export const formatWeight = (hundredths: number) => (hundredths / 100).toFixed(2);
