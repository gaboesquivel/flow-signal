import { cn } from "cn";
import Link from "next/link";

import { Quote } from "@/app/_components/signal/quote";
import { StatusShape } from "@/app/_components/signal/status";
import type { SignalClientError } from "@/lib/signal/client";

import type { NeedSignal, OperatorNeedStatus } from "../_lib/console";
import { describeError, formatDate, operatorStatusLabels } from "../_lib/console";

/** Status word plus shape; a draft wears the public "new" shape but says Draft to the PM. */
export function ConsoleStatus({
  className,
  status,
}: {
  className?: string;
  status: OperatorNeedStatus | "merged";
}) {
  return (
    <span
      className={cn(
        "text-foreground inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap",
        className,
      )}
      data-slot="status"
      data-status={status}
    >
      <StatusShape status={status === "draft" ? "new" : status} />
      {operatorStatusLabels[status]}
    </span>
  );
}

const urgencyWords = { high: "High urgency", low: "Low urgency", medium: "Medium urgency" };

/** A customer's words, verbatim, with person · account · plan · urgency · date (PM only). */
export function SignalQuote({ className, signal }: { className?: string; signal: NeedSignal }) {
  const cite = [
    signal.submitter.name ?? signal.submitter.email,
    signal.account ? `${signal.account.name} · ${signal.account.plan}` : null,
    signal.urgency ? urgencyWords[signal.urgency] : null,
    signal.actorKind === "agent" ? `via ${signal.agentClient ?? "agent"}` : null,
    formatDate(signal.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Quote className={className} cite={cite}>
      “{signal.body}”
    </Quote>
  );
}

/** A failed console call in plain words; an ended session links to the access page. */
export function ConsoleError({
  error,
  className,
}: {
  className?: string;
  error: Pick<SignalClientError, "code" | "message">;
}) {
  return (
    <p className={cn("text-destructive text-sm", className)} role="alert">
      {describeError(error)}
      {error.code === "unauthorized" ? (
        <>
          {" "}
          <Link className="underline underline-offset-4" href="/operator/access">
            Operator access
          </Link>
        </>
      ) : null}
    </p>
  );
}

/** Page heading: serif title and one muted line. */
export function ConsoleHeading({ children, title }: { children?: React.ReactNode; title: string }) {
  return (
    <div className="min-w-0">
      <h1 className="font-serif text-3xl font-medium tracking-tight sm:text-4xl">{title}</h1>
      {children ? (
        <p className="text-muted-foreground mt-1 font-serif text-base" aria-live="polite">
          {children}
        </p>
      ) : null}
    </div>
  );
}
