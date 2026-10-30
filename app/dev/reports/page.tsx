import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { reportFixture } from "@/components/report/fixture";
import { ReportView } from "@/components/report/report-view";
import { validateReportSpec } from "@/lib/signal/domain/report-spec";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Report renderer fixture",
};

/** Dev-only: the report renderer on a fixture with every block and chart kind (spec 013 task 05). */
export default function ReportFixturePage() {
  if (process.env.NODE_ENV === "production") notFound();
  const { asOf, data, spec, warnings } = reportFixture;
  const issues = validateReportSpec(spec).map(
    (issue) => `Fixture issue (block ${issue.block ?? "—"}): ${issue.message}`,
  );
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8">
      <ReportView asOf={asOf} data={data} spec={spec} warnings={[...warnings, ...issues]} />
    </main>
  );
}
