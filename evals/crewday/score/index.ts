/** The Crewday scorer's public API (spec 004, task 03). */
export { compareArms } from "./compare";
export type { Comparison, Criterion } from "./compare";
export { recomputePrevention } from "./recompute";
export { NOT_MEASURED, scoreRun, spearman } from "./score";
export type { ArmScore, ScoredValue } from "./score";
