"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import { ConsoleHeading } from "../_components/console-bits";
import { formatDate } from "../_lib/console";
import type { ReportListItem } from "../_lib/reports";
import { reportStarters } from "../_lib/reports";
import { ReportPrompt } from "./report-prompt";

/** Prompt field, starters in a quiet line, then saved reports as a ruled list. */
export function ReportsHome({
  children,
  reports,
}: {
  children?: ReactNode;
  reports: ReportListItem[];
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const start = (prompt: string) => {
    const trimmed = prompt.trim();
    if (trimmed) router.push(`/operator/reports/new?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <ConsoleHeading title="Reports">
        Describe a report. Every figure comes from this workspace’s records.
      </ConsoleHeading>

      <div className="flex flex-col gap-3">
        <ReportPrompt
          label="Describe a report"
          onChange={setInput}
          onSubmit={() => start(input)}
          placeholder="e.g. ARR-weighted demand by theme, with the top Enterprise needs"
          submitLabel="Create"
          variant="default"
          value={input}
        />
        <p className="text-muted-foreground text-sm leading-relaxed">
          Try{" "}
          {reportStarters.map((starter, index) => (
            <span key={starter}>
              <button
                className="text-foreground decoration-input font-medium underline underline-offset-4"
                onClick={() => start(starter)}
                type="button"
              >
                {starter}
              </button>
              {index < reportStarters.length - 1 ? " · " : null}
            </span>
          ))}
        </p>
      </div>

      {children}

      <section aria-label="Saved reports" className="flex flex-col">
        <h2 className="text-muted-foreground border-border border-b pb-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
          Saved
        </h2>
        {reports.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            No saved reports yet. Create one above and save it.
          </p>
        ) : (
          <ul>
            {reports.map((report) => (
              <li className="border-border border-b" key={report.reportId}>
                <Link
                  className="hover:bg-muted/50 flex items-baseline justify-between gap-4 py-3"
                  href={`/operator/reports/${report.reportId}`}
                >
                  <span className="min-w-0 truncate font-serif text-lg">{report.title}</span>
                  <span className="text-muted-foreground flex shrink-0 items-baseline gap-3 text-xs">
                    {report.sharedAt ? <span>shared</span> : null}
                    <span className="font-mono">{formatDate(report.updatedAt)}</span>
                    <ArrowRight aria-hidden="true" className="size-3.5 self-center" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
