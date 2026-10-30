import type { Metadata } from "next";
import { Suspense } from "react";

import { signalServerClient } from "../_components/signal/server-client";
import { PageShell } from "../_components/signal/site-header";
import type { ChosenNeed } from "./submit-model";
import { SubmitWizard } from "./submit-wizard";

export const metadata: Metadata = {
  description:
    "Tell us what you need, in your own words. We check whether others asked for it too.",
  title: "Submit a request · Signal",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SubmitPage({ searchParams }: { searchParams: SearchParams }) {
  const { need: needParam } = await searchParams;
  const needId = Array.isArray(needParam) ? needParam[0] : needParam;

  // "Add my voice" from a need page lists that need first at Check.
  let initialNeed: ChosenNeed | undefined;
  if (needId) {
    const client = await signalServerClient();
    const result = await client.getNeed({ id: needId });
    if (result.ok && result.data.status !== "merged")
      initialNeed = {
        demandBand: result.data.demandBand,
        needId: result.data.id,
        statement: result.data.statement,
        status: result.data.status,
        supporterCount: result.data.supporterCount,
      };
  }

  return (
    <PageShell width="narrow">
      {/* The wizard reads its step from the URL. */}
      <Suspense>
        <SubmitWizard initialNeed={initialNeed} />
      </Suspense>
    </PageShell>
  );
}
