import type { ChartBlock, ChartSeries } from "@/lib/signal/domain/report-spec";
import type { ColumnDef, DatasetQuery, DatasetResult } from "@/lib/signal/domain/report-datasets";

/**
 * Display helpers shared by the report renderer (spec 013 task 05). Browser-safe and pure: the
 * figures themselves always come from `formatValue` in the report contract.
 */

/** Categorical slots in `styles/globals.css`, assigned in order and never cycled. */
export const CHART_SLOTS = 8;
/** Scatter marks share a plot, so every pair must separate: only the first three slots do. */
export const SCATTER_SLOTS = 3;
export const slotColor = (index: number) => `var(--chart-${Math.min(index, CHART_SLOTS - 1) + 1})`;

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-05" → "Oct 5", for axis ticks; tables and tooltips keep YYYY-MM-DD. */
export const shortDate = (value: string) => {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u.exec(value)?.groups;
  if (!match) return value;
  return `${months[Number(match.month) - 1] ?? match.month} ${Number(match.day)}`;
};

export const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** "2026-10-30T14:05:00Z" → "2026-10-30 14:05 UTC"; a bare date stays a date. */
export const formatAsOf = (asOf: Date | string) => {
  const iso = typeof asOf === "string" ? asOf : asOf.toISOString();
  const time = /T(?<hm>\d{2}:\d{2})/u.exec(iso)?.groups?.hm;
  return time ? `${iso.slice(0, 10)} ${time} UTC` : iso.slice(0, 10);
};

const paramWords = (key: string, value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (key === "includeDecided") return value === false ? "excluding decided" : null;
  if (key === "groupBy") return value === "none" ? null : `by ${String(value)}`;
  if (key === "actor") return value === "all" ? null : `${String(value)}s only`;
  if (key === "themeId") return `theme ${String(value).slice(0, 8)}`;
  if (key === "since" || key === "until") return `${key} ${String(value).slice(0, 10)}`;
  if (Array.isArray(value)) return `${key} ${value.map(String).join(", ")}`;
  return `${key} ${String(value)}`;
};

/** The quiet provenance line: dataset name and params, e.g. "needs · plan Enterprise". */
export const sourceLine = (query: DatasetQuery | undefined, result?: DatasetResult) => {
  if (!query) return "";
  const params = Object.entries(query.params ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => paramWords(key, value))
    .filter((part): part is string => part !== null);
  const truncated = result?.truncated ? ["first 500 rows"] : [];
  return [query.name, ...params, ...truncated].join(" · ");
};

export const columnOf = (result: DatasetResult, key: string): ColumnDef | undefined =>
  result.columns.find((column) => column.key === key);

/**
 * The columns a chart's rows carry after `applyBlockData`: `x`, then one column per plotted
 * series (pivoted series take the unit of the single `y`).
 */
export const chartColumns = (
  block: ChartBlock,
  result: DatasetResult,
  series: ChartSeries[],
): ColumnDef[] => {
  const x = columnOf(result, block.x) ?? { key: block.x, label: block.x, type: "string" as const };
  const y = columnOf(result, block.y[0] ?? "");
  return [
    x,
    ...series.map(
      (entry): ColumnDef =>
        columnOf(result, entry.key) ?? {
          key: entry.key,
          label: entry.label,
          type: "number",
          ...(y?.unit ? { unit: y.unit } : {}),
        },
    ),
  ];
};
