"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { DecisionNote } from "@/app/_components/signal/need-card";
import { Pencil } from "@/app/_components/signal/pencil";
import { Status, StatusShape } from "@/app/_components/signal/status";
import { Button } from "@/components/button";
import { LoadingLine } from "@/components/loading-line";
import { ReadingPair, ReadingPane } from "@/components/reading-pair";
import { Textarea } from "@/components/textarea";
import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

import { ConsoleError } from "../../_components/console-bits";
import { OperatorCallError, browserSignal, unwrap } from "../../_components/operator-browser";
import { CheckLine, useTextCheck } from "../../_components/public-text-check";
import type { NeedDetail } from "../../_lib/console";
import type { BriefRecommendation, DecisionStatus } from "../../_lib/decide";
import {
  briefOf,
  currentBrief,
  decisionStatusLabels,
  decisionStatuses,
  publishBlock,
} from "../../_lib/decide";
import { BriefMarkdown } from "./brief-markdown";
import { sectionLabel, useAfterWrite } from "./need-shared";

type ClientError = Pick<SignalClientError, "code" | "message">;
type Suggestion = NeedDetail["suggestions"][number];
type PublicNeed = SignalOperations["get_need"]["output"];

const errorOf = (error: unknown): ClientError | null =>
  error instanceof OperatorCallError ? error.error : null;

/**
 * Draft decision brief → accept, edit, or reject it → decide side by side (brief ↔ status and
 * public note) → publish → what supporters now see.
 */
export function DecidePanel({ need }: { need: NeedDetail }) {
  const afterWrite = useAfterWrite(need.id);
  const brief = currentBrief(need);
  const [withoutBrief, setWithoutBrief] = useState(false);
  const [published, setPublished] = useState<PublicNeed | null>(null);

  const draft = useMutation({
    mutationFn: () => unwrap(browserSignal.draftDecisionBrief({ id: need.id })),
    onSuccess: async ({ suggestion }) => {
      setWithoutBrief(false);
      await afterWrite({
        ...suggestion,
        need: { id: need.id, statement: need.statement, status: need.status },
        payload: suggestion.payload,
        reason: suggestion.payload.reason,
        relatedNeed: null,
        relatedNeedId: null,
        resolvedAt: null,
        resolvedByKind: null,
        signalIds: [],
        themeId: null,
      });
    },
  });

  let body: React.ReactNode;
  if (published) {
    body = <Published need={published} onAgain={() => setPublished(null)} />;
  } else if (draft.isPending) {
    body = (
      <LoadingLine className="bg-ai-surface rounded-md px-4 py-3">
        Drafting a decision brief from {need.signals.length} signals and {need.accounts.length}{" "}
        accounts…
      </LoadingLine>
    );
  } else if (brief?.status === "pending") {
    body = <PendingBrief brief={brief} needId={need.id} />;
  } else if ((brief && brief.status !== "rejected") || withoutBrief) {
    body = (
      <DecideForm
        brief={brief && brief.status !== "rejected" ? brief : null}
        key={brief?.id ?? "none"}
        need={need}
        onPublished={setPublished}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          {brief?.status === "rejected"
            ? "You rejected the last brief. Draft another, or decide without one."
            : "The AI drafts a brief from this need's demand, accounts, and value: options and a recommended status and note. Nothing is published until you do."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => draft.mutate()}>Draft decision brief</Button>
          <button
            className="text-muted-foreground text-sm underline-offset-4 hover:underline"
            onClick={() => setWithoutBrief(true)}
            type="button"
          >
            Decide without a brief
          </button>
        </div>
        {draft.error ? (
          <ConsoleError
            error={
              errorOf(draft.error) ?? { code: "unexpected_response", message: draft.error.message }
            }
          />
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="decide" className="flex scroll-mt-6 flex-col gap-4">
      <h2 className={sectionLabel} id="decide">
        Decide
      </h2>
      {body}
    </section>
  );
}

/** The AI's brief in pencil: Accept, Edit (its markdown), or Reject. */
function PendingBrief({ brief, needId }: { brief: Suggestion; needId: string }) {
  const afterWrite = useAfterWrite(needId);
  const { markdown, recommendation } = briefOf(brief);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const resolve = async (action: "accept" | "edit" | "reject") => {
    if (action === "edit" && !editing?.trim()) return;
    setBusy(true);
    setError(null);
    const result = await browserSignal.resolveSuggestion({
      action,
      edit: action === "edit" ? { markdown: editing?.trim() } : undefined,
      id: brief.id,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await afterWrite(result.data.suggestion);
  };

  return (
    <div className="flex flex-col gap-4" data-brief={brief.id} data-testid="brief">
      {editing === null ? (
        <Pencil label="Decision brief" state="suggested">
          <BriefMarkdown markdown={markdown} />
          {recommendation ? <Recommendation recommendation={recommendation} /> : null}
        </Pencil>
      ) : (
        <label className="flex flex-col gap-1.5 text-xs">
          Edit the brief (markdown)
          <Textarea
            aria-label="Decision brief"
            className="font-mono text-[13px] leading-relaxed"
            onChange={(event) => setEditing(event.target.value)}
            rows={14}
            value={editing}
          />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {editing === null ? (
          <>
            <Button disabled={busy} onClick={() => resolve("accept")}>
              Accept
            </Button>
            <Button disabled={busy} onClick={() => setEditing(markdown)} variant="ghost">
              Edit
            </Button>
            <Button disabled={busy} onClick={() => resolve("reject")} variant="ghost">
              Reject
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy || !editing.trim()} onClick={() => resolve("edit")}>
              Accept with edits
            </Button>
            <Button disabled={busy} onClick={() => setEditing(null)} variant="ghost">
              Cancel
            </Button>
          </>
        )}
        {busy ? <span className="text-muted-foreground text-xs">Saving…</span> : null}
      </div>
      {error ? <ConsoleError error={error} /> : null}
    </div>
  );
}

/** The brief's recommendation: status and rationale, plus any further fields it carries. */
function Recommendation({ recommendation }: { recommendation: BriefRecommendation }) {
  return (
    <div className="mt-4 flex flex-col gap-1.5" data-testid="recommendation">
      <p className="text-[13px]">
        <span className="font-medium">Recommends </span>
        {recommendation.status ? (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <StatusShape status={recommendation.status} />
            {decisionStatusLabels[recommendation.status]}
          </span>
        ) : (
          "no status"
        )}
      </p>
      {recommendation.rationale ? (
        <p className="text-[14px] break-words">{recommendation.rationale}</p>
      ) : null}
      {recommendation.extras.length > 0 ? (
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
          {recommendation.extras.map((extra) => (
            <div className="contents" key={extra.key}>
              <dt className="text-muted-foreground">{extra.label}</dt>
              <dd className="m-0 break-words">{extra.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

const useDebounced = <T,>(value: T, delay: number) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
};

/** The accepted (or edited) brief, in ink, beside the decision. */
function BriefPane({ brief }: { brief: Suggestion | null }) {
  if (!brief)
    return (
      <ReadingPane label="Decision brief">
        <p className="text-muted-foreground text-sm">
          No brief: you&rsquo;re deciding from the need and its signals.
        </p>
      </ReadingPane>
    );
  const { markdown, recommendation } = briefOf(brief);
  return (
    <ReadingPane label="Decision brief">
      <Pencil label="Decision brief" state={brief.status === "edited" ? "edited" : "accepted"}>
        {recommendation ? <Recommendation recommendation={recommendation} /> : null}
        <details className="mt-4">
          <summary className="text-primary cursor-pointer text-xs">Read the full brief</summary>
          <div className="mt-3">
            <BriefMarkdown markdown={markdown} />
          </div>
        </details>
      </Pencil>
    </ReadingPane>
  );
}

/** Status radios; marked as the brief's suggestion until the PM picks one. */
function StatusChoice({
  onChange,
  suggested,
  value,
}: {
  onChange: (status: DecisionStatus) => void;
  suggested: boolean;
  value: DecisionStatus | null;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1.5 text-[13px] font-medium">
        Status
        {suggested ? (
          <span className="text-ai-foreground font-serif text-sm font-normal italic">
            {" "}
            · suggested by the brief
          </span>
        ) : null}
      </legend>
      {decisionStatuses.map((status) => (
        <label
          className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-sm px-1 py-1.5"
          key={status}
        >
          <input
            checked={value === status}
            className="accent-primary"
            name="decision-status"
            onChange={() => onChange(status)}
            type="radio"
            value={status}
          />
          <Status status={status} />
          <span className="sr-only">{decisionStatusLabels[status]}</span>
        </label>
      ))}
    </fieldset>
  );
}

const noteStateOf = (fromBrief: boolean, touched: boolean) => {
  if (!fromBrief) return "accepted";
  return touched ? "edited" : "suggested";
};

/** Accepted brief ↔ status and public note, side by side; Publish when the note is clean. */
function DecideForm({
  brief,
  need,
  onPublished,
}: {
  brief: Suggestion | null;
  need: NeedDetail;
  onPublished: (need: PublicNeed) => void;
}) {
  const afterWrite = useAfterWrite(need.id);
  const suggested = brief ? briefOf(brief).recommendation : null;
  const fromBrief = suggested !== null;
  const [status, setStatus] = useState<DecisionStatus | null>(suggested?.status ?? null);
  const [note, setNote] = useState(suggested?.note ?? "");
  const [statusTouched, setStatusTouched] = useState(false);
  const [noteTouched, setNoteTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  const debouncedNote = useDebounced(note.trim(), 400);
  const check = useTextCheck(debouncedNote, need.id, true);
  const checking = debouncedNote !== note.trim() || check.isFetching;
  const block =
    publishBlock({ checking, failed: Boolean(check.error), findings: check.data, note }) ??
    (status ? null : "Choose a status.");
  const noteState = noteStateOf(fromBrief, noteTouched);

  const publish = async () => {
    if (block || !status) return;
    setBusy(true);
    setError(null);
    const result = await browserSignal.publishDecision({ id: need.id, note: note.trim(), status });
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    const publicNeed = await browserSignal.getNeed({ id: need.id });
    setBusy(false);
    await afterWrite();
    if (publicNeed.ok) onPublished(publicNeed.data);
    else setError(publicNeed.error);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="decide">
      <ReadingPair stackFirst="start">
        <BriefPane brief={brief} />
        <ReadingPane label="Decision">
          <div className="flex flex-col gap-5">
            <StatusChoice
              onChange={(value) => {
                setStatus(value);
                setStatusTouched(true);
              }}
              suggested={fromBrief && !statusTouched}
              value={status}
            />
            <div className="flex flex-col gap-2">
              <Pencil
                label={noteState === "suggested" ? "Public note · from the brief" : "Public note"}
                state={noteState}
              >
                <Textarea
                  aria-label="Public note"
                  className="text-foreground mt-1 font-serif text-[15px]"
                  maxLength={2000}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setNoteTouched(true);
                  }}
                  placeholder="What supporters will read: plain words, no names, accounts, or revenue."
                  rows={4}
                  value={note}
                />
              </Pencil>
              {note.trim() ? (
                <CheckLine
                  action="publishing"
                  error={errorOf(check.error)}
                  findings={checking ? undefined : check.data}
                  loading={checking}
                />
              ) : null}
            </div>
          </div>
        </ReadingPane>
      </ReadingPair>
      <div className="border-border flex flex-col gap-2 border-t pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={Boolean(block) || busy} onClick={publish} size="lg">
            {busy ? "Publishing…" : "Publish decision"}
          </Button>
          <p
            aria-live="polite"
            className="text-muted-foreground text-xs"
            data-testid="publish-block"
          >
            {block ??
              "Supporters see the status and note on the public need and their My signals pages."}
          </p>
        </div>
        {error ? <ConsoleError error={error} /> : null}
      </div>
    </div>
  );
}

/** What supporters now see: the public need's status and decision note (get_need). */
function Published({ need, onAgain }: { need: PublicNeed; onAgain: () => void }) {
  return (
    <div className="flex flex-col gap-4" data-testid="published">
      <p className="font-serif text-xl">Published. This is what supporters see.</p>
      <div className="border-rule-strong flex flex-col gap-4 border-t pt-5">
        <p className="font-serif text-lg leading-snug break-words">{need.statement}</p>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <Status status={need.status} />
          <span className="text-muted-foreground text-[13px]">
            <span className="text-foreground font-mono">{need.supporterCount}</span> people
          </span>
        </div>
        {need.decision ? <DecisionNote decision={need.decision} /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <Link
          className="text-primary inline-flex items-center gap-1 underline-offset-4 hover:underline"
          href={`/needs/${need.id}`}
          target="_blank"
        >
          Open the public need <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
        <Link
          className="text-muted-foreground underline-offset-4 hover:underline"
          href="/operator/needs"
        >
          Back to Needs
        </Link>
        <button
          className="text-muted-foreground underline-offset-4 hover:underline"
          onClick={onAgain}
          type="button"
        >
          Decide again
        </button>
      </div>
    </div>
  );
}
