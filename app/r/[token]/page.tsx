import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReportView } from "@/components/report/report-view";

import { SignalErrorAlert } from "../../_components/signal/error-alert";
import { formatDate } from "../../_components/signal/labels";
import { signalServerClient } from "../../_components/signal/server-client";
import { PageShell } from "../../_components/signal/site-header";

/** A private link: keep it out of search engines and referrers. */
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
  title: "Shared report · Signal",
};

/** A shared report: the snapshot the PM chose to share, read-only (spec 013). */
export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const client = await signalServerClient();
  const result = await client.getSharedReport({ token });

  if (!result.ok) {
    if (result.error.code === "not_found" || result.error.code === "validation_failed") notFound();
    return (
      <PageShell>
        <SignalErrorAlert error={result.error} />
      </PageShell>
    );
  }

  const { data, snapshotAt, spec, title } = result.data;
  return (
    <PageShell>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            Shared from Signal · data as of{" "}
            <span className="font-mono">{formatDate(snapshotAt)}</span>
          </p>
          <h1 className="font-serif text-3xl font-medium tracking-tight sm:text-4xl">{title}</h1>
        </header>
        <ReportView data={data} showTitle={false} spec={spec} />
      </div>
    </PageShell>
  );
}
