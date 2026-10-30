import { z } from "zod";

import type { ColumnDef, DatasetQuery, DatasetResult } from "./report-datasets";
import { datasetColumns, datasetQuerySchema } from "./report-datasets";

/**
 * The report spec (spec 013, decision 0010): blocks that reference dataset columns. The model
 * never writes a number; every figure on screen is a function of dataset rows
 * (`applyBlockData`, `computeKpi`), shared by the renderer and the traceability check.
 */

export const MAX_REPORT_DATASETS = 6;
export const MAX_REPORT_BLOCKS = 20;
export const MAX_TEXT_BLOCK_CHARS = 600;
export const MAX_BLOCK_ROWS = 100;

const ref = z.string().min(1).max(64);
const sortSchema = z.object({
  column: ref,
  direction: z.enum(["asc", "desc"]),
});

export const kpiAggregates = ["sum", "count", "avg", "median", "min", "max", "latest"] as const;
export const chartKinds = ["bar", "line", "area", "scatter", "donut"] as const;
/** How a chart combines rows that share an `x` (default sum); scatter plots every row. */
export const chartAggregates = ["sum", "avg", "count", "min", "max"] as const;

export const blockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), text: z.string().min(1).max(120) }),
  z.object({
    kind: z.literal("text"),
    markdown: z.string().min(1).max(MAX_TEXT_BLOCK_CHARS),
  }),
  z.object({
    items: z
      .array(
        z.object({
          aggregate: z.enum(kpiAggregates),
          column: ref,
          dataset: ref,
          label: z.string().min(1).max(60),
        }),
      )
      .min(1)
      .max(4),
    kind: z.literal("kpi"),
  }),
  z.object({
    aggregate: z.enum(chartAggregates).optional(),
    caption: z.string().max(200).optional(),
    chart: z.enum(chartKinds),
    dataset: ref,
    horizontal: z.boolean().optional(),
    kind: z.literal("chart"),
    limit: z.number().int().min(1).max(MAX_BLOCK_ROWS).optional(),
    seriesBy: ref.optional(),
    sort: sortSchema.optional(),
    stacked: z.boolean().optional(),
    title: z.string().min(1).max(120),
    x: ref,
    y: z.array(ref).min(1).max(6),
  }),
  z.object({
    columns: z.array(ref).min(1).max(10),
    dataset: ref,
    kind: z.literal("table"),
    limit: z.number().int().min(1).max(MAX_BLOCK_ROWS).optional(),
    sort: sortSchema.optional(),
    title: z.string().min(1).max(120),
  }),
]);
export type Block = z.infer<typeof blockSchema>;
export type ChartBlock = Extract<Block, { kind: "chart" }>;
export type TableBlock = Extract<Block, { kind: "table" }>;
export type KpiItem = Extract<Block, { kind: "kpi" }>["items"][number];

export const reportSpecSchema = z.object({
  blocks: z.array(blockSchema).min(1).max(MAX_REPORT_BLOCKS),
  datasets: z.array(datasetQuerySchema).min(1).max(MAX_REPORT_DATASETS),
  title: z.string().min(1).max(120),
  version: z.literal(1),
});
export type ReportSpec = z.infer<typeof reportSpecSchema>;

export interface ReportSpecIssue {
  /** Index into `spec.blocks`; null for a dataset-level issue. */
  block: number | null;
  message: string;
}

const columnsOf = (spec: ReportSpec) =>
  new Map<string, ColumnDef[]>(
    spec.datasets.map((query: DatasetQuery) => [query.id, datasetColumns[query.name]]),
  );

/**
 * Checks references the schema can't: dataset ids exist, columns exist in that dataset, numeric
 * columns where numbers are needed, a string `seriesBy`, and one `y` for a donut.
 */
export const validateReportSpec = (spec: ReportSpec): ReportSpecIssue[] => {
  const issues: ReportSpecIssue[] = [];
  const ids = spec.datasets.map((query) => query.id);
  if (new Set(ids).size !== ids.length)
    issues.push({ block: null, message: "Dataset ids must be unique." });
  const columns = columnsOf(spec);

  for (const [index, block] of spec.blocks.entries()) {
    const fail = (message: string) => issues.push({ block: index, message });
    const column = (dataset: string, key: string, need?: ColumnDef["type"]) => {
      const defs = columns.get(dataset);
      if (!defs) return fail(`Unknown dataset "${dataset}".`);
      const def = defs.find((candidate) => candidate.key === key);
      if (!def) return fail(`Dataset "${dataset}" has no column "${key}".`);
      if (need && def.type !== need) fail(`Column "${key}" must be ${need}, not ${def.type}.`);
    };

    if (block.kind === "kpi")
      for (const item of block.items)
        column(item.dataset, item.column, item.aggregate === "count" ? undefined : "number");
    if (block.kind === "table") {
      for (const key of block.columns) column(block.dataset, key);
      if (block.sort) column(block.dataset, block.sort.column);
    }
    if (block.kind === "chart") {
      column(block.dataset, block.x, block.chart === "scatter" ? "number" : undefined);
      for (const key of block.y) column(block.dataset, key, "number");
      if (block.seriesBy) column(block.dataset, block.seriesBy, "string");
      if (block.sort) {
        // Grouped and pivoted rows keep only x and the plotted values.
        const sortable = block.seriesBy ? [block.x] : [block.x, ...block.y];
        if (!sortable.includes(block.sort.column))
          fail(`A chart sorts by its x or a y column, not "${block.sort.column}".`);
      }
      if (block.chart === "donut" && block.y.length !== 1)
        fail("A donut chart takes exactly one y.");
      if (block.seriesBy && block.y.length !== 1) fail("`seriesBy` takes exactly one y.");
    }
  }
  return issues;
};

type Row = DatasetResult["rows"][number];
type Cell = Row[string];

const compareCells = (a: Cell | undefined, b: Cell | undefined) => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
};

const sortRows = (rows: Row[], sort?: { column: string; direction: "asc" | "desc" }) => {
  if (!sort) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].toSorted((a, b) => {
    const order = compareCells(a[sort.column], b[sort.column]);
    // Nulls stay last in either direction.
    if (a[sort.column] === null || b[sort.column] === null) return order;
    return sign * order;
  });
};

export interface ChartSeries {
  key: string;
  label: string;
}

export interface BlockData {
  rows: Row[];
  /** For a chart: the plotted series (pivoted values when `seriesBy` is set). */
  series: ChartSeries[];
}

/** A series key by position: safe as a CSS variable name and never shared by two series. */
export const seriesKey = (index: number) => `s${index}`;

const combine = (aggregate: (typeof chartAggregates)[number], values: number[]) => {
  if (aggregate === "count") return values.length;
  if (values.length === 0) return null;
  if (aggregate === "min") return Math.min(...values);
  if (aggregate === "max") return Math.max(...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  return aggregate === "avg" ? total / values.length : total;
};

/** One row per distinct `x`, each `y` combined by the chart's aggregate (default sum). */
const groupByX = (block: ChartBlock, rows: Row[]): Row[] => {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row[block.x] ?? null);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const out: Row = { [block.x]: group[0]?.[block.x] ?? null };
    for (const y of block.y)
      out[y] = combine(
        block.aggregate ?? "sum",
        group.map((row) => row[y]).filter((value): value is number => typeof value === "number"),
      );
    return out;
  });
};

/**
 * The rows a chart or table block shows: sorted, limited, and (for a chart with `seriesBy`)
 * pivoted to one row per `x` with one numeric column per series value.
 */
export const applyBlockData = (
  block: ChartBlock | TableBlock,
  result: DatasetResult,
): BlockData => {
  const labelOf = (key: string) =>
    result.columns.find((column) => column.key === key)?.label ?? key;

  if (block.kind === "table") {
    const rows = sortRows(result.rows, block.sort).slice(0, block.limit ?? MAX_BLOCK_ROWS);
    return {
      rows,
      series: block.columns.map((key) => ({ key, label: labelOf(key) })),
    };
  }

  if (!block.seriesBy) {
    const grouped = block.chart === "scatter" ? result.rows : groupByX(block, result.rows);
    const rows = sortRows(grouped, block.sort).slice(0, block.limit ?? MAX_BLOCK_ROWS);
    return {
      rows,
      series: block.y.map((key) => ({ key, label: labelOf(key) })),
    };
  }

  const [y] = block.y as [string];
  const { seriesBy } = block;
  // Keyed by position, so distinct names never collide in the chart config.
  const series = new Map<string, ChartSeries>();
  const byX = new Map<string, { values: Map<string, number[]>; x: Cell }>();
  for (const row of result.rows) {
    const xValue = row[block.x] ?? null;
    const name = String(row[seriesBy] ?? "None");
    if (!series.has(name)) series.set(name, { key: seriesKey(series.size), label: name });
    const xKey = String(xValue);
    const entry = byX.get(xKey) ?? { values: new Map<string, number[]>(), x: xValue };
    const value = row[y];
    const values = entry.values.get(name) ?? [];
    if (typeof value === "number") values.push(value);
    entry.values.set(name, values);
    byX.set(xKey, entry);
  }
  // Every pivoted row has every series (0 where a group had no row), so stacks line up.
  const rows = [...byX.values()].map(({ values, x }) => {
    const row: Row = { [block.x]: x };
    for (const [name, { key }] of series)
      row[key] = combine(block.aggregate ?? "sum", values.get(name) ?? []) ?? 0;
    return row;
  });
  const sorted = sortRows(rows, block.sort ?? { column: block.x, direction: "asc" });
  return {
    rows: sorted.slice(0, block.limit ?? MAX_BLOCK_ROWS),
    series: [...series.values()],
  };
};

/** One KPI figure from a dataset's rows; null when there is nothing to aggregate. */
export const computeKpi = (item: KpiItem, result: DatasetResult): number | null => {
  if (item.aggregate === "count")
    return result.rows.filter((row) => row[item.column] !== null && row[item.column] !== undefined)
      .length;
  const values = result.rows
    .map((row) => row[item.column])
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (item.aggregate === "sum") return total;
  if (item.aggregate === "avg") return total / values.length;
  if (item.aggregate === "min") return Math.min(...values);
  if (item.aggregate === "max") return Math.max(...values);
  if (item.aggregate === "latest") return values.at(-1) ?? null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
};

/** The unit a KPI figure is shown in: a count aggregate is always a count. */
export const kpiColumn = (item: KpiItem, result: DatasetResult): ColumnDef | undefined => {
  const column = result.columns.find((candidate) => candidate.key === item.column);
  if (!column) return undefined;
  return item.aggregate === "count" ? { ...column, unit: "count" } : column;
};

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** How a value is displayed everywhere (renderer, tables, traceability check). */
export const formatValue = (value: Cell | undefined, column?: Pick<ColumnDef, "type" | "unit">) => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return column?.type === "date" ? value.slice(0, 10) : value;
  const unit = column?.unit;
  if (unit === "cents") {
    const dollars = value / 100;
    return `$${Math.abs(dollars) >= 10_000 ? compact.format(dollars) : whole.format(dollars)}`;
  }
  if (unit === "percent") return `${oneDecimal.format(value * 100)}%`;
  if (unit === "days" || unit === "score") return oneDecimal.format(value);
  return Math.abs(value) >= 10_000 ? compact.format(value) : oneDecimal.format(value);
};

/** Every column a spec shows, per dataset id (x, y, seriesBy, table and KPI columns, sorts). */
export const referencedColumns = (spec: ReportSpec) => {
  const used = new Map<string, Set<string>>();
  const add = (dataset: string, ...keys: (string | undefined)[]) => {
    const set = used.get(dataset) ?? new Set<string>();
    for (const key of keys) if (key) set.add(key);
    used.set(dataset, set);
  };
  for (const block of spec.blocks) {
    if (block.kind === "kpi") for (const item of block.items) add(item.dataset, item.column);
    if (block.kind === "table") add(block.dataset, ...block.columns, block.sort?.column);
    if (block.kind === "chart")
      add(block.dataset, block.x, ...block.y, block.seriesBy, block.sort?.column);
  }
  return used;
};

/**
 * Keeps only the datasets and columns a spec shows, so a shared snapshot carries nothing the
 * report does not render (rows stay whole: KPIs aggregate over all of them).
 */
export const pruneReportData = (spec: ReportSpec, data: ReportData): ReportData => {
  const used = referencedColumns(spec);
  return Object.fromEntries(
    [...used].flatMap(([id, keys]) => {
      const result = data[id];
      if (!result) return [];
      return [
        [
          id,
          {
            columns: result.columns.filter((column) => keys.has(column.key)),
            rows: result.rows.map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => keys.has(key))),
            ),
            truncated: result.truncated,
          },
        ],
      ];
    }),
  );
};

/** Report data keyed by dataset id, as every report operation returns it. */
export type ReportData = Record<string, DatasetResult>;
