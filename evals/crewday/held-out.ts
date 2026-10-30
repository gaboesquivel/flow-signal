/**
 * The held-out capability (spec 004 → Testing Decisions: "Tuning entry points cannot read
 * `worlds/test/`"). `loadWorld("test", …)` and `loadRecipe("test", …)` refuse to read the test
 * world without this exact symbol. Only tagged and acceptance entry points may import it; the
 * guard test in `tests/evals/crewday-world.test.ts` fails when any other file under
 * `evals/crewday/` mentions it or the test world's paths. Never re-export it.
 */
export const HELD_OUT: unique symbol = Symbol("crewday held-out test world");
export type HeldOut = typeof HELD_OUT;
