import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConsoleError, ConsoleHeading } from "../_components/console-bits";
import { metricsWindow, parseWindowDays } from "../_lib/metrics-view";
import { operatorServerClient } from "../_lib/operator-client";
import { MetricsView } from "./metrics-view";
import { WindowToggle } from "./window-toggle";

export const metadata: Metadata = { title: "Metrics · Signal" };

/** The MVP metrics (get_metrics) for the last 28 or 90 days (`?days=90`). */
export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const days = parseWindowDays(params.days);
  const client = await operatorServerClient();
  // A server component renders once per request; "now" ends the window.
  // oxlint-disable-next-line react/purity
  const result = await client.getMetrics(metricsWindow(days, new Date()));

  if (!result.ok) {
    if (result.error.code === "unauthorized") redirect("/operator/access");
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <ConsoleHeading title="Metrics" />
          <WindowToggle days={days} />
        </div>
        <ConsoleError error={result.error} />
      </div>
    );
  }

  return <MetricsView days={days} metrics={result.data} />;
}
