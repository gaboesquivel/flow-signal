"use client";

import { cn } from "cn";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ConsoleError } from "@/app/operator/(console)/_components/console-bits";
import { Button } from "@/components/button";
import { LoadingLine } from "@/components/loading-line";
import { RuledList, RuledRow } from "@/components/ruled-list";
import { Textarea } from "@/components/textarea";
import { createSignalClient } from "@/lib/signal/client";
import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

import { formatDate, formatUsd, statusLabels } from "./labels";
import { Pencil } from "./pencil";
import { Status, StatusShape } from "./status";

type ReadyPage = SignalOperations["list_ready_needs"]["output"];
type ReadyNeed = ReadyPage["needs"][number];
type DecisionStatus = SignalOperations["publish_decision"]["input"]["status"];
type ClientError = Pick<SignalClientError, "code" | "message">;

/** A brief as this list shows it: from `list_ready_needs` or a fresh `draft_decision_brief`. */
interface BriefView {
  recommendation: {
    capacityNote?: string | null;
    confidence?: number | null;
    note: string;
    status: DecisionStatus;
    strategyFit?: { inFocus: boolean; reason: string } | null;
  };
  status: "pending" | "accepted" | "edited" | "rejected";
  suggestionId: string;
}

const decisionStatuses: DecisionStatus[] = ["planned", "in_progress", "shipped", "declined"];

const signal = createSignalClient();

const sectionLabel = "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";
const textButton =
  "text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50";

/** The note is the AI's until the PM accepts the brief or rewrites the note. */
const noteState = (pending: boolean, edited: boolean) => {
  if (edited) return "edited";
  return pending ? "suggested" : "accepted";
};

const percent = (confidence: number) => `${Math.round(confidence * 100)}%`;

/** A listed brief whose stored recommendation could not be read shows as "Brief pending". */
const briefView = (brief: ReadyNeed["brief"]): BriefView | null =>
  brief?.recommendation ? { ...brief, recommendation: brief.recommendation } : null;

/** Spec 007 → "Ready to decide": needs past the readiness line, oldest ready first. */
export function ReadyNeeds({ initial }: { initial: ReadyPage }) {
  const [needs, setNeeds] = useState<ReadyNeed[]>(initial.needs);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [briefs, setBriefs] = useState<Record<string, BriefView | null>>(() =>
    Object.fromEntries(initial.needs.map((n) => [n.needId, briefView(n.brief)])),
  );
  const [open, setOpen] = useState<string | null>(initial.needs[0]?.needId ?? null);
  const [published, setPublished] = useState<{ need: ReadyNeed; status: DecisionStatus } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    const result = await signal.listReadyNeeds({ cursor });
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNeeds((prev) => [...prev, ...result.data.needs]);
    setBriefs((prev) => ({
      ...prev,
      ...Object.fromEntries(result.data.needs.map((n) => [n.needId, briefView(n.brief)])),
    }));
    setCursor(result.data.nextCursor);
  };

  const onPublished = (need: ReadyNeed, status: DecisionStatus) => {
    const rest = needs.filter((n) => n.needId !== need.needId);
    setNeeds(rest);
    setOpen(rest[0]?.needId ?? null);
    setPublished({ need, status });
  };

  return (
    <section aria-labelledby="ready-heading" className="flex min-w-0 flex-col gap-4">
      <h2 className={sectionLabel} id="ready-heading">
        Ready to decide · <span className="font-mono tabular-nums">{needs.length}</span>
      </h2>

      {published ? (
        <div aria-live="polite" className="border-rule-strong border-l-[1.5px] py-px pl-3.5">
          <p className="text-sm">
            Published <Status className="mx-0.5 align-middle" status={published.status} /> on{" "}
            <span className="font-serif">{published.need.statement}</span>
          </p>
          <Link
            className="text-primary mt-1 inline-flex items-center gap-1 text-[13px] underline-offset-4 hover:underline"
            href={`/needs/${published.need.needId}`}
            target="_blank"
          >
            See what supporters see <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      ) : null}
      {error ? <ConsoleError error={error} /> : null}

      {needs.length === 0 ? (
        <p className="text-muted-foreground font-serif text-lg">Nothing is ready to decide.</p>
      ) : (
        <RuledList expanded={open} onExpandedChange={setOpen}>
          {needs.map((need) => {
            const brief = briefs[need.needId] ?? null;
            return (
              <RuledRow
                key={need.needId}
                summary={<RowSummary brief={brief} need={need} />}
                value={need.needId}
              >
                {brief ? (
                  <DecidePanel
                    brief={brief}
                    need={need}
                    onBrief={(next) => setBriefs((prev) => ({ ...prev, [need.needId]: next }))}
                    onPublished={(status) => onPublished(need, status)}
                  />
                ) : (
                  <DraftBrief
                    needId={need.needId}
                    onBrief={(next) => setBriefs((prev) => ({ ...prev, [need.needId]: next }))}
                  />
                )}
              </RuledRow>
            );
          })}
        </RuledList>
      )}

      {cursor ? (
        <button
          className={cn(textButton, "self-start")}
          disabled={loadingMore}
          onClick={loadMore}
          type="button"
        >
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </section>
  );
}

/** The one-line head: statement, demand in mono, and the AI's suggestion in pencil. */
function RowSummary({ brief, need }: { brief: BriefView | null; need: ReadyNeed }) {
  const rec = brief?.recommendation;
  const ink = brief !== null && brief.status !== "pending";
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <span className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
        <span className="font-serif text-[17px] leading-snug break-words">{need.statement}</span>
        <span className="text-muted-foreground flex gap-4 font-mono text-[13px] tabular-nums sm:justify-end">
          <span>{formatUsd(need.arrCents)}</span>
          <span>
            <span className="text-foreground">{need.supporters}</span> people
          </span>
          <span>{formatDate(need.readyAt)}</span>
        </span>
      </span>
      {rec ? (
        <span
          className={cn(
            "inline-flex flex-wrap items-center gap-x-1.5 border-l-[1.5px] pl-2.5 text-[13px]",
            ink
              ? "border-rule-strong text-foreground"
              : "border-ai text-ai-foreground border-dashed",
          )}
        >
          <span className="font-serif text-sm italic [font-variant-caps:all-small-caps]">
            {ink ? "Accepted" : "Suggested"}
          </span>
          <StatusShape status={rec.status} />
          {statusLabels[rec.status]}
          {typeof rec.confidence === "number" ? (
            <span className="font-mono tabular-nums">· {percent(rec.confidence)}</span>
          ) : null}
          {rec.strategyFit ? (
            <span>· {rec.strategyFit.inFocus ? "in focus" : "off focus"}</span>
          ) : null}
        </span>
      ) : (
        <span className="text-muted-foreground text-[13px]">Brief pending</span>
      )}
    </span>
  );
}

function DraftBrief({ needId, onBrief }: { needId: string; onBrief: (brief: BriefView) => void }) {
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const draft = async () => {
    setDrafting(true);
    setError(null);
    const result = await signal.draftDecisionBrief({ id: needId });
    setDrafting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const { suggestion } = result.data;
    onBrief({
      recommendation: suggestion.payload.recommendation,
      status: suggestion.status,
      suggestionId: suggestion.id,
    });
  };

  if (drafting)
    return (
      <LoadingLine className="bg-ai-surface rounded-md px-4 py-3">
        Drafting a decision brief…
      </LoadingLine>
    );

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        No brief yet. Signal drafts one when a need becomes ready; draft it now if it hasn’t
        arrived.
      </p>
      {error?.code === "ai_unavailable" ? (
        <p className="text-destructive" role="alert">
          The decision model is unavailable. Try again in a moment.
        </p>
      ) : null}
      {error && error.code !== "ai_unavailable" ? <ConsoleError error={error} /> : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Button onClick={draft}>Draft brief</Button>
        <Link className={textButton} href={`/operator/needs/${needId}#decide`}>
          Open the need
        </Link>
      </div>
    </div>
  );
}

/**
 * The brief's recommendation in pencil (ink once accepted) beside the decision: status and the
 * public note, prefilled from the brief. Publish accepts a pending brief first.
 */
function DecidePanel({
  brief,
  need,
  onBrief,
  onPublished,
}: {
  brief: BriefView;
  need: ReadyNeed;
  onBrief: (brief: BriefView) => void;
  onPublished: (status: DecisionStatus) => void;
}) {
  const rec = brief.recommendation;
  const [status, setStatus] = useState<DecisionStatus>(rec.status);
  const [note, setNote] = useState(rec.note);
  const [busy, setBusy] = useState<"accept" | "publish" | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const pending = brief.status === "pending";
  const statusChanged = status !== rec.status;
  const noteEdited = note.trim() !== rec.note.trim();

  /** Accepts the pending brief; a brief someone already resolved counts as accepted. */
  const accept = async () => {
    if (!pending) return true;
    const result = await signal.resolveSuggestion({ action: "accept", id: brief.suggestionId });
    if (!result.ok && result.error.code !== "conflict") {
      setError(result.error);
      return false;
    }
    onBrief({ ...brief, status: "accepted" });
    return true;
  };

  const acceptOnly = async () => {
    setBusy("accept");
    setError(null);
    await accept();
    setBusy(null);
  };

  const publish = async () => {
    setBusy("publish");
    setError(null);
    if (!(await accept())) {
      setBusy(null);
      return;
    }
    const result = await signal.publishDecision({ id: need.needId, note: note.trim(), status });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onPublished(status);
  };

  return (
    <div className="flex flex-col gap-6 pt-1 text-sm">
      <Pencil label="Recommended direction" state={pending ? "suggested" : "accepted"}>
        <p className="inline-flex flex-wrap items-center gap-x-1.5">
          <StatusShape status={rec.status} />
          <span className="font-medium">{statusLabels[rec.status]}</span>
          {typeof rec.confidence === "number" ? (
            <span className="font-mono tabular-nums">· {percent(rec.confidence)} confident</span>
          ) : null}
        </p>
        {rec.strategyFit || rec.capacityNote ? (
          <dl className="m-0 mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            {rec.strategyFit ? (
              <div className="contents">
                <dt className="opacity-80">{rec.strategyFit.inFocus ? "In focus" : "Off focus"}</dt>
                <dd className="m-0 break-words">{rec.strategyFit.reason}</dd>
              </div>
            ) : null}
            {rec.capacityNote ? (
              <div className="contents">
                <dt className="opacity-80">Capacity</dt>
                <dd className="m-0 break-words">{rec.capacityNote}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </Pencil>

      <div className="grid min-w-0 gap-6 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-8">
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1.5 text-[13px] font-medium">Status</legend>
          {decisionStatuses.map((s) => (
            <label
              className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-sm px-1 py-1.5"
              key={s}
            >
              <input
                checked={status === s}
                className="accent-primary"
                name={`status-${need.needId}`}
                onChange={() => setStatus(s)}
                type="radio"
                value={s}
              />
              <Status status={s} />
              {s === rec.status && !statusChanged && pending ? (
                <span className="text-ai-foreground font-serif text-[13px] italic">suggested</span>
              ) : null}
            </label>
          ))}
        </fieldset>
        <Pencil
          label={pending && !noteEdited ? "Public note · from the brief" : "Public note"}
          state={noteState(pending, noteEdited)}
        >
          <Textarea
            aria-label="Public note"
            className="text-foreground mt-1 font-serif text-[15px]"
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What supporters will read: plain words, no names, accounts, or revenue."
            rows={4}
            value={note}
          />
        </Pencil>
      </div>

      {error ? <ConsoleError error={error} /> : null}

      <div className="border-border flex flex-wrap items-center gap-x-5 gap-y-3 border-t pt-4">
        <Button disabled={busy !== null || note.trim().length === 0} onClick={publish} size="lg">
          {busy === "publish" ? "Publishing…" : "Publish decision"}
        </Button>
        {pending ? (
          <button
            className={textButton}
            disabled={busy !== null}
            onClick={acceptOnly}
            type="button"
          >
            {busy === "accept" ? "Accepting…" : "Accept brief only"}
          </button>
        ) : null}
        <Link className={textButton} href={`/operator/needs/${need.needId}`}>
          Open the need
        </Link>
      </div>
    </div>
  );
}
