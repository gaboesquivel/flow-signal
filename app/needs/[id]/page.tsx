import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/button";

import { DemandBand } from "../../_components/signal/demand-band";
import { SignalErrorAlert } from "../../_components/signal/error-alert";
import { InkNote } from "../../_components/signal/ink-note";
import { formatDate } from "../../_components/signal/labels";
import { DecisionNote, PeopleCount } from "../../_components/signal/need-card";
import { signalServerClient } from "../../_components/signal/server-client";
import { PageShell } from "../../_components/signal/site-header";
import { Status } from "../../_components/signal/status";

export const metadata: Metadata = { title: "Need · Signal" };

const sectionLabel = "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";

export default async function NeedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await signalServerClient();
  const result = await client.getNeed({ id });

  if (!result.ok) {
    if (result.error.code === "not_found" || result.error.code === "validation_failed") notFound();
    return (
      <PageShell width="narrow">
        <SignalErrorAlert error={result.error} retryHref={`/needs/${id}`} />
      </PageShell>
    );
  }
  const need = result.data;

  return (
    <PageShell width="narrow">
      <nav aria-label="Breadcrumb" className="-mb-4 text-sm">
        <Link className="text-muted-foreground underline-offset-4 hover:underline" href="/">
          ← Board
        </Link>
      </nav>
      <article className="flex min-w-0 flex-col gap-8">
        <header className="flex flex-col gap-4">
          <h1 className="font-serif text-[26px] leading-snug font-medium tracking-tight text-pretty break-words sm:text-[30px]">
            {need.statement}
          </h1>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <Status status={need.status} />
            <PeopleCount count={need.supporterCount} />
            <DemandBand band={need.demandBand} />
            {need.theme ? (
              <span className="text-muted-foreground text-[13px]">{need.theme.name}</span>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            First asked <span className="font-mono">{formatDate(need.createdAt)}</span>
          </p>
        </header>

        {need.status === "merged" && need.mergedIntoId ? (
          <p className="border-rule-strong border-l-[1.5px] pl-3.5 text-[15px]">
            This need was merged into another that describes the same thing; its people now count
            there.{" "}
            <Link
              className="text-primary underline underline-offset-4"
              href={`/needs/${need.mergedIntoId}`}
            >
              Go to that need
            </Link>
          </p>
        ) : null}

        {need.decision ? <DecisionNote decision={need.decision} /> : null}

        {need.publicSummary ? (
          <InkNote label="How people use it">{need.publicSummary}</InkNote>
        ) : (
          <p className="text-muted-foreground text-[15px]">
            No summary yet. What each person wrote stays private to the product team.
          </p>
        )}

        <section aria-labelledby="solutions" className="flex flex-col gap-2">
          <h2 className={sectionLabel} id="solutions">
            Proposed solutions
          </h2>
          {need.proposedSolutions.length > 0 ? (
            <ul className="border-rule-strong m-0 list-none border-t p-0">
              {need.proposedSolutions.map((solution) => (
                <li className="border-border border-b py-3 text-[15px] break-words" key={solution}>
                  {solution}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-[15px]">None proposed yet.</p>
          )}
        </section>

        {need.status === "merged" ? null : (
          <div className="pt-2">
            <Link className={buttonVariants({ size: "lg" })} href={`/submit?need=${need.id}`}>
              Add my voice
            </Link>
          </div>
        )}
      </article>
    </PageShell>
  );
}
