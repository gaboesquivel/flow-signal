import { cn } from "cn";

import type { ColumnDef, DatasetQuery, DatasetResult } from "@/lib/signal/domain/report-datasets";
import type { TableBlock } from "@/lib/signal/domain/report-spec";
import { applyBlockData, formatValue } from "@/lib/signal/domain/report-spec";

import { columnOf, sourceLine } from "./report-format";

type Row = DatasetResult["rows"][number];

/**
 * A ruled table (DESIGN.md → Needs table): hairline rows under an ink rule, right-aligned mono
 * numbers, mono dates. It scrolls sideways inside itself on narrow screens, never the page.
 */
export function RuledTable({
  className,
  columns,
  label,
  rows,
}: {
  className?: string;
  columns: ColumnDef[];
  /** Names the scroll region for keyboard and screen-reader users. */
  label: string;
  rows: Row[];
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be focusable
    <div
      aria-label={label}
      className={cn(
        "focus-visible:ring-ring/50 max-w-full overflow-x-auto rounded-sm outline-none focus-visible:ring-3",
        className,
      )}
      data-slot="report-table"
      role="region"
      tabIndex={0}
    >
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-rule-strong text-muted-foreground border-b text-[11px] tracking-[0.08em] uppercase">
            {columns.map((column) => (
              <th
                className={cn(
                  "px-2 py-2 font-semibold whitespace-nowrap first:pl-0 last:pr-0",
                  column.type === "number" ? "text-right" : "text-left",
                )}
                key={column.key}
                scope="col"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="border-border border-b">
              <td className="text-muted-foreground py-2.5" colSpan={columns.length}>
                No rows.
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- rows have no stable id
              <tr className="border-border border-b" key={index}>
                {columns.map((column) => (
                  <td
                    className={cn(
                      "px-2 py-2.5 align-top first:pl-0 last:pr-0",
                      column.type === "number" &&
                        "text-right font-mono whitespace-nowrap tabular-nums",
                      column.type === "date" && "font-mono whitespace-nowrap tabular-nums",
                      column.type === "string" && "max-w-[28rem] min-w-[10rem]",
                      (row[column.key] ?? null) === null && "text-muted-foreground",
                    )}
                    key={column.key}
                  >
                    {formatValue(row[column.key], column)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A quiet provenance line under a chart or table. */
export function SourceLine({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground font-mono text-[11px] leading-snug">
      <span className="sr-only">Source: </span>
      {children}
    </p>
  );
}

/** A table block: title, the ruled rows (sorted and limited by the spec), and its source. */
export function ReportTable({
  block,
  query,
  result,
}: {
  block: TableBlock;
  query: DatasetQuery | undefined;
  result: DatasetResult;
}) {
  const { rows } = applyBlockData(block, result);
  const columns = block.columns.map(
    (key): ColumnDef => columnOf(result, key) ?? { key, label: key, type: "string" },
  );
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2" data-slot="report-table-block">
      <figcaption className="font-serif text-lg leading-snug font-medium">{block.title}</figcaption>
      <RuledTable columns={columns} label={block.title} rows={rows} />
      <SourceLine>{sourceLine(query, result)}</SourceLine>
    </figure>
  );
}
