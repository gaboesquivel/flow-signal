import { themes } from "@/lib/db/schema";

import type { World } from "../format";
import type { PolicyParams } from "./policy";
import type { SimState } from "./state";

/**
 * The `set_strategy` input the engine writes at world start under `follows_signal` (spec 007 →
 * Crewday), from Crewday's strategy memo (`recipe/strategy.md`). A world carries the memo only
 * through its themes' `strategicWeight`, so:
 *
 * - **Focus themes:** themes with `strategicWeight ≥ FOCUS_WEIGHT`. In the recipe that is exactly
 *   the memo's two focus themes (`compliance` 1.0, `payroll-exports` 0.9); in the fixture world,
 *   `scheduling` (0.9). Mapped to the theme ids Signal stored for the world, by name.
 * - **Capacity:** the memo's 12 needs per quarter (no world file carries it).
 * - **Readiness:** the policy's `readinessArrCents` and no supporter line, so Signal marks a need
 *   ready exactly where spec 004's oracle PM would (distinct supporting accounts' ARR).
 * - **Revenue focus:** the memo's order (keep Enterprise, land up-market deals, then Growth).
 */

export const FOCUS_WEIGHT = 0.8;
export const CAPACITY_PER_QUARTER = 12;
export const REVENUE_FOCUS =
  "Keep Enterprise (gross churn under 8%), then land up-market Enterprise deals in healthcare staffing and logistics, then Growth expansion to Enterprise; Starter demand is a tie-breaker.";

export interface StrategyInput {
  [key: string]: unknown;
  capacityPerQuarter: number;
  focusThemeIds: string[];
  notes: string;
  readinessArrCents: number;
  readinessSupporters: number;
  revenueFocus: string;
}

/** The focus themes' names, highest weight first (ties by key). */
export const focusThemeNames = (world: World) =>
  world.themes
    .filter((theme) => theme.strategicWeight >= FOCUS_WEIGHT)
    .toSorted((a, b) => b.strategicWeight - a.strategicWeight || a.key.localeCompare(b.key))
    .map((theme) => theme.name);

export const strategyInputFor = (
  world: World,
  themeIds: Map<string, string>,
  policy: PolicyParams,
): StrategyInput => {
  const names = focusThemeNames(world);
  return {
    capacityPerQuarter: CAPACITY_PER_QUARTER,
    focusThemeIds: names.flatMap((name) => {
      const id = themeIds.get(name);
      return id ? [id] : [];
    }),
    notes: `Crewday strategy memo, adoption year. Focus: ${names.join(", ") || "none"}. Out of focus is planned only when it unblocks a churn-risk Enterprise account or an open Enterprise deal.`,
    readinessArrCents: policy.readinessArrCents,
    readinessSupporters: 0,
    revenueFocus: REVENUE_FOCUS,
  };
};

/** Writes the world's strategy through `set_strategy` (REST, as the PM); throws when refused. */
export const writeStrategy = async (state: SimState) => {
  const rows = await state.db.select({ id: themes.id, name: themes.name }).from(themes);
  const input = strategyInputFor(
    state.world,
    new Map(rows.map((row) => [row.name, row.id])),
    state.policy,
  );
  const result = await state.router.call("rest", "set_strategy", input);
  if (!result.ok) throw new Error(`set_strategy failed (${result.code}): ${result.message}`);
  state.log.strategy = input;
  return input;
};
