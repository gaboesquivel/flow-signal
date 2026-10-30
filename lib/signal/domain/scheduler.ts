/**
 * How off-hot-path work (suggestion generation, readiness checks, automatic decision briefs)
 * is scheduled. Framework-free: Next.js route handlers install `after()` through
 * `lib/signal/next.ts`; the test database harness installs a recorder.
 */

export type SuggestionScheduler = (task: () => Promise<unknown>) => void;

/**
 * Default: start the task now without awaiting it (scripts, Eve agents). Next.js route handlers
 * install `after()` through `lib/signal/next.ts`, so this module stays framework-free and the Eve
 * agent bundles can load it.
 */
export const startNow: SuggestionScheduler = (task) => {
  void task().catch(() => null);
};

let scheduler: SuggestionScheduler = startNow;

/**
 * Swaps how generation is scheduled. The test database harness installs a recorder so parity
 * stays deterministic (nothing runs in the background); `resetSuggestionScheduler` restores
 * the default.
 */
export const configureSuggestionScheduler = (next: SuggestionScheduler) => {
  scheduler = next;
};
export const resetSuggestionScheduler = () => {
  scheduler = startNow;
};

/** Runs `task` with the configured scheduler (`after()` in route handlers): never on the hot path. */
export const scheduleOffHotPath: SuggestionScheduler = (task) => {
  scheduler(task);
};
