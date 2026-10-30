"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { LoadingLine } from "@/components/loading-line";
import { ReadingPair, ReadingPane } from "@/components/reading-pair";

import { ConsoleError, SignalQuote } from "../_components/console-bits";
import { OperatorCallError, useNeedDetail } from "../_components/operator-browser";
import type { NeedDetail, Proposal, SuggestionView } from "../_lib/console";
import { mostUrgentSignals, operatorStatusLabels } from "../_lib/console";

const errorOf = (error: unknown) => (error instanceof OperatorCallError ? error.error : null);

const signalsLabel = (count: number) => (count === 1 ? "1 signal" : `${count} signals`);

/** One side of a merge: status, signal count, statement, and its most urgent quote. */
function MergeSide({
  detail,
  fallback,
  label,
}: {
  detail: NeedDetail | undefined;
  fallback: { id: string; statement: string; status: string } | null;
  label: string;
}) {
  const status = detail?.status ?? fallback?.status;
  const quote = detail ? mostUrgentSignals(detail.signals, 1)[0] : undefined;
  return (
    <ReadingPane
      label={
        <>
          {label}
          {status ? ` · ${operatorStatusLabels[status as "open"] ?? status}` : ""}
          {detail ? ` · ${signalsLabel(detail.signals.length)}` : ""}
        </>
      }
    >
      <p className="font-serif text-lg leading-snug">{detail?.statement ?? fallback?.statement}</p>
      {quote ? <SignalQuote className="mt-4" signal={quote} /> : null}
      {fallback ? (
        <Link
          className="text-primary mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
          href={`/operator/needs/${fallback.id}`}
        >
          Open need <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      ) : null}
    </ReadingPane>
  );
}

/** Merge: read from ↔ into side by side (the need it would join first on phone). */
export function MergePanel({
  outcome,
  proposal,
  suggestion,
}: {
  outcome: { action: string; undone?: boolean } | undefined;
  proposal: Proposal;
  suggestion: SuggestionView;
}) {
  const intoId = proposal.intoNeedId || suggestion.relatedNeedId;
  const from = useNeedDetail(suggestion.needId);
  const into = useNeedDetail(intoId);
  const intoData = into.data
    ? { id: into.data.id, statement: into.data.statement, status: into.data.status }
    : null;
  const intoFallback = intoId === suggestion.relatedNeed?.id ? suggestion.relatedNeed : intoData;
  const error = errorOf(from.error) ?? errorOf(into.error);

  return (
    <div className="flex flex-col gap-4">
      <ReadingPair>
        <MergeSide detail={from.data} fallback={suggestion.need} label="From" />
        <MergeSide
          detail={into.data}
          fallback={intoFallback}
          label={outcome && outcome.action !== "reject" && !outcome.undone ? "Merged into" : "Into"}
        />
      </ReadingPair>
      {from.isPending && Boolean(suggestion.needId) ? (
        <LoadingLine className="py-0 [&_p]:text-sm">Reading both needs…</LoadingLine>
      ) : null}
      {error ? <ConsoleError error={error} /> : null}
    </div>
  );
}

/** The need's verbatim signals (most urgent first), or only those listed in `only`. */
export function NeedSignals({
  label = "What people wrote",
  needId,
  only,
}: {
  label?: string;
  needId: string | null;
  only?: string[];
}) {
  const detail = useNeedDetail(needId);
  if (detail.isPending && needId)
    return <LoadingLine className="py-0 [&_p]:text-sm">Reading signals…</LoadingLine>;
  if (detail.error) {
    const error = errorOf(detail.error);
    return error ? <ConsoleError error={error} /> : null;
  }
  if (!detail.data) return null;
  const signals = only
    ? detail.data.signals.filter((signal) => only.includes(signal.id))
    : mostUrgentSignals(detail.data.signals, 2);
  if (signals.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
        {label}
        {only ? ` · ${signals.length} of ${detail.data.signals.length}` : ""}
      </h3>
      {signals.slice(0, only ? 4 : 2).map((signal) => (
        <SignalQuote key={signal.id} signal={signal} />
      ))}
      {only && signals.length > 4 ? (
        <p className="text-muted-foreground text-xs">and {signals.length - 4} more</p>
      ) : null}
    </section>
  );
}

/** Split edit: choose which of the need's signals move to the new need. */
export function SplitSignals({
  detail,
  onChange,
  selected,
}: {
  detail: NeedDetail | undefined;
  onChange: (signalIds: string[]) => void;
  selected: string[];
}) {
  if (!detail) return <LoadingLine className="py-0 [&_p]:text-sm">Reading signals…</LoadingLine>;
  return (
    <fieldset className="flex flex-col">
      <legend className="text-muted-foreground mb-1.5 text-xs">
        Signals that move ({selected.length} of {detail.signals.length})
      </legend>
      {detail.signals.map((signal) => (
        <label
          className="border-border flex cursor-pointer items-start gap-3 border-b py-2"
          key={signal.id}
        >
          <input
            checked={selected.includes(signal.id)}
            className="accent-primary mt-1"
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, signal.id]
                  : selected.filter((id) => id !== signal.id),
              )
            }
            type="checkbox"
          />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 font-serif text-[15px] italic">“{signal.body}”</span>
            <span className="text-muted-foreground text-xs">
              {signal.submitter.name ?? signal.submitter.email}
              {signal.account ? ` · ${signal.account.name}` : ""}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
