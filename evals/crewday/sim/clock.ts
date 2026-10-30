import { AsyncLocalStorage } from "node:async_hooks";

import type { Clock } from "@/lib/signal/context";

/**
 * Simulated time. The engine sets the world time before each step; every `now()` after that
 * returns it plus one more millisecond, so writes within a step keep a strict, repeatable order
 * (rows created "at the same time" would otherwise be ordered by random ids).
 *
 * Background work (suggestion generation overlapping later submissions) runs inside `fork()`:
 * it keeps the world time it was started at and its own millisecond counter, so the engine
 * moving on to the next signal neither re-stamps it nor shifts the replay's own timestamps.
 */
export interface SimClock extends Clock {
  set: (at: Date) => void;
  /** The current step's world time, without advancing. */
  current: () => Date;
  /**
   * Captures the time now (in this async context) and returns a runner that executes its body
   * at that time, ticking on from there independently of `set`.
   */
  fork: () => <T>(body: () => Promise<T>) => Promise<T>;
}

interface Step {
  base: number;
  tick: number;
}

export const createSimClock = (start: Date): SimClock => {
  const main: Step = { base: start.getTime(), tick: 0 };
  const scope = new AsyncLocalStorage<Step>();
  const step = () => scope.getStore() ?? main;
  return {
    current: () => new Date(step().base),
    fork: () => {
      const { base, tick } = step();
      return (body) => scope.run({ base, tick }, body);
    },
    now: () => {
      const at = step();
      at.tick += 1;
      return new Date(at.base + at.tick);
    },
    set: (at) => {
      main.base = at.getTime();
      main.tick = 0;
    },
  };
};
