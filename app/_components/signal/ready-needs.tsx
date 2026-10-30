"use client";

import { useState } from "react";

import { Button } from "@/components/button";
import { Label } from "@/components/label";
import { NativeSelect, NativeSelectOption } from "@/components/native-select";
import { Textarea } from "@/components/textarea";
import { createSignalClient } from "@/lib/signal/client";
import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

import { SignalErrorAlert } from "./error-alert";
import { formatDate, formatUsd, statusLabels, supportersLabel } from "./labels";

type ReadyPage = SignalOperations["list_ready_needs"]["output"];
type ReadyNeed = ReadyPage["needs"][number];
type DecisionStatus = SignalOperations["publish_decision"]["input"]["status"];

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

/** AI output in pencil (DESIGN.md): dashed AI rule, AI text, italic small-caps label. */
const pencil = "border-ai text-ai-foreground border-l-[1.5px] border-dashed pl-3";
const pencilLabel = "font-serif text-xs italic [font-variant-caps:all-small-caps]";

const percent = (confidence: number) => `${Math.round(confidence * 100)}%`;

/** Spec 007 → "Ready to decide": needs past the readiness line, oldest ready first. */
export function ReadyNeeds({ initial }: { initial: ReadyPage }) {
  const [needs, setNeeds] = useState<ReadyNeed[]>(initial.needs);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [briefs, setBriefs] = useState<Record<string, BriefView | null>>(() =>
    Object.fromEntries(initial.needs.map((n) => [n.needId, n.brief])),
  );
  const [open, setOpen] = useState<string | null>(initial.needs[0]?.needId ?? null);
  const [published, setPublished] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SignalClientError | null>(null);

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
      ...Object.fromEntries(result.data.needs.map((n) => [n.needId, n.brief])),
    }));
    setCursor(result.data.nextCursor);
  };

  const onPublished = (need: ReadyNeed, status: DecisionStatus) => {
    setNeeds((prev) => prev.filter((n) => n.needId !== need.needId));
    setOpen(null);
    setPublished(`Published “${statusLabels[status]}” on ${need.statement}`);
  };

  return (
    <section aria-labelledby="ready-heading" className="space-y-3">
      <header className="flex items-baseline justify-between gap-4 border-b pb-2">
        <h2 className="font-serif text-lg" id="ready-heading">
          Ready to decide
        </h2>
        <p className="text-muted-foreground font-mono text-xs">{needs.length}</p>
      </header>

      {published ? (
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {published}
        </p>
      ) : null}
      {error ? <SignalErrorAlert error={error} /> : null}

      {needs.length === 0 ? (
        <p className="text-muted-foreground py-6 text-sm">Nothing is ready to decide.</p>
      ) : (
        <ul className="divide-y border-b">
          {needs.map((need) => (
            <ReadyRow
              brief={briefs[need.needId] ?? null}
              key={need.needId}
              need={need}
              onBrief={(brief) => setBriefs((prev) => ({ ...prev, [need.needId]: brief }))}
              onPublished={(status) => onPublished(need, status)}
              onToggle={() => setOpen((id) => (id === need.needId ? null : need.needId))}
              open={open === need.needId}
            />
          ))}
        </ul>
      )}

      {cursor ? (
        <Button disabled={loadingMore} onClick={loadMore} size="sm" variant="ghost">
          {loadingMore ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </section>
  );
}

function ReadyRow({
  brief,
  need,
  onBrief,
  onPublished,
  onToggle,
  open,
}: {
  brief: BriefView | null;
  need: ReadyNeed;
  onBrief: (brief: BriefView) => void;
  onPublished: (status: DecisionStatus) => void;
  onToggle: () => void;
  open: boolean;
}) {
  const rec = brief?.recommendation;
  const panelId = `ready-${need.needId}`;
  return (
    <li className="py-3">
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="grid w-full gap-1 text-left sm:grid-cols-[1fr_auto] sm:gap-4"
        onClick={onToggle}
        type="button"
      >
        <span className="font-serif text-base">{need.statement}</span>
        <span className="text-muted-foreground flex gap-4 font-mono text-xs tabular-nums sm:justify-end">
          <span>{formatUsd(need.arrCents)}</span>
          <span>{supportersLabel(need.supporters)}</span>
          <span>ready {formatDate(need.readyAt)}</span>
        </span>
        {rec ? (
          <span className={`${pencil} text-sm sm:col-span-2`}>
            <span className={pencilLabel}>Suggested </span>
            {statusLabels[rec.status]}
            {typeof rec.confidence === "number" ? (
              <span className="font-mono"> · {percent(rec.confidence)}</span>
            ) : null}
            {rec.strategyFit ? ` · ${rec.strategyFit.inFocus ? "In focus" : "Off focus"}` : null}
          </span>
        ) : (
          <span className="text-muted-foreground text-sm sm:col-span-2">Brief pending</span>
        )}
      </button>
      {open ? (
        <div className="mt-3" id={panelId}>
          {brief ? (
            <DecidePanel brief={brief} need={need} onBrief={onBrief} onPublished={onPublished} />
          ) : (
            <DraftBrief needId={need.needId} onBrief={onBrief} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function DraftBrief({ needId, onBrief }: { needId: string; onBrief: (brief: BriefView) => void }) {
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<SignalClientError | null>(null);

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

  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        No brief yet. Signal drafts one when a need becomes ready; draft it now if it hasn’t
        arrived.
      </p>
      {error?.code === "ai_unavailable" ? (
        <p className="text-destructive" role="alert">
          The decision model is unavailable. Try again in a moment.
        </p>
      ) : null}
      {error && error.code !== "ai_unavailable" ? <SignalErrorAlert error={error} /> : null}
      <Button disabled={drafting} onClick={draft} size="sm" variant="outline">
        {drafting ? "Drafting…" : "Draft brief"}
      </Button>
    </div>
  );
}

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
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"accept" | "publish" | null>(null);
  const [error, setError] = useState<SignalClientError | null>(null);
  const pending = brief.status === "pending";
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
    <div className="space-y-4 text-sm">
      <div className={`${pencil} space-y-1`}>
        <p className={pencilLabel}>Recommended direction</p>
        <p>
          {statusLabels[rec.status]}
          {typeof rec.confidence === "number" ? (
            <span className="font-mono"> · {percent(rec.confidence)} confident</span>
          ) : null}
        </p>
        {rec.strategyFit ? (
          <p>
            <span className={pencilLabel}>
              {rec.strategyFit.inFocus ? "In focus " : "Off focus "}
            </span>
            {rec.strategyFit.reason}
          </p>
        ) : null}
        {rec.capacityNote ? (
          <p>
            <span className={pencilLabel}>Capacity </span>
            {rec.capacityNote}
          </p>
        ) : null}
        {pending ? null : <p className="text-muted-foreground text-xs italic">brief accepted</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={`status-${need.needId}`}>Status</Label>
          <NativeSelect
            id={`status-${need.needId}`}
            onChange={(e) => setStatus(e.target.value as DecisionStatus)}
            value={status}
          >
            {decisionStatuses.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {statusLabels[s]}
                {s === rec.status ? " (suggested)" : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor={`note-${need.needId}`}>Note to supporters</Label>
            {noteEdited ? (
              <span className="text-muted-foreground text-xs italic">edited by you</span>
            ) : null}
          </div>
          {editing ? (
            <Textarea
              id={`note-${need.needId}`}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              value={note}
            />
          ) : (
            <p className={noteEdited ? "border-rule-strong border-l-2 pl-3" : pencil}>{note}</p>
          )}
        </div>
      </div>

      {error ? <SignalErrorAlert error={error} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy !== null || note.trim().length === 0}
          onClick={publish}
          size="sm"
          type="button"
        >
          {busy === "publish" ? "Publishing…" : "Publish"}
        </Button>
        {pending ? (
          <Button
            disabled={busy !== null}
            onClick={acceptOnly}
            size="sm"
            type="button"
            variant="ghost"
          >
            {busy === "accept" ? "Accepting…" : "Accept brief"}
          </Button>
        ) : null}
        <Button
          disabled={busy !== null}
          onClick={() => setEditing((e) => !e)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {editing ? "Done editing" : "Edit note"}
        </Button>
      </div>
    </div>
  );
}
