import { createRng } from "../sim/rng";

/**
 * 95% bootstrap intervals that resample **needs** (spec 004 → Metrics reported: 1,000 resamples).
 * A metric reports its per-need contributions; a resample draws the world's true needs with
 * replacement and recomputes the metric from the drawn needs' contributions. Two arms compared
 * with the same seed draw the same needs, so their difference has a paired interval.
 */

export const RESAMPLES = 1000;

export type Interval = [number, number];

/** A ratio's numerator and denominator from one true need. */
export interface Part {
  den: number;
  num: number;
}

export type PerNeed = Record<string, Part>;

/** Draws `resamples` lists of keys, each the size of `keys`, with replacement. */
export const drawSamples = (keys: string[], seed: number, resamples = RESAMPLES) => {
  const rng = createRng(seed);
  return Array.from({ length: resamples }, () =>
    Array.from({ length: keys.length }, () => keys[rng.int(keys.length)] ?? ""),
  );
};

export const ratioOf = (perNeed: PerNeed, keys: Iterable<string>) => {
  let num = 0;
  let den = 0;
  for (const key of keys) {
    const part = perNeed[key];
    if (!part) continue;
    num += part.num;
    den += part.den;
  }
  return den === 0 ? null : num / den;
};

const quantile = (sorted: number[], q: number) => {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  // Infinite values (a ratio over a zero board) stay infinite instead of becoming NaN.
  if (a === b || position === low) return a;
  return a + (b - a) * (position - low);
};

/**
 * The 2.5th and 97.5th percentiles of the defined statistics (±∞ kept: a resample where the board
 * scores 0 and Signal does not is a ratio of +∞, which clears any bar), or null when none are.
 */
export const percentileInterval = (values: (number | null)[]): Interval | null => {
  const finite = values
    .filter((value): value is number => value !== null && !Number.isNaN(value))
    .toSorted((a, b) => a - b);
  if (finite.length === 0) return null;
  return [quantile(finite, 0.025), quantile(finite, 0.975)];
};

/** Interval of any statistic over resampled need keys. */
export const bootstrap = (
  samples: string[][],
  statistic: (keys: string[]) => number | null,
): Interval | null => percentileInterval(samples.map(statistic));
