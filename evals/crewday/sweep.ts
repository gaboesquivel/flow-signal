import type { CrewdayReport } from "./report";
import type { PolicyParams } from "./sim";

/**
 * The behaviour sweep (spec 004 → Open assumptions: "the sweep bounds them"; task 05). The policy
 * defaults are hypotheses, so `--sweep` reruns both arms over a grid of submitter and PM behaviour
 * and reports every success criterion per cell, then how robust each conclusion is:
 *
 * - "holds across the grid": passes in every cell that measured it.
 * - "holds only at the defaults": passes at the defaults, fails in at least one other cell.
 * - "fails at the defaults": does not pass at the defaults.
 * - "not measured": no cell judged it (e.g. spend offline or under `--cached`).
 *
 * The grid is one-at-a-time: the defaults, then each behaviour parameter moved low and high with
 * the rest at their defaults. A full factorial would be hundreds of year-long replays.
 */

export interface SweepCell {
  id: string;
  /** Policy parameters that differ from the defaults (empty for the defaults cell). */
  overrides: Partial<PolicyParams>;
}

const vary = <K extends keyof PolicyParams>(key: K, values: PolicyParams[K][]): SweepCell[] =>
  values.map((value) => ({ id: `${key}=${String(value)}`, overrides: { [key]: value } }));

export const DEFAULT_CELL: SweepCell = { id: "defaults", overrides: {} };

export const SWEEP_GRID: SweepCell[] = [
  DEFAULT_CELL,
  ...vary("pAttach", [0.6, 0.95]),
  ...vary("pWrong", [0, 0.2]),
  ...vary("pmActions", [30, 120]),
  ...vary("pPmError", [0, 0.1]),
  ...vary("pManualFind", [0.15, 0.5]),
];

type Verdict = "PASS" | "FAIL" | "n.a.";
export type Robustness =
  | "holds across the grid"
  | "holds only at the defaults"
  | "fails at the defaults"
  | "not measured";

export interface SweepCellResult {
  cell: SweepCell;
  /** Criterion name → verdict, in the report's order. */
  criteria: { detail: string; name: string; verdict: Verdict }[];
  killSignal: boolean | null;
}

export interface CriterionRobustness {
  atDefaults: Verdict;
  /** Cells (other than the defaults) where the criterion failed. */
  failingCells: string[];
  fails: number;
  name: string;
  passes: number;
  robustness: Robustness;
}

export const cellResult = (cell: SweepCell, report: CrewdayReport): SweepCellResult => ({
  cell,
  criteria: report.table.flatMap((row) =>
    row.criterion
      ? [{ detail: row.criterion.detail, name: row.criterion.name, verdict: row.criterion.verdict }]
      : [],
  ),
  killSignal: report.comparison?.killSignal ?? null,
});

export const summarizeSweep = (results: SweepCellResult[]): CriterionRobustness[] => {
  const defaults = results.find((result) => result.cell.id === DEFAULT_CELL.id) ?? results[0];
  const names = [...new Set(results.flatMap((r) => r.criteria.map((c) => c.name)))];
  return names.map((name) => {
    const verdictIn = (result: SweepCellResult | undefined): Verdict =>
      result?.criteria.find((c) => c.name === name)?.verdict ?? "n.a.";
    const verdicts = results.map((result) => ({ id: result.cell.id, verdict: verdictIn(result) }));
    const passes = verdicts.filter((v) => v.verdict === "PASS").length;
    const failing = verdicts.filter((v) => v.verdict === "FAIL");
    const atDefaults = verdictIn(defaults);
    let robustness: Robustness = "fails at the defaults";
    if (passes + failing.length === 0) robustness = "not measured";
    else if (atDefaults === "PASS")
      robustness = failing.length === 0 ? "holds across the grid" : "holds only at the defaults";
    return {
      atDefaults,
      failingCells: failing.map((v) => v.id).filter((id) => id !== defaults?.cell.id),
      fails: failing.length,
      name,
      passes,
      robustness,
    };
  });
};

export interface SweepReport {
  cells: (SweepCellResult & { report: string })[];
  defaults: PolicyParams;
  ranAt: string;
  robustness: CriterionRobustness[];
  schema: "crewday-sweep@1";
  world: CrewdayReport["world"];
}

/** Terminal lines: one verdict column per cell, then each criterion's robustness label. */
export const renderSweep = (sweep: SweepReport): string[] => {
  const ids = sweep.cells.map((c) => c.cell.id);
  const width = Math.max(8, ...ids.map((id) => id.length + 2));
  const lines = [
    `Behaviour sweep: world ${sweep.world.name}@${sweep.world.version}, ${sweep.cells.length} cells (one parameter moved per cell; the rest at the defaults)`,
    "",
    `${"Criterion".padEnd(26)}${ids.map((id) => id.padEnd(width)).join("")}`,
  ];
  for (const { name } of sweep.robustness)
    lines.push(
      `${name.padEnd(26)}${sweep.cells
        .map((c) => (c.criteria.find((x) => x.name === name)?.verdict ?? "n.a.").padEnd(width))
        .join("")}`,
    );
  lines.push("", "Robustness:");
  for (const r of sweep.robustness)
    lines.push(
      `  ${r.name.padEnd(26)}${r.robustness}${r.failingCells.length ? ` (fails at ${r.failingCells.join(", ")})` : ""}`,
    );
  return lines;
};
