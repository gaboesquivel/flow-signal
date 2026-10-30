import type { Metadata } from "next";
import Link from "next/link";

import type { SignalOperations, SignalResult } from "@/lib/signal/client";

import { SignalErrorAlert } from "../../_components/signal/error-alert";
import { InkNote } from "../../_components/signal/ink-note";
import { formatDate, statusLabels, urgencyLabels } from "../../_components/signal/labels";
import { PeopleCount } from "../../_components/signal/need-card";
import { Quote } from "../../_components/signal/quote";
import { signalServerClient } from "../../_components/signal/server-client";
import { PageHeading, PageShell } from "../../_components/signal/site-header";
import { Status } from "../../_components/signal/status";
import { SuggestedMatch } from "./suggested-match";

/** A private link: keep it out of search engines and referrers. */
export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
  title: "My signals · Signal",
};

type MySignals = SignalOperations["get_my_signals"]["output"];
type MySignal = MySignals["signals"][number];

const label = "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";

/** One signal: your words, the need it counts toward, and every decision published on it. */
function SignalItem({ signal, token }: { signal: MySignal; token: string }) {
  return (
    <li className="border-border flex min-w-0 flex-col gap-6 border-b py-8" data-testid="my-signal">
      <section aria-label="Your request" className="flex flex-col gap-3">
        <p className="text-muted-foreground text-xs">
          You wrote on <span className="font-mono">{formatDate(signal.submittedAt)}</span>
          {signal.urgency ? ` · ${urgencyLabels[signal.urgency]} urgency` : ""}
        </p>
        <Quote>
          <span className="font-medium not-italic">{signal.title}</span>
          <span className="mt-1.5 block whitespace-pre-line">{signal.body}</span>
        </Quote>
        {signal.useCase ? (
          <p className="text-[15px] break-words">
            <span className="text-muted-foreground">How it affects you: </span>
            {signal.useCase}
          </p>
        ) : null}
      </section>

      <section aria-label="The need it counts toward" className="flex flex-col gap-2.5">
        <p className={label}>
          {signal.attachedTo === "existing" ? "You added your voice to" : "You started a new need"}
        </p>
        <Link
          className="font-serif text-lg leading-snug break-words underline-offset-4 hover:underline"
          href={`/needs/${signal.need.id}`}
        >
          {signal.need.statement}
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <Status status={signal.need.status} />
          <PeopleCount count={signal.need.supporterCount} />
        </div>
      </section>

      {signal.suggestedMatches.map((match) => (
        <SuggestedMatch key={match.suggestionId} match={match} token={token} />
      ))}

      {signal.decisions.length > 0 ? (
        <ol aria-label="Decisions" className="m-0 flex list-none flex-col gap-4 p-0">
          {signal.decisions.toReversed().map((decision) => (
            <li key={`${decision.publishedAt}-${decision.status}`}>
              <InkNote
                label={
                  <>
                    Decision · {statusLabels[decision.status]}{" "}
                    <span className="text-muted-foreground font-mono text-xs [font-variant-caps:normal]">
                      {formatDate(decision.publishedAt)}
                    </span>
                  </>
                }
              >
                {decision.note}
              </InkNote>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground text-sm">
          No decision yet. It appears here when the product team publishes one.
        </p>
      )}
    </li>
  );
}

function MySignalsBody({ result, token }: { result: SignalResult<MySignals>; token: string }) {
  if (result.ok)
    return (
      <ol
        aria-label="Your signals, newest first"
        className="border-rule-strong m-0 list-none border-t p-0"
      >
        {result.data.signals.map((signal) => (
          <SignalItem key={signal.signalId} signal={signal} token={token} />
        ))}
      </ol>
    );
  if (result.error.code !== "not_found" && result.error.code !== "validation_failed")
    return <SignalErrorAlert error={result.error} retryHref={`/my/${token}`} />;
  return (
    <div className="flex flex-col items-start gap-3 border-t py-8">
      <p className="font-serif text-xl">This link doesn&apos;t match any signals.</p>
      <p className="text-muted-foreground text-[15px]">
        Check that you copied the whole link from your confirmation.
      </p>
      <Link className="text-primary text-sm underline-offset-4 hover:underline" href="/">
        Browse the board
      </Link>
    </div>
  );
}

export default async function MySignalsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const client = await signalServerClient();
  const result = await client.getMySignals({ token });
  const count = result.ok ? result.data.signals.length : 0;

  return (
    <PageShell width="narrow">
      <PageHeading
        lede={
          <>
            Everything filed under this private link and what happened to it. Anyone with the link
            can see it, so share it only with people you trust.
            {count > 1 ? (
              <span className="text-foreground mt-1 block">
                <span className="font-mono">{count}</span> requests, newest first.
              </span>
            ) : null}
          </>
        }
      >
        My signals
      </PageHeading>
      <MySignalsBody result={result} token={token} />
      {result.ok ? (
        <p className="text-muted-foreground -mt-4 text-sm">
          Need something else?{" "}
          <Link className="text-primary underline-offset-4 hover:underline" href="/submit">
            Submit a request
          </Link>{" "}
          from the browser you used before and it lands on this page too.
        </p>
      ) : null}
    </PageShell>
  );
}
