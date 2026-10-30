"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { InkNote } from "@/app/_components/signal/ink-note";
import { Quote } from "@/app/_components/signal/quote";
import { Button } from "@/components/button";
import type { SignalClientError } from "@/lib/signal/client";

import { ConsoleError, ConsoleStatus } from "../../_components/console-bits";
import {
  browserSignal,
  invalidateAfterWrite,
  needDetailKey,
  unwrap,
} from "../../_components/operator-browser";
import type { NeedDetail, NeedSignal } from "../../_lib/console";
import { formatCents, formatDate, formatScore } from "../../_lib/console";
import { decisionStatusLabels } from "../../_lib/decide";
import { DecidePanel } from "./decide-panel";
import { sectionLabel } from "./need-shared";
import { PriorityPanel } from "./priority-panel";

const numberCell = "text-right font-mono text-[13px] tabular-nums";

const urgencyWords = { high: "High urgency", low: "Low urgency", medium: "Medium urgency" };

/** The need page: read the need, then priority, then decide and publish. */
export function NeedView({ initial }: { initial: NeedDetail }) {
  const detail = useQuery({
    initialData: initial,
    queryFn: () => unwrap(browserSignal.getNeedDetail({ id: initial.id })),
    queryKey: needDetailKey(initial.id),
    staleTime: 30_000,
  });
  const need = detail.data;
  const merged = need.status === "merged";
  const arrCents = need.accounts.reduce((sum, account) => sum + account.arrCents, 0);
  const latestDecision = need.decisions
    .toSorted((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .at(0);

  return (
    <article className="flex min-w-0 flex-col gap-10" data-need-detail={need.id}>
      <header className="flex flex-col gap-4">
        <Link
          className="text-muted-foreground inline-flex w-fit items-center gap-1 text-sm underline-offset-4 hover:underline"
          href="/operator/needs"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" /> Needs
        </Link>
        <h1 className="font-serif text-[26px] leading-snug font-medium tracking-tight text-pretty break-words sm:text-[32px]">
          {need.statement}
        </h1>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 text-[13px]">
          <ConsoleStatus status={need.status} />
          {need.theme ? <span className="text-muted-foreground">{need.theme.name}</span> : null}
          <Figure label="people" value={String(need.supporterCount)} />
          <Figure label="accounts" value={String(need.accounts.length)} />
          <Figure label="ARR" value={formatCents(arrCents)} />
          <Figure label="score" value={formatScore(need.priorityScore)} />
        </div>
        {merged ? null : (
          <nav aria-label="On this page" className="text-muted-foreground flex gap-4 text-xs">
            <a className="underline-offset-4 hover:underline" href="#signals">
              Signals
            </a>
            <a className="underline-offset-4 hover:underline" href="#priority">
              Priority
            </a>
            <a className="text-primary underline-offset-4 hover:underline" href="#decide">
              Decide
            </a>
          </nav>
        )}
      </header>

      {merged && need.mergedIntoId ? (
        <p className="border-rule-strong border-l-[1.5px] pl-3.5 text-[15px]">
          This need was merged into another; its signals and decisions live there.{" "}
          <Link
            className="text-primary underline underline-offset-4"
            href={`/operator/needs/${need.mergedIntoId}`}
          >
            Go to that need
          </Link>
        </p>
      ) : null}

      <div className="flex flex-col gap-6">
        {latestDecision ? (
          <InkNote
            label={
              <>
                Decision · {decisionStatusLabels[latestDecision.status]}{" "}
                <span className="text-muted-foreground font-mono text-xs [font-variant-caps:normal]">
                  {formatDate(latestDecision.publishedAt)}
                </span>
              </>
            }
          >
            {latestDecision.note}
          </InkNote>
        ) : null}
        {need.publicSummary && need.publicSummaryStatus === "approved" ? (
          <InkNote label="Approved summary">{need.publicSummary}</InkNote>
        ) : (
          <p className="text-muted-foreground text-sm">
            {need.publicSummaryStatus === "pending"
              ? "A public summary is waiting in Triage."
              : "No approved public summary yet."}
          </p>
        )}
        <section aria-labelledby="solutions" className="flex flex-col gap-2">
          <h2 className={sectionLabel} id="solutions">
            Proposed solutions
          </h2>
          {need.proposedSolutions.length > 0 ? (
            <ul className="border-rule-strong m-0 list-none border-t p-0">
              {need.proposedSolutions.map((solution) => (
                <li
                  className="border-border border-b py-2.5 text-[15px] break-words"
                  key={solution.id}
                >
                  {solution.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">None proposed yet.</p>
          )}
        </section>
      </div>

      <section aria-labelledby="signals" className="flex scroll-mt-6 flex-col gap-5">
        <h2 className={sectionLabel} id="signals">
          What people wrote · {need.signals.length}
        </h2>
        {need.signals.length === 0 ? (
          <p className="text-muted-foreground text-sm">No signals on this need.</p>
        ) : (
          need.signals
            .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map((signal) => <SignalEntry key={signal.id} signal={signal} />)
        )}
      </section>

      <AccountsTable accounts={need.accounts} />

      <MergeHistory need={need} />

      {merged ? null : (
        <>
          <PriorityPanel need={need} />
          <DecidePanel need={need} />
        </>
      )}
    </article>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-muted-foreground whitespace-nowrap">
      <span className="text-foreground font-mono tabular-nums">{value}</span> {label}
    </span>
  );
}

/** A customer's words verbatim, with who, where from, and how it affects them (PM only). */
function SignalEntry({ signal }: { signal: NeedSignal }) {
  const who = signal.submitter.name ?? signal.submitter.email;
  const cite = [
    who,
    signal.account
      ? `${signal.account.name} · ${signal.account.plan} · ${formatCents(signal.account.arrCents)} ARR`
      : null,
    signal.urgency ? urgencyWords[signal.urgency] : null,
    signal.channel === "mcp" || signal.actorKind === "agent"
      ? `via ${signal.agentClient ?? "agent"}`
      : "web",
    formatDate(signal.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Quote
      cite={
        <>
          <span className="block">{cite}</span>
          {signal.useCase ? (
            <span className="text-foreground/80 mt-1 block font-serif text-[15px] italic">
              <span className="text-muted-foreground font-sans text-xs not-italic">
                How it affects them:{" "}
              </span>
              “{signal.useCase}”
            </span>
          ) : null}
        </>
      }
    >
      <span className="block font-medium not-italic">{signal.title}</span>“{signal.body}”
    </Quote>
  );
}

function AccountsTable({ accounts }: { accounts: NeedDetail["accounts"] }) {
  return (
    <section aria-labelledby="accounts" className="flex flex-col gap-2">
      <h2 className={sectionLabel} id="accounts">
        Accounts · {accounts.length}
      </h2>
      {accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">No accounts linked.</p>
      ) : (
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-rule-strong text-muted-foreground border-b text-[11px] tracking-[0.08em] uppercase">
              <th className="py-2 text-left font-semibold">Account</th>
              <th className="hidden w-24 py-2 text-left font-semibold sm:table-cell">Plan</th>
              <th className="w-16 py-2 text-right font-semibold">People</th>
              <th className="w-20 py-2 text-right font-semibold">ARR</th>
              <th className="hidden w-24 py-2 text-right font-semibold sm:table-cell">
                Open deals
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr className="border-border border-b" key={account.id}>
                <td className="truncate py-2.5">
                  {account.name}
                  <span className="text-muted-foreground sm:hidden"> · {account.plan}</span>
                </td>
                <td className="text-muted-foreground hidden py-2.5 sm:table-cell">
                  {account.plan}
                </td>
                <td className={`${numberCell} py-2.5`}>{account.supporters}</td>
                <td className={`${numberCell} py-2.5`}>{formatCents(account.arrCents)}</td>
                <td className={`${numberCell} hidden py-2.5 sm:table-cell`}>
                  {account.openDealCents > 0 ? formatCents(account.openDealCents) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Merges into and out of this need, newest first; a live merge keeps Undo merge. */
function MergeHistory({ need }: { need: NeedDetail }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Pick<SignalClientError, "code" | "message"> | null>(null);
  const statements = new Map<string, string>();
  for (const suggestion of need.suggestions)
    for (const ref of [suggestion.need, suggestion.relatedNeed])
      if (ref) statements.set(ref.id, ref.statement);

  const undo = async (mergeId: string) => {
    setBusy(mergeId);
    setError(null);
    const result = await browserSignal.undoMerge({ id: mergeId });
    setBusy(null);
    if (!result.ok) setError(result.error);
    await invalidateAfterWrite(queryClient);
  };

  return (
    <section aria-labelledby="merges" className="flex flex-col gap-2">
      <h2 className={sectionLabel} id="merges">
        Merge history
      </h2>
      {need.merges.length === 0 ? (
        <p className="text-muted-foreground text-sm">No merges.</p>
      ) : (
        <ul className="border-rule-strong m-0 list-none border-t p-0">
          {need.merges.map((merge) => {
            const into = merge.intoNeedId === need.id;
            const otherId = into ? merge.fromNeedId : merge.intoNeedId;
            const other = statements.get(otherId) ?? "another need";
            return (
              <li
                className="border-border flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b py-2.5"
                data-merge={merge.id}
                key={merge.id}
              >
                <span className="min-w-0 flex-1 text-[15px]">
                  {into ? "Merged in from " : "Merged into "}
                  <Link
                    className="font-serif underline-offset-4 hover:underline"
                    href={`/operator/needs/${otherId}`}
                  >
                    {other}
                  </Link>
                  <span className="text-muted-foreground text-xs">
                    {" "}
                    · {merge.movedSignalIds.length}{" "}
                    {merge.movedSignalIds.length === 1 ? "signal" : "signals"} ·{" "}
                    <span className="font-mono">{formatDate(merge.createdAt)}</span>
                    {merge.undoneAt ? ` · undone ${formatDate(merge.undoneAt)}` : ""}
                  </span>
                </span>
                {merge.undoneAt ? null : (
                  <Button
                    disabled={busy !== null}
                    onClick={() => undo(merge.id)}
                    size="sm"
                    variant="ghost"
                  >
                    {busy === merge.id ? "Undoing…" : "Undo merge"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error ? <ConsoleError error={error} /> : null}
    </section>
  );
}
