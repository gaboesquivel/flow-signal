import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/empty";
import type { SignalOperations, SignalResult } from "@/lib/signal/client";

import { SignalErrorAlert } from "../../_components/signal/error-alert";
import { formatDate, statusLabels, urgencyLabels } from "../../_components/signal/labels";
import { NeedFacts } from "../../_components/signal/need-card";
import { signalServerClient } from "../../_components/signal/server-client";
import { PageShell } from "../../_components/signal/site-header";

/** A private link: keep it out of search engines and referrers. */
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
  title: "My signals · Signal",
};

type MySignals = SignalOperations["get_my_signals"]["output"];
type MySignal = MySignals["signals"][number];

function SignalItem({ signal }: { signal: MySignal }) {
  return (
    <li className="bg-card ring-foreground/10 flex flex-col gap-4 rounded-xl p-4 ring-1">
      <section aria-label="Your request" className="flex flex-col gap-1">
        <p className="text-muted-foreground text-xs">
          You submitted on {formatDate(signal.submittedAt)}
          {signal.urgency ? ` · urgency ${urgencyLabels[signal.urgency].toLowerCase()}` : ""}
        </p>
        <h2 className="font-medium">{signal.title}</h2>
        <p className="text-sm whitespace-pre-line">{signal.body}</p>
        {signal.useCase ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Use case: </span>
            {signal.useCase}
          </p>
        ) : null}
      </section>

      <section aria-label="The need it counts toward" className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">
          {signal.attachedTo === "existing" ? "You added your voice to" : "You started a new need"}
        </p>
        <Link
          className="leading-snug font-medium underline-offset-4 hover:underline"
          href={`/needs/${signal.need.id}`}
        >
          {signal.need.statement}
        </Link>
        <NeedFacts need={signal.need} />
      </section>

      <section aria-label="Decisions" className="flex flex-col gap-2">
        {signal.decisions.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {signal.decisions.toReversed().map((decision) => (
              <li
                className="bg-muted/60 rounded-md px-3 py-2 text-sm"
                key={`${decision.publishedAt}-${decision.status}`}
              >
                <span className="font-medium">
                  {statusLabels[decision.status]} · {formatDate(decision.publishedAt)}:
                </span>{" "}
                {decision.note}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-sm">
            No decision yet. Updates appear here when a product manager publishes one.
          </p>
        )}
      </section>
    </li>
  );
}

function MySignalsBody({ result }: { result: SignalResult<MySignals> }) {
  if (result.ok)
    return (
      <ol className="flex flex-col gap-4">
        {result.data.signals.map((signal) => (
          <SignalItem key={signal.signalId} signal={signal} />
        ))}
      </ol>
    );
  if (result.error.code !== "not_found" && result.error.code !== "validation_failed")
    return <SignalErrorAlert error={result.error} />;
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>This link doesn&apos;t match any signals</EmptyTitle>
        <EmptyDescription>
          Check that you copied the whole link from your confirmation. Each submission has its own
          link.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link className={buttonVariants({ variant: "outline" })} href="/">
          Browse the board
        </Link>
      </EmptyContent>
    </Empty>
  );
}

export default async function MySignalsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const client = await signalServerClient();
  const result = await client.getMySignals({ token });

  return (
    <PageShell>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">My signals</h1>
        <p className="text-muted-foreground text-sm">
          This private page shows what you submitted and what happened to it. Anyone with the link
          can see it, so share it only with people you trust.
        </p>
      </header>
      <MySignalsBody result={result} />
    </PageShell>
  );
}
