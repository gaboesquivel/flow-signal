import { cn } from "cn";

import { BriefMarkdown } from "@/app/operator/(console)/needs/[id]/brief-markdown";
import type { Block, ReportData, ReportSpec } from "@/lib/signal/domain/report-spec";

import { ReportChart } from "./report-chart";
import { formatAsOf } from "./report-format";
import { ReportKpis } from "./report-kpis";
import { ReportTable } from "./report-table";

/** A block whose dataset has no rows in `data` (a partial result): said plainly, not hidden. */
function MissingData({ title }: { title: string }) {
  return (
    <p className="text-muted-foreground border-border border-t pt-2 text-[13px]">
      {title}: no data for this block.
    </p>
  );
}

function ReportBlock({ block, data, spec }: { block: Block; data: ReportData; spec: ReportSpec }) {
  if (block.kind === "heading")
    return (
      <h2 className="mt-4 font-serif text-2xl leading-tight font-medium tracking-tight">
        {block.text}
      </h2>
    );
  if (block.kind === "text")
    return <BriefMarkdown className="max-w-prose" markdown={block.markdown} />;
  if (block.kind === "kpi") return <ReportKpis block={block} data={data} spec={spec} />;
  const result = data[block.dataset];
  if (!result) return <MissingData title={block.title} />;
  const query = spec.datasets.find((candidate) => candidate.id === block.dataset);
  if (block.kind === "chart") return <ReportChart block={block} query={query} result={result} />;
  return <ReportTable block={block} query={query} result={result} />;
}

/**
 * Renders a report from its spec and dataset rows (spec 013 → UI). No fetching: the console, the
 * shared page, and the dev fixture all hand it `{ spec, data }`. Warnings sit at the top as pencil
 * lines (they come from generation), then the "as of" line, then the blocks in order.
 */
export function ReportView({
  asOf,
  className,
  data,
  showTitle = true,
  spec,
  warnings = [],
}: {
  asOf?: Date | string;
  className?: string;
  data: ReportData;
  showTitle?: boolean;
  spec: ReportSpec;
  warnings?: string[];
}) {
  return (
    <article className={cn("flex min-w-0 flex-col gap-8", className)} data-slot="report-view">
      {showTitle || asOf || warnings.length > 0 ? (
        <header className="flex flex-col gap-3">
          {showTitle ? (
            <h1 className="font-serif text-3xl font-medium tracking-tight sm:text-4xl">
              {spec.title}
            </h1>
          ) : null}
          {asOf ? (
            <p className="text-muted-foreground -mt-1 font-mono text-[12px] tabular-nums">
              Data as of {formatAsOf(asOf)}
            </p>
          ) : null}
          {warnings.length > 0 ? (
            <ul aria-label="Warnings" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {warnings.map((warning) => (
                <li
                  className="border-ai text-ai-foreground border-l-[1.5px] border-dashed pl-3 text-[13px] leading-snug"
                  key={warning}
                >
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}
        </header>
      ) : null}
      {spec.blocks.map((block, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
        <ReportBlock block={block} data={data} key={index} spec={spec} />
      ))}
    </article>
  );
}
