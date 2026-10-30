/**
 * Seeded randomness for the Crewday simulation (spec 004 → Reproducibility). Every random choice
 * a policy makes draws from a named stream derived from the run seed, so one policy's draws never
 * shift another's: adding a PM decision does not change which signals the submitter attaches.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next: () => number;
  /** True with probability `p`. */
  chance: (p: number) => boolean;
  /** Uniform integer in [0, n). */
  int: (n: number) => number;
}

/** 32-bit FNV-1a, to turn a stream name into a seed. */
const hashString = (text: string) => {
  let hash = 0x81_1c_9d_c5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
};

/** mulberry32: small, fast, and identical on every platform. */
export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    chance: (p) => next() < p,
    int: (n) => Math.floor(next() * n),
    next,
  };
};

/** An independent stream for `name` under the run seed. */
export const rngStream = (seed: number, name: string) =>
  createRng((hashString(name) ^ Math.imul(seed >>> 0, 0x9e_37_79_b1)) >>> 0);
