import { cn } from "cn";

import type { Block, ReportData, ReportSpec } from "@/lib/signal/domain/report-spec";
import { computeKpi, formatValue, kpiColumn } from "@/lib/signal/domain/report-spec";

type KpiBlock = Extract<Block, { kind: "kpi" }>;

const aggregateWords: Record<KpiBlock["items"][number]["aggregate"], string> = {
  avg: "average",
  count: "count",
  latest: "latest",
  max: "max",
  median: "median",
  min: "min",
  sum: "sum",
};

/**
 * 1–4 large mono figures with labels (DESIGN.md → Metrics). Each figure is `computeKpi` over its
 * dataset's rows; its quiet line says how ("sum of ARR · needs"). No data shows "—".
 */
export function ReportKpis({
  block,
  data,
  spec,
}: {
  block: KpiBlock;
  data: ReportData;
  spec: ReportSpec;
}) {
  return (
    <dl
      className={cn(
        "border-rule-strong m-0 grid grid-cols-2 gap-x-6 border-t",
        block.items.length >= 3 && "sm:grid-cols-4",
        block.items.length === 2 && "sm:grid-cols-2",
      )}
      data-slot="report-kpis"
    >
      {block.items.map((item, index) => {
        const result = data[item.dataset];
        const value = result ? computeKpi(item, result) : null;
        const column = result ? kpiColumn(item, result) : undefined;
        const shown = formatValue(value, column);
        const source = spec.datasets.find((query) => query.id === item.dataset)?.name;
        return (
          <div
            className="border-border flex min-w-0 flex-col gap-1.5 border-b py-4"
            // oxlint-disable-next-line react/no-array-index-key -- items are positional
            key={index}
          >
            <dt className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
              {item.label}
            </dt>
            <dd
              className={cn(
                "m-0 font-mono text-3xl leading-none font-medium tracking-tight tabular-nums sm:text-4xl",
                shown === "—" && "text-muted-foreground",
              )}
            >
              {shown}
            </dd>
            <dd className="text-muted-foreground m-0 truncate font-mono text-[11px]">
              {aggregateWords[item.aggregate]} of {column?.label ?? item.column}
              {source ? ` · ${source}` : ""}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
