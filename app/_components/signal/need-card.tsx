import Link from "next/link";

import { formatDate, statusLabels } from "./labels";
import type { PublicNeed } from "./labels";
import { InkNote } from "./ink-note";
import { Status } from "./status";

/** People asking: the count in mono, the word in muted text (reads "11 people"). */
export function PeopleCount({ className, count }: { className?: string; count: number }) {
  return (
    <span className={`text-muted-foreground text-[13px] whitespace-nowrap ${className ?? ""}`}>
      <span className="text-foreground mr-1 font-mono text-[17px] font-medium tabular-nums">
        {count}
      </span>
      {count === 1 ? "person" : "people"}
    </span>
  );
}

/** The latest published decision, in ink. */
export function DecisionNote({ decision }: { decision: NonNullable<PublicNeed["decision"]> }) {
  return (
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
  );
}

/**
 * One need on the board as a ruled row: statement, status word and shape, people. Public fields
 * only (no submitter, account, or verbatim text).
 */
export function NeedRow({ need }: { need: PublicNeed }) {
  return (
    <li className="border-border min-w-0 border-b">
      <Link
        className="focus-visible:ring-ring/50 hover:bg-muted/40 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2 rounded-sm py-[18px] outline-none focus-visible:ring-3 sm:grid-cols-[minmax(0,1fr)_120px_84px] sm:gap-x-6 sm:py-5"
        href={`/needs/${need.id}`}
      >
        <span className="col-span-2 font-serif text-lg leading-snug text-pretty break-words sm:col-span-1 sm:text-[19px]">
          {need.statement}
        </span>
        <Status status={need.status} />
        <PeopleCount className="text-right" count={need.supporterCount} />
      </Link>
    </li>
  );
}
