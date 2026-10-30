import type { Clock } from "@/lib/signal/context";

/**
 * Simulated time. The engine sets the world time before each step; every `now()` after that
 * returns it plus one more millisecond, so writes within a step keep a strict, repeatable order
 * (rows created "at the same time" would otherwise be ordered by random ids).
 */
export interface SimClock extends Clock {
  set: (at: Date) => void;
  /** The current step's world time, without advancing. */
  current: () => Date;
}

export const createSimClock = (start: Date): SimClock => {
  let base = start.getTime();
  let tick = 0;
  return {
    current: () => new Date(base),
    now: () => {
      tick += 1;
      return new Date(base + tick);
    },
    set: (at) => {
      base = at.getTime();
      tick = 0;
    },
  };
};
