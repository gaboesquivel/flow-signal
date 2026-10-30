import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConsoleError } from "../_components/console-bits";
import { operatorServerClient } from "../_lib/operator-client";
import { ReportsHome } from "./reports-home";

export const metadata: Metadata = { title: "Reports · Signal" };

/** Describe a report, or open a saved one (spec 013). */
export default async function ReportsPage() {
  const client = await operatorServerClient();
  const result = await client.listReports({});
  if (!result.ok && result.error.code === "unauthorized") redirect("/operator/access");

  return (
    <ReportsHome reports={result.ok ? result.data.reports : []}>
      {result.ok ? null : <ConsoleError error={result.error} />}
    </ReportsHome>
  );
}
