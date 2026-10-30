import type { Metadata } from "next";

import { signalServerClient } from "../_components/signal/server-client";
import { PageShell } from "../_components/signal/site-header";
import { SubmitForm } from "./submit-form";
import type { ChosenNeed } from "./submit-model";

export const metadata: Metadata = {
  description: "Tell us what you need. We'll show requests like yours as you type.",
  title: "Submit a request · Signal",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SubmitPage({ searchParams }: { searchParams: SearchParams }) {
  const { need: needParam } = await searchParams;
  const needId = Array.isArray(needParam) ? needParam[0] : needParam;

  // "Add my voice" from a need page preselects that need.
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
    <PageShell>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Submit a request</h1>
        <p className="text-muted-foreground text-sm">
          Describe what you need in your own words. As you type, we look for needs other customers
          already asked for, so your voice counts where it belongs. Your name, email, and company
          are only shown to the product team.
        </p>
      </header>
      <SubmitForm initialNeed={initialNeed} />
    </PageShell>
  );
}
