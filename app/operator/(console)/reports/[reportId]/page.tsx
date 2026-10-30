import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ConsoleError, ConsoleHeading } from "../../_components/console-bits";
import { operatorServerClient } from "../../_lib/operator-client";
import { ReportWorkspace } from "../report-workspace";

export const metadata: Metadata = { title: "Report · Signal" };

/** A saved report, re-run on fresh data with no model call (get_report, spec 013). */
export default async function SavedReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reportId } = await params;
  // `?saved=1` is where a save lands: not a reuse of the report.
  const { saved } = await searchParams;
  const client = await operatorServerClient();
  const result = await client.getReport({
    reportId,
    ...(saved === "1" ? { recordView: "false" } : {}),
  });

  if (!result.ok) {
    if (result.error.code === "unauthorized") redirect("/operator/access");
    if (result.error.code === "not_found" || result.error.code === "validation_failed") notFound();
    return (
      <div className="flex flex-col gap-6">
        <ConsoleHeading title="Report" />
        <ConsoleError error={result.error} />
      </div>
    );
  }

  return <ReportWorkspace key={result.data.asOf} saved={result.data} />;
}
