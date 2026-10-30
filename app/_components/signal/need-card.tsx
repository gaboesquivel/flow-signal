import Link from "next/link";

import { Badge } from "@/components/badge";

import type { PublicNeed } from "./labels";
import { demandLabels, formatDate, statusLabels, supportersLabel } from "./labels";

export function StatusBadge({ status }: { status: PublicNeed["status"] }) {
  const variant = status === "new" || status === "open" ? "outline" : "secondary";
  return <Badge variant={variant}>{statusLabels[status]}</Badge>;
}

export function NeedFacts({ need }: { need: PublicNeed }) {
  return (
    <ul className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <li>
        <StatusBadge status={need.status} />
      </li>
      {need.theme ? <li>{need.theme.name}</li> : null}
      <li>{supportersLabel(need.supporterCount)}</li>
      <li>{demandLabels[need.demandBand]}</li>
    </ul>
  );
}

export function DecisionNote({ decision }: { decision: NonNullable<PublicNeed["decision"]> }) {
  return (
    <p className="bg-muted/60 rounded-md px-3 py-2 text-sm">
      <span className="font-medium">
        {statusLabels[decision.status]} · {formatDate(decision.publishedAt)}:
      </span>{" "}
      {decision.note}
    </p>
  );
}

/** One need on the board: public fields only (no submitter, account, or verbatim text). */
export function NeedCard({ need }: { need: PublicNeed }) {
  return (
    <article
      aria-labelledby={`need-${need.id}`}
      className="bg-card ring-foreground/10 flex flex-col gap-3 rounded-xl p-4 ring-1"
    >
      <h3 className="leading-snug font-medium" id={`need-${need.id}`}>
        <Link
          className="focus-visible:ring-ring/50 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3"
          href={`/needs/${need.id}`}
        >
          {need.statement}
        </Link>
      </h3>
      <NeedFacts need={need} />
      {need.proposedSolutions.length > 0 ? (
        <p className="text-sm">
          <span className="text-muted-foreground">Proposed solutions: </span>
          {need.proposedSolutions.join(", ")}
        </p>
      ) : null}
      {need.publicSummary ? (
        <p className="text-muted-foreground text-sm">{need.publicSummary}</p>
      ) : null}
      {need.decision ? <DecisionNote decision={need.decision} /> : null}
    </article>
  );
}
