"use client";

import { cn } from "cn";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import type { XAxisTickContentProps } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/chart";
import type { ColumnDef, DatasetQuery, DatasetResult } from "@/lib/signal/domain/report-datasets";
import type { ChartBlock, ChartSeries } from "@/lib/signal/domain/report-spec";
import { applyBlockData, formatValue, seriesKey } from "@/lib/signal/domain/report-spec";

import {
  CHART_SLOTS,
  SCATTER_SLOTS,
  chartColumns,
  shortDate,
  slotColor,
  sourceLine,
  truncate,
} from "./report-format";
import { RuledTable, SourceLine } from "./report-table";

type Row = DatasetResult["rows"][number];
type Cell = Row[string];

const OTHER_KEY = "s__other";
const axisTick = { fontSize: 11 } as const;
const chartChrome =
  "[&_.recharts-cartesian-axis-tick_text]:font-mono [&_.recharts-text]:font-mono w-full aspect-auto";

/**
 * Past eight series (or donut slices), the smallest fold into "Other" so no hue is ever reused
 * (dataviz: categorical slots are assigned in order, never cycled). Kept series stay in their
 * original order, so a series keeps its colour when others fold.
 */
const foldSeries = (rows: Row[], series: ChartSeries[]): { rows: Row[]; series: ChartSeries[] } => {
  if (series.length <= CHART_SLOTS) return { rows, series };
  const total = (key: string) =>
    rows.reduce((sum, row) => sum + (typeof row[key] === "number" ? row[key] : 0), 0);
  const keep = new Set(
    series
      .toSorted((a, b) => total(b.key) - total(a.key))
      .slice(0, CHART_SLOTS - 1)
      .map((entry) => entry.key),
  );
  const folded = series.filter((entry) => !keep.has(entry.key));
  return {
    rows: rows.map((row) => {
      const next: Row = {};
      for (const [key, value] of Object.entries(row))
        if (!folded.some((f) => f.key === key)) next[key] = value;
      next[OTHER_KEY] = folded.reduce(
        (sum, entry) => sum + (typeof row[entry.key] === "number" ? (row[entry.key] as number) : 0),
        0,
      );
      return next;
    }),
    series: [
      ...series.filter((entry) => keep.has(entry.key)),
      { key: OTHER_KEY, label: `Other (${folded.length})` },
    ],
  };
};

interface SeriesInfo {
  color: string;
  column: ColumnDef | undefined;
  label: string;
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-[2px]"
      style={{ background: color }}
    />
  );
}

function TooltipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex w-full items-center gap-2">
      {color ? <Swatch color={color} /> : null}
      <span className="text-muted-foreground flex-1">{label}</span>
      <span className="text-foreground font-mono font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <ul
      className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12px]"
      data-slot="report-legend"
    >
      {items.map((item) => (
        <li
          className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5"
          key={item.label}
        >
          <Swatch color={item.color} />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** Formats an x value: dates short on the axis and full in tooltips; long categories cut. */
const xFormatter =
  (column: ColumnDef | undefined, mode: "tick" | "full", max = 14) =>
  (value: Cell) => {
    if (value === null || value === undefined) return "—";
    if (column?.type === "date" && typeof value === "string")
      return mode === "tick" ? shortDate(value) : value.slice(0, 10);
    if (typeof value === "number") return formatValue(value, column);
    return mode === "tick" ? truncate(String(value), max) : String(value);
  };

/** Advance of one 11px monospace character (about 6.6px), plus air between neighbouring ticks. */
const TICK_CHAR_PX = 7.4;

/**
 * Category ticks for a vertical bar chart: every bar keeps its label (recharts drops ticks that
 * would collide), cut with an ellipsis to the bar's slot; the full label shows on hover.
 */
const categoryTick =
  (format: (value: Cell) => string) =>
  ({ fill, payload, visibleTicksCount, width, x, y }: XAxisTickContentProps) => {
    const full = format(payload.value as Cell);
    const slot = Number(width) / Math.max(1, visibleTicksCount);
    const fits = Math.max(3, Math.floor(slot / TICK_CHAR_PX));
    return (
      <text
        className="recharts-text recharts-cartesian-axis-tick-value"
        dy="0.71em"
        fill={fill}
        fontSize={axisTick.fontSize}
        textAnchor="middle"
        x={x}
        y={y}
      >
        <title>{full}</title>
        {truncate(full, fits)}
      </text>
    );
  };

/**
 * One chart block (spec 013 → UI): bar (vertical or horizontal, grouped or stacked), line, area
 * (optionally stacked), scatter, or donut, drawn from `applyBlockData` rows. Below it, a "Data"
 * disclosure with the same rows as a ruled table and a quiet source line.
 */
export function ReportChart({
  block,
  query,
  result,
}: {
  block: ChartBlock;
  query: DatasetQuery | undefined;
  result: DatasetResult;
}) {
  const data = applyBlockData(block, result);
  const columns = chartColumns(block, result, data.series);
  const [xColumn, ...seriesColumns] = columns;
  const yColumn = seriesColumns[0];

  let body: ReactNode;
  let note: string | null = null;
  if (data.rows.length === 0) {
    body = <p className="text-muted-foreground py-6 text-sm">No rows to chart.</p>;
  } else if (block.chart === "donut") {
    body = <Donut block={block} rows={data.rows} xColumn={xColumn} yColumn={yColumn} />;
  } else if (block.chart === "scatter") {
    const shown = data.series.slice(0, SCATTER_SLOTS);
    if (shown.length < data.series.length)
      note = `Showing ${shown.length} of ${data.series.length} series; the Data table has all.`;
    body = (
      <ScatterPlot
        block={block}
        rows={data.rows}
        series={shown}
        xColumn={xColumn}
        yColumn={yColumn}
      />
    );
  } else {
    const folded = foldSeries(data.rows, data.series);
    const info = new Map<string, SeriesInfo>(
      folded.series.map((entry, index) => [
        entry.key,
        {
          color: slotColor(index),
          column: seriesColumns.find((column) => column.key === entry.key) ?? yColumn,
          label: entry.label,
        },
      ]),
    );
    body = (
      <Cartesian
        block={block}
        info={info}
        rows={folded.rows}
        series={folded.series}
        xColumn={xColumn}
      />
    );
  }

  return (
    <figure
      className="m-0 flex min-w-0 flex-col gap-3"
      data-chart-kind={block.chart}
      data-slot="report-chart"
    >
      <figcaption className="flex flex-col gap-0.5">
        <span className="font-serif text-lg leading-snug font-medium">{block.title}</span>
        {block.caption ? (
          <span className="text-muted-foreground text-[13px]">{block.caption}</span>
        ) : null}
      </figcaption>
      {body}
      {note ? <p className="text-muted-foreground text-[12px]">{note}</p> : null}
      <details className="group border-border border-t pt-2">
        <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-[12px] font-medium select-none">
          Data
          <span className="font-mono tabular-nums">
            {" "}
            · {data.rows.length} {data.rows.length === 1 ? "row" : "rows"}
          </span>
        </summary>
        <RuledTable
          className="mt-2"
          columns={columns}
          label={`${block.title} data`}
          rows={data.rows}
        />
      </details>
      <SourceLine>{sourceLine(query, result)}</SourceLine>
    </figure>
  );
}

function Cartesian({
  block,
  info,
  rows,
  series,
  xColumn,
}: {
  block: ChartBlock;
  info: Map<string, SeriesInfo>;
  rows: Row[];
  series: ChartSeries[];
  xColumn: ColumnDef | undefined;
}) {
  const config = Object.fromEntries(
    [...info].map(([key, entry]) => [key, { color: entry.color, label: entry.label }]),
  );
  const firstColumn = info.values().next().value?.column;
  const yTick = (value: Cell) => formatValue(value, firstColumn);
  const horizontal = block.chart === "bar" && block.horizontal === true;
  const stacked = block.stacked === true && series.length > 1;
  const tooltip = (
    <ChartTooltip
      content={
        <ChartTooltipContent
          formatter={(value, name, item) => {
            const entry = info.get(String(item.dataKey ?? name));
            return (
              <TooltipRow
                color={entry?.color}
                label={entry?.label ?? String(name)}
                value={formatValue(value as Cell, entry?.column)}
              />
            );
          }}
          labelFormatter={(label) => xFormatter(xColumn, "full")(label as Cell)}
        />
      }
      cursor={block.chart === "bar" ? { fill: "var(--muted)" } : { stroke: "var(--border)" }}
    />
  );
  const legend =
    series.length > 1 ? (
      <Legend
        items={series.map((entry) => ({
          color: info.get(entry.key)?.color ?? "",
          label: entry.label,
        }))}
      />
    ) : null;

  const categoryAxis = {
    axisLine: { stroke: "var(--border)" },
    dataKey: block.x,
    tick: axisTick,
    tickFormatter: xFormatter(xColumn, "tick", horizontal ? 22 : 14),
    tickLine: false,
  } as const;
  const valueAxis = {
    axisLine: false,
    tick: axisTick,
    tickFormatter: yTick,
    tickLine: false,
  } as const;

  if (block.chart === "bar") {
    const height = horizontal
      ? Math.max(160, rows.length * (stacked ? 28 : 20 * series.length + 12) + 40)
      : 256;
    return (
      <>
        {legend}
        <ChartContainer className={chartChrome} config={config} style={{ height }}>
          <BarChart
            accessibilityLayer
            barCategoryGap="20%"
            barGap={2}
            data={rows}
            layout={horizontal ? "vertical" : "horizontal"}
            margin={{ bottom: 0, left: 0, right: 8, top: 8 }}
          >
            <CartesianGrid horizontal={!horizontal} vertical={horizontal} />
            {horizontal ? (
              <>
                <XAxis {...valueAxis} type="number" />
                <YAxis {...categoryAxis} type="category" width="auto" />
              </>
            ) : (
              <>
                {xColumn?.type === "date" || xColumn?.type === "number" ? (
                  <XAxis {...categoryAxis} minTickGap={8} />
                ) : (
                  <XAxis
                    {...categoryAxis}
                    interval={0}
                    tick={categoryTick(xFormatter(xColumn, "full"))}
                  />
                )}
                <YAxis {...valueAxis} width="auto" />
              </>
            )}
            {tooltip}
            {series.map((entry, index) => {
              const end = !stacked || index === series.length - 1;
              const radius: [number, number, number, number] = end
                ? horizontal
                  ? [0, 4, 4, 0]
                  : [4, 4, 0, 0]
                : [0, 0, 0, 0];
              return (
                <Bar
                  dataKey={entry.key}
                  fill={info.get(entry.key)?.color}
                  isAnimationActive={false}
                  key={entry.key}
                  maxBarSize={40}
                  name={entry.key}
                  radius={radius}
                  stackId={stacked ? "stack" : undefined}
                  stroke={stacked ? "var(--background)" : undefined}
                  strokeWidth={stacked ? 1 : 0}
                />
              );
            })}
          </BarChart>
        </ChartContainer>
      </>
    );
  }

  if (block.chart === "area")
    return (
      <>
        {legend}
        <ChartContainer className={cn(chartChrome, "h-64")} config={config}>
          <AreaChart
            accessibilityLayer
            data={rows}
            margin={{ bottom: 0, left: 0, right: 8, top: 8 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis {...categoryAxis} minTickGap={16} padding={{ left: 20, right: 20 }} />
            <YAxis {...valueAxis} width="auto" />
            {tooltip}
            {series.map((entry) => {
              const color = info.get(entry.key)?.color;
              return (
                <Area
                  dataKey={entry.key}
                  fill={color}
                  fillOpacity={stacked ? 0.85 : 0.12}
                  isAnimationActive={false}
                  key={entry.key}
                  name={entry.key}
                  stackId={stacked ? "stack" : undefined}
                  stroke={stacked ? "var(--background)" : color}
                  strokeWidth={stacked ? 1.5 : 2}
                  type="linear"
                />
              );
            })}
          </AreaChart>
        </ChartContainer>
      </>
    );

  return (
    <>
      {legend}
      <ChartContainer className={cn(chartChrome, "h-64")} config={config}>
        <LineChart accessibilityLayer data={rows} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis {...categoryAxis} minTickGap={16} padding={{ left: 20, right: 20 }} />
          <YAxis {...valueAxis} width="auto" />
          {tooltip}
          {series.map((entry) => {
            const color = info.get(entry.key)?.color;
            return (
              <Line
                activeDot={{ r: 4, stroke: "var(--background)", strokeWidth: 2 }}
                dataKey={entry.key}
                dot={rows.length <= 2 ? { fill: color, r: 4, strokeWidth: 0 } : false}
                isAnimationActive={false}
                key={entry.key}
                name={entry.key}
                stroke={color}
                strokeWidth={2}
                type="linear"
              />
            );
          })}
        </LineChart>
      </ChartContainer>
    </>
  );
}

function ScatterPlot({
  block,
  rows,
  series,
  xColumn,
  yColumn,
}: {
  block: ChartBlock;
  rows: Row[];
  series: ChartSeries[];
  xColumn: ColumnDef | undefined;
  yColumn: ColumnDef | undefined;
}) {
  const config = Object.fromEntries(
    series.map((entry, index) => [entry.key, { color: slotColor(index), label: entry.label }]),
  );
  const points = series.map((entry) =>
    rows
      .filter((row) => typeof row[block.x] === "number" && typeof row[entry.key] === "number")
      .map((row) => ({ series: entry.label, x: row[block.x], y: row[entry.key] })),
  );
  return (
    <>
      {series.length > 1 ? (
        <Legend
          items={series.map((entry, index) => ({ color: slotColor(index), label: entry.label }))}
        />
      ) : null}
      <ChartContainer className={cn(chartChrome, "h-64")} config={config}>
        <ScatterChart accessibilityLayer margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={{ stroke: "var(--border)" }}
            dataKey="x"
            name={xColumn?.label}
            tick={axisTick}
            tickFormatter={(value: Cell) => formatValue(value, xColumn)}
            tickLine={false}
            type="number"
          />
          <YAxis
            axisLine={false}
            dataKey="y"
            name={yColumn?.label}
            tick={axisTick}
            tickFormatter={(value: Cell) => formatValue(value, yColumn)}
            tickLine={false}
            type="number"
            width="auto"
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, _name, item) => (
                  <TooltipRow
                    label={
                      (item.dataKey === "x" ? xColumn?.label : yColumn?.label) ??
                      String(item.dataKey)
                    }
                    value={formatValue(value as Cell, item.dataKey === "x" ? xColumn : yColumn)}
                  />
                )}
                labelFormatter={(_label, payload) => {
                  const point = payload?.[0]?.payload as { series?: string } | undefined;
                  return series.length > 1 ? point?.series : null;
                }}
              />
            }
            cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
          />
          {series.map((entry, index) => (
            <Scatter
              data={points[index]}
              fill={slotColor(index)}
              isAnimationActive={false}
              key={entry.key}
              name={entry.label}
              stroke="var(--background)"
              strokeWidth={1.5}
            />
          ))}
        </ScatterChart>
      </ChartContainer>
    </>
  );
}

function Donut({
  block,
  rows,
  xColumn,
  yColumn,
}: {
  block: ChartBlock;
  rows: Row[];
  xColumn: ColumnDef | undefined;
  yColumn: ColumnDef | undefined;
}) {
  const [y] = block.y as [string];
  const label = xFormatter(xColumn, "full");
  let slices = rows
    .map((row) => ({
      name: label(row[block.x] ?? null),
      value: typeof row[y] === "number" ? row[y] : 0,
    }))
    .filter((slice) => slice.value > 0);
  if (slices.length > CHART_SLOTS) {
    const ranked = slices.toSorted((a, b) => b.value - a.value);
    const kept = new Set(ranked.slice(0, CHART_SLOTS - 1));
    const rest = slices.filter((slice) => !kept.has(slice));
    slices = [
      ...slices.filter((slice) => kept.has(slice)),
      { name: `Other (${rest.length})`, value: rest.reduce((sum, slice) => sum + slice.value, 0) },
    ];
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const data = slices.map((slice, index) => ({
    ...slice,
    fill: slotColor(index),
    key: seriesKey(index),
  }));
  const config = Object.fromEntries(
    data.map((slice) => [slice.key, { color: slice.fill, label: slice.name }]),
  );

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-8">
      <ChartContainer className="aspect-square h-48 w-48 shrink-0" config={config}>
        <PieChart accessibilityLayer>
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name, item) => (
                  <TooltipRow
                    color={(item.payload as { fill?: string } | undefined)?.fill}
                    label={String(name)}
                    value={formatValue(value as Cell, yColumn)}
                  />
                )}
                hideLabel
              />
            }
          />
          <Pie
            data={data}
            dataKey="value"
            innerRadius="58%"
            isAnimationActive={false}
            nameKey="name"
            outerRadius="100%"
            stroke="var(--background)"
            strokeWidth={2}
          />
        </PieChart>
      </ChartContainer>
      <ul
        className="border-rule-strong m-0 w-full min-w-0 list-none border-t p-0 text-[13px]"
        data-slot="report-legend"
      >
        {data.map((slice) => (
          <li className="border-border flex items-center gap-2 border-b py-1.5" key={slice.key}>
            <Swatch color={slice.fill} />
            <span className="min-w-0 flex-1 truncate">{slice.name}</span>
            <span className="font-mono tabular-nums">{formatValue(slice.value, yColumn)}</span>
            <span className="text-muted-foreground w-12 text-right font-mono tabular-nums">
              {total > 0 ? `${Math.round((slice.value / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
