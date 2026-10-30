import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/alert";
import { buttonVariants } from "@/components/button";

import { SignalErrorAlert } from "../../_components/signal/error-alert";
import { formatDate } from "../../_components/signal/labels";
import { DecisionNote, NeedFacts } from "../../_components/signal/need-card";
import { signalServerClient } from "../../_components/signal/server-client";
import { PageShell } from "../../_components/signal/site-header";

export const metadata: Metadata = { title: "Need · Signal" };

export default async function NeedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await signalServerClient();
  const result = await client.getNeed({ id });

  if (!result.ok) {
    if (result.error.code === "not_found" || result.error.code === "validation_failed") notFound();
    return (
      <PageShell>
        <SignalErrorAlert error={result.error} />
      </PageShell>
    );
  }
  const need = result.data;

  return (
    <PageShell>
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link className="text-muted-foreground underline-offset-4 hover:underline" href="/">
          ← Board
        </Link>
      </nav>
      <article className="flex flex-col gap-5">
        <header className="flex flex-col gap-3">
          <h1 className="text-xl leading-snug font-semibold tracking-tight">{need.statement}</h1>
          <NeedFacts need={need} />
          <p className="text-muted-foreground text-xs">First asked {formatDate(need.createdAt)}</p>
        </header>

        {need.status === "merged" && need.mergedIntoId ? (
          <Alert>
            <AlertTitle>This need was merged</AlertTitle>
            <AlertDescription>
              It describes the same need as another one, where its supporters now count.{" "}
              <Link className="underline underline-offset-4" href={`/needs/${need.mergedIntoId}`}>
                Go to that need
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}

        {need.decision ? (
          <section aria-labelledby="decision" className="flex flex-col gap-2">
            <h2 className="text-sm font-medium" id="decision">
              Decision
            </h2>
            <DecisionNote decision={need.decision} />
          </section>
        ) : null}

        <section aria-labelledby="solutions" className="flex flex-col gap-2">
          <h2 className="text-sm font-medium" id="solutions">
            Proposed solutions
          </h2>
          {need.proposedSolutions.length > 0 ? (
            <ul className="list-disc pl-5 text-sm">
              {need.proposedSolutions.map((solution) => (
                <li key={solution}>{solution}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">None proposed yet.</p>
          )}
        </section>

        <section aria-labelledby="use-cases" className="flex flex-col gap-2">
          <h2 className="text-sm font-medium" id="use-cases">
            How people use it
          </h2>
          <p className="text-muted-foreground text-sm">
            {need.publicSummary ??
              "A product manager hasn't published a summary of use cases yet. Individual requests stay private."}
          </p>
        </section>

        {need.status === "merged" ? null : (
          <div>
            <Link className={buttonVariants()} href={`/submit?need=${need.id}`}>
              Add my voice
            </Link>
          </div>
        )}
      </article>
    </PageShell>
  );
}
