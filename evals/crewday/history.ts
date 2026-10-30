import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CrewdayReport, ReportRow } from "./report";
import type { Interval } from "./score/bootstrap";
import type { PolicyParams } from "./sim";

/**
 * Tagged runs and the regression rule (spec 004 → Reproducibility, history, and cost; task 06).
 *
 * A tagged run (`--tag <name>`, test world only, always live) repeats the replay with 3 seeds and
 * appends one entry to `history/tagged-runs.jsonl` (committed, append-only: one JSON object per
 * line, earlier lines are never rewritten). Per metric and series (Signal, board, lift) an entry
 * keeps:
 * - `value`: the mean of the repeats' point estimates;
 * - `ci`: the envelope of the repeats' 95% intervals (lowest lower bound to highest upper bound;
 *   a point-only metric contributes its estimates), so the interval spans both resampling noise
 *   and seed-to-seed variation.
 *
 * The rule: against the previous tagged run on the same world version, a metric is improved or
 * regressed only when the two intervals do not overlap (touching counts as overlap); otherwise it
 * is "no detectable change".
 */

export const HISTORY_FILE = path.join(import.meta.dirname, "history", "tagged-runs.jsonl");
export const TAGGED_REPEATS = 3;

export interface Estimate {
  ci: Interval;
  /** Repeats that measured the metric. */
  n: number;
  value: number;
}

type Series = "signal" | "board" | "lift";
const SERIES: Series[] = ["signal", "board", "lift"];

export interface HistoryEntry {
  /** Success-criterion verdicts, one per repeat. */
  criteria: Record<string, string[]>;
  gitSha: CrewdayReport["gitSha"];
  metrics: Record<string, Record<Series, Estimate | null>>;
  mode: CrewdayReport["mode"];
  models: CrewdayReport["models"];
  policy: PolicyParams;
  ranAt: string;
  schema: "crewday-history@1";
  seeds: number[];
  /** Model spend over all repeats (Signal's and the oracle's); null offline. */
  spendUsd: number | null;
  tag: string;
  world: { name: string; version: string };
}

const cellOf = (row: ReportRow, series: Series) =>
  series === "lift" ? (row.criterion?.lift ?? row.lift ?? null) : row[series];

/** Mean estimate and interval envelope of one metric over the repeats (null: never measured). */
export const aggregateCells = (
  cells: ({ ci: Interval | null; value: number | null } | null | undefined)[],
): Estimate | null => {
  const measured = cells.filter(
    (cell): cell is { ci: Interval | null; value: number } =>
      cell !== null &&
      cell !== undefined &&
      cell.value !== null &&
      Number.isFinite(cell.value) &&
      (cell.ci === null || cell.ci.every(Number.isFinite)),
  );
  if (measured.length === 0) return null;
  const lows = measured.map((cell) => cell.ci?.[0] ?? cell.value);
  const highs = measured.map((cell) => cell.ci?.[1] ?? cell.value);
  return {
    ci: [Math.min(...lows), Math.max(...highs)],
    n: measured.length,
    value: measured.reduce((sum, cell) => sum + cell.value, 0) / measured.length,
  };
};

/** One history entry from a tagged run's repeats (same world, policy, and models; seeds differ). */
export const historyEntry = (tag: string, reports: CrewdayReport[]): HistoryEntry => {
  const [first] = reports;
  if (!first) throw new Error("A tagged run needs at least one report.");
  const keys = [...new Set(reports.flatMap((report) => report.table.map((row) => row.key)))];
  const metrics = Object.fromEntries(
    keys.map((key) => {
      const rows = reports.map((report) => report.table.find((row) => row.key === key));
      const bySeries = Object.fromEntries(
        SERIES.map((series) => [
          series,
          aggregateCells(rows.map((row) => (row ? cellOf(row, series) : null))),
        ]),
      ) as Record<Series, Estimate | null>;
      return [key, bySeries];
    }),
  );
  const criteria: Record<string, string[]> = {};
  for (const report of reports)
    for (const row of report.table)
      if (row.criterion) (criteria[row.criterion.name] ??= []).push(row.criterion.verdict);
  const spends = reports.map((report) => report.spend.totalUsd);
  return {
    criteria,
    gitSha: first.gitSha,
    metrics,
    mode: first.mode,
    models: first.models,
    policy: first.policy,
    ranAt: new Date().toISOString(),
    schema: "crewday-history@1",
    seeds: reports.map((report) => report.seed),
    spendUsd: spends.includes(null) ? null : spends.reduce<number>((sum, s) => sum + (s ?? 0), 0),
    tag,
    world: { name: first.world.name, version: first.world.version },
  };
};

// ---- The history file ----

export const readHistory = async (file = HISTORY_FILE): Promise<HistoryEntry[]> => {
  let text = "";
  try {
    text = await readFile(file, "utf-8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as HistoryEntry);
};

/** Appends one entry as one line; never rewrites earlier lines. */
export const appendHistory = async (entry: HistoryEntry, file = HISTORY_FILE) => {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`);
};

/** The latest earlier entry on the same world and version, if any. */
export const previousEntry = (history: HistoryEntry[], world: HistoryEntry["world"]) =>
  history.findLast(
    (entry) => entry.world.name === world.name && entry.world.version === world.version,
  );

// ---- The regression rule ----

/** Metrics where a lower value is better; anything not listed or neutral is higher-is-better. */
const LOWER_IS_BETTER = new Set([
  "decision_latency_median_days",
  "false_attach_rate",
  "hidden_duplicate_rate",
  "model_spend_per_signal",
  "open_past_30_days",
  "planted_pii_leaks",
  "pm_organizing_share",
  "preview_latency_p50_ms",
  "preview_latency_p95_ms",
  "readiness_lead_time_days",
  "undecided_at_year_end",
  "unmerge_rate",
]);
/** Properties of the world or the harness, not of Signal: a change has no better direction. */
const NEUTRAL = new Set(["keyword_findable_share", "prevention_cross_check"]);

export type Change = "improved" | "regressed" | "changed" | "no detectable change";

export interface MetricChange {
  change: Change;
  current: Estimate;
  key: string;
  previous: Estimate;
  series: Series;
}

export interface HistoryComparison {
  /** Metrics measured in both runs, with their verdict. */
  changes: MetricChange[];
  previous: { gitSha: string | null; ranAt: string; tag: string };
}

/** Improved or regressed only when the intervals do not overlap (spec 004's rule). */
export const changeOf = (key: string, previous: Estimate, current: Estimate): Change => {
  const higher = current.ci[0] > previous.ci[1];
  const lower = current.ci[1] < previous.ci[0];
  if (!higher && !lower) return "no detectable change";
  if (NEUTRAL.has(key)) return "changed";
  return higher === LOWER_IS_BETTER.has(key) ? "regressed" : "improved";
};

export const compareEntries = (
  previous: HistoryEntry,
  current: HistoryEntry,
): HistoryComparison => {
  const changes: MetricChange[] = [];
  for (const [key, bySeries] of Object.entries(current.metrics))
    for (const series of SERIES) {
      const now = bySeries[series];
      const before = previous.metrics[key]?.[series];
      if (now && before)
        changes.push({
          change: changeOf(key, before, now),
          current: now,
          key,
          previous: before,
          series,
        });
    }
  return {
    changes,
    previous: { gitSha: previous.gitSha.sha, ranAt: previous.ranAt, tag: previous.tag },
  };
};

const fmt = (estimate: Estimate) =>
  `${estimate.value.toFixed(3)} [${estimate.ci[0].toFixed(3)}–${estimate.ci[1].toFixed(3)}]`;

/** Terminal lines: every improvement, regression, and direction-less change, then a count. */
export const renderComparison = (comparison: HistoryComparison | null, tag: string) => {
  if (comparison === null)
    return [
      `Tagged run ${tag}: no earlier tagged run on this world version (this is the baseline).`,
    ];
  const moved = comparison.changes.filter((c) => c.change !== "no detectable change");
  const { previous } = comparison;
  return [
    `Tagged run ${tag} vs. ${previous.tag} (${previous.ranAt.slice(0, 10)}, git ${previous.gitSha?.slice(0, 10) ?? "unknown"}): intervals that do not overlap.`,
    ...moved.map(
      (c) =>
        `  ${c.change.toUpperCase().padEnd(10)}${`${c.key} (${c.series})`.padEnd(46)}${fmt(c.previous)} → ${fmt(c.current)}`,
    ),
    `  ${comparison.changes.length - moved.length} of ${comparison.changes.length} metric series: no detectable change.`,
  ];
};
