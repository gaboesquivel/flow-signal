"use client";

import { cn } from "cn";
import { ArrowDown, ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import { debounce, useQueryStates } from "nuqs";
import { useState, useTransition } from "react";

import { NativeSelect, NativeSelectOption } from "@/components/native-select";
import { RuledList, RuledRow } from "@/components/ruled-list";

import {
  ConsoleError,
  ConsoleHeading,
  ConsoleStatus,
  SignalQuote,
} from "../_components/console-bits";
import { OperatorCallError, useNeedDetail } from "../_components/operator-browser";
import type { SignalClientError } from "@/lib/signal/client";

import type { NeedDetail, OperatorNeed, OperatorNeedSort } from "../_lib/console";
import {
  criterionKeys,
  criterionLabels,
  formatCents,
  formatScore,
  mostUrgentSignals,
  operatorStatusLabels,
  sortLabels,
} from "../_lib/console";
import { needsParsers, needsSorts, needsStatuses } from "../_lib/needs-params";

/** Shared column template: score · need · theme · status · people · accounts · ARR. */
const columns =
  "grid grid-cols-[4.5rem_minmax(0,1fr)_3.25rem] items-baseline gap-x-2 md:grid-cols-[4.75rem_minmax(0,1fr)_8rem_6.5rem_3.5rem_4.5rem_4.5rem] md:gap-x-4";

const numberCell = "text-right font-mono text-[13px] tabular-nums";

export function NeedsView({
  needs,
  themes,
}: {
  needs: OperatorNeed[];
  themes: { id: string; name: string }[];
}) {
  const [loading, startTransition] = useTransition();
  const [params, setParams] = useQueryStates(needsParsers, { shallow: false, startTransition });
  const [query, setQuery] = useState(params.q);
  const [expanded, setExpanded] = useState<string | null>(null);

  const sortButton = (sort: OperatorNeedSort, className?: string) => {
    const active = params.sort === sort;
    return (
      <button
        aria-label={`Sort by ${sortLabels[sort]}`}
        aria-pressed={active}
        className={cn(
          "focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-sm uppercase outline-none focus-visible:ring-3",
          active ? "text-foreground" : "hover:text-foreground",
          className,
        )}
        onClick={() => setParams({ sort })}
        type="button"
      >
        {sortLabels[sort]}
        {active ? <ArrowDown aria-hidden="true" className="size-3" /> : null}
      </button>
    );
  };

  const filtered = Boolean(params.q || params.status || params.theme);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <ConsoleHeading title="Needs">
          {needs.length === 1 ? "1 need" : `${needs.length} needs`} · sorted by{" "}
          {sortLabels[params.sort].toLowerCase()}
        </ConsoleHeading>
        <label className="relative w-full sm:w-72">
          <span className="sr-only">Search needs</span>
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <input
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-lg border bg-transparent pr-2.5 pl-8 text-sm outline-none focus-visible:ring-3"
            onChange={(event) => {
              setQuery(event.target.value);
              setParams(
                { q: event.target.value || null },
                { limitUrlUpdates: event.target.value ? debounce(300) : undefined },
              );
            }}
            placeholder="Search needs"
            type="search"
            value={query}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
        <label className="text-muted-foreground flex items-center gap-2">
          Theme
          <NativeSelect
            onChange={(event) => setParams({ theme: event.target.value || null })}
            size="sm"
            value={params.theme ?? ""}
          >
            <NativeSelectOption value="">All</NativeSelectOption>
            {themes.map((theme) => (
              <NativeSelectOption key={theme.id} value={theme.id}>
                {theme.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-muted-foreground flex items-center gap-2">
          Status
          <NativeSelect
            onChange={(event) =>
              setParams({
                status: (event.target.value || null) as (typeof needsStatuses)[number] | null,
              })
            }
            size="sm"
            value={params.status ?? ""}
          >
            <NativeSelectOption value="">All</NativeSelectOption>
            {needsStatuses.map((status) => (
              <NativeSelectOption key={status} value={status}>
                {operatorStatusLabels[status]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-muted-foreground flex items-center gap-2 md:hidden">
          Sort
          <NativeSelect
            onChange={(event) => setParams({ sort: event.target.value as OperatorNeedSort })}
            size="sm"
            value={params.sort}
          >
            {needsSorts.map((sort) => (
              <NativeSelectOption key={sort} value={sort}>
                {sortLabels[sort]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {filtered ? (
          <button
            className="text-primary underline-offset-4 hover:underline"
            onClick={() => {
              setQuery("");
              setParams({ q: null, status: null, theme: null });
            }}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
        <span className="text-ai-foreground ml-auto inline-flex items-center gap-1.5 font-mono text-xs max-sm:hidden">
          <PendingMark /> pending in Triage
        </span>
      </div>

      <div
        aria-busy={loading}
        className={cn("min-w-0 transition-opacity", loading && "opacity-60")}
      >
        <div
          className={cn(
            columns,
            "text-muted-foreground border-rule-strong border-b pr-8 pb-2 text-[11px] font-semibold tracking-[0.08em] uppercase",
          )}
          data-testid="needs-header"
        >
          {sortButton("priority", "justify-self-start")}
          <span>Need</span>
          <span className="max-md:hidden">Theme</span>
          <span className="max-md:hidden">Status</span>
          {sortButton("people", "justify-self-end")}
          {sortButton("accounts", "justify-self-end max-md:hidden")}
          {sortButton("arr", "justify-self-end max-md:hidden")}
        </div>

        {needs.length === 0 ? (
          <p className="text-muted-foreground py-6">
            {filtered ? "No needs match these filters." : "No needs yet."}
          </p>
        ) : (
          <RuledList
            aria-label="Needs"
            className="border-t-0"
            expanded={expanded}
            onExpandedChange={setExpanded}
          >
            {needs.map((need) => (
              <RuledRow
                data-need={need.id}
                data-status={need.status}
                key={need.id}
                summary={
                  <span className={columns}>
                    <span className={cn(numberCell, "text-left text-sm")} data-testid="need-score">
                      {formatScore(need.score)}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-serif text-[15px] leading-snug">
                        {need.statement}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <ConsoleStatus className="md:hidden" status={need.status} />
                        {need.pendingSuggestions > 0 ? (
                          <span
                            className="text-ai-foreground inline-flex items-center gap-1.5 font-mono text-xs"
                            data-testid="pending-marker"
                          >
                            <PendingMark /> {need.pendingSuggestions} pending
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-[13px] max-md:hidden">
                      {need.theme?.name ?? "—"}
                    </span>
                    <span className="max-md:hidden">
                      <ConsoleStatus status={need.status} />
                    </span>
                    <span className={numberCell} data-testid="need-people">
                      {need.people}
                    </span>
                    <span className={cn(numberCell, "max-md:hidden")}>{need.accounts}</span>
                    <span className={cn(numberCell, "max-md:hidden")} data-testid="need-arr">
                      {formatCents(need.arrCents)}
                    </span>
                  </span>
                }
                value={need.id}
              >
                <NeedPanel need={need} />
              </RuledRow>
            ))}
          </RuledList>
        )}
      </div>
    </div>
  );
}

/** Pencil marker: a dashed circle, AI work waiting in Triage. */
function PendingMark() {
  return (
    <svg aria-hidden="true" className="size-2.5" viewBox="0 0 10 10">
      <circle
        cx="5"
        cy="5"
        fill="none"
        r="4"
        stroke="currentColor"
        strokeDasharray="2 1.5"
        strokeWidth="1.2"
      />
    </svg>
  );
}

const sourceLabels = { ai: "AI", pm: "PM" } as const;

function UrgentSignals({
  detail,
  error,
  pending,
}: {
  detail: NeedDetail | undefined;
  error: Pick<SignalClientError, "code" | "message"> | null;
  pending: boolean;
}) {
  if (pending) return <p className="text-muted-foreground text-sm">Reading signals…</p>;
  if (error) return <ConsoleError error={error} />;
  if (!detail || detail.signals.length === 0)
    return <p className="text-muted-foreground text-sm">No signals on this need.</p>;
  return mostUrgentSignals(detail.signals).map((signal) => (
    <SignalQuote key={signal.id} signal={signal} />
  ));
}

/** An open row: the two most urgent verbatim signals and the score breakdown. */
function NeedPanel({ need }: { need: OperatorNeed }) {
  const detail = useNeedDetail(need.id);
  const error = detail.error instanceof OperatorCallError ? detail.error.error : null;
  const scores = new Map((detail.data?.scores ?? []).map((score) => [score.criterion, score]));

  return (
    <div className="grid min-w-0 gap-8 pt-1 md:grid-cols-[minmax(0,1fr)_16rem] md:pl-[5.75rem]">
      <section className="flex min-w-0 flex-col gap-4">
        <h3 className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
          Most urgent signals
        </h3>
        <UrgentSignals detail={detail.data} error={error} pending={detail.isPending} />
        <p className="text-muted-foreground font-mono text-xs tabular-nums md:hidden">
          {need.accounts} accounts · {formatCents(need.arrCents)} ARR
          {need.theme ? ` · ${need.theme.name}` : ""}
        </p>
        <Link
          className="text-primary inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
          href={`/operator/needs/${need.id}`}
        >
          Open need <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
          Score breakdown
        </h3>
        {need.criterionScores ? (
          <dl className="m-0 grid grid-cols-[1fr_auto_auto] items-baseline gap-x-3 gap-y-1.5 text-[13px]">
            {criterionKeys.map((key) => {
              const value = need.criterionScores?.[key] ?? null;
              const source = scores.get(key)?.source;
              return (
                <div className="contents" key={key}>
                  <dt>{criterionLabels[key]}</dt>
                  <dd className="text-muted-foreground m-0 text-[11px]">
                    {source ? sourceLabels[source] : ""}
                  </dd>
                  <dd className={cn(numberCell, "m-0")}>
                    {value === null ? "—" : value.toFixed(1)}
                  </dd>
                </div>
              );
            })}
            <div aria-hidden="true" className="border-border col-span-3 border-t" />
            <dt className="font-medium">Priority</dt>
            <dd className="m-0" />
            <dd className={cn(numberCell, "m-0 font-medium")}>{formatScore(need.score)}</dd>
          </dl>
        ) : (
          <p className="text-muted-foreground text-[13px]">
            Not scored yet. A priority suggestion appears in Triage once AI scores it.
          </p>
        )}
      </section>
    </div>
  );
}
