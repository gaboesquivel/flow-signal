import { after } from "next/server";

import { configureSuggestionScheduler } from "./domain/suggestion-generation";

/**
 * The only place Signal touches Next.js. Route handlers import this module once, so suggestion
 * generation after a submit runs with `after()` and never delays the response. Eve agents and
 * scripts don't import it and start generation immediately instead.
 */
configureSuggestionScheduler((task) => {
  try {
    after(task);
  } catch {
    void task().catch(() => null);
  }
});
