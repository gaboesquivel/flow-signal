"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  ArrowRight,
  Check,
  FileText,
  Gauge,
  GitMerge,
  Globe,
  Pencil as PencilIcon,
  ScrollText,
  Split,
  Tag,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { Pencil } from "@/app/_components/signal/pencil";
import type { PencilState } from "@/app/_components/signal/pencil";
import { Button } from "@/components/button";
import { KbdHint, KbdHints } from "@/components/kbd-hint";
import { RuledList, RuledRow, stepExpanded } from "@/components/ruled-list";
import type { SignalClientError } from "@/lib/signal/client";

import { ConsoleError, ConsoleHeading, ConsoleStatus } from "../_components/console-bits";
import {
  OperatorCallError,
  browserSignal,
  invalidateAfterWrite,
  operatorNeedsKey,
  unwrap,
  useNeedDetail,
} from "../_components/operator-browser";
import type {
  Proposal,
  PublicTextFinding,
  SuggestionKind,
  SuggestionView,
  TriageCommand,
} from "../_lib/console";
import {
  buildEdit,
  criterionKeys,
  criterionLabels,
  kindLabels,
  nextPendingAfter,
  proposalOf,
  relativeAge,
  themesOf,
  triageCommand,
} from "../_lib/console";
import { CheckLine, checkKey, checkText, useTextCheck } from "../_components/public-text-check";
import { MergePanel, NeedSignals, SplitSignals } from "./triage-panels";

type ClientError = Pick<SignalClientError, "code" | "message">;

/** What the PM did to a row this session. */
interface Outcome {
  action: "accept" | "edit" | "reject";
  /** The proposal as applied (edited values for `edit`). */
  applied: Proposal;
  mergeId?: string;
  reason?: string;
  undone?: boolean;
}

type Mode = { id: string; kind: "edit" | "reject" } | null;

const kindIcons: Record<SuggestionKind, LucideIcon> = {
  decision_brief: ScrollText,
  draft_need: FileText,
  merge: GitMerge,
  priority: Gauge,
  public_summary: Globe,
  split: Split,
  theme: Tag,
};

/** Kinds decided on the need page (task 06); triage links there instead of editing. */
const needPageKinds = new Set<SuggestionKind>(["priority", "decision_brief"]);

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

const outcomeWords: Record<Outcome["action"], string> = {
  accept: "Accepted",
  edit: "Edited",
  reject: "Rejected",
};

const pencilStateOf = (outcome: Outcome | undefined): PencilState => {
  if (!outcome) return "suggested";
  if (outcome.action === "reject") return "rejected";
  return outcome.action === "edit" ? "edited" : "accepted";
};

const outcomeKey = (outcome: Outcome | undefined) => {
  if (!outcome) return "pending";
  return outcome.undone ? "undone" : outcome.action;
};

/** The closed row's text rule: pencil while pending, ink once decided, struck when rejected. */
const headRule: Record<PencilState, string> = {
  accepted: "border-rule-strong text-foreground",
  edited: "border-rule-strong text-foreground",
  rejected: "border-border text-muted-foreground line-through",
  suggested: "border-ai text-ai-foreground border-dashed",
};

const saveLabel = (checking: boolean, kind: SuggestionKind) => {
  if (checking) return "Checking…";
  return kind === "public_summary" ? "Check and approve" : "Save and accept";
};

const themeNameOf = (proposal: Proposal, themes: { id: string; name: string }[]) =>
  proposal.themeName || themes.find((theme) => theme.id === proposal.themeId)?.name || "A theme";

/** The one line a row shows while closed. */
const headText = (
  suggestion: SuggestionView,
  proposal: Proposal,
  themes: { id: string; name: string }[],
) => {
  const need = suggestion.need?.statement ?? "";
  switch (suggestion.kind) {
    case "draft_need":
    case "split": {
      return proposal.statement || need;
    }
    case "public_summary": {
      return proposal.summary || need;
    }
    case "theme": {
      return `${themeNameOf(proposal, themes)} — ${need}`;
    }
    default: {
      return need;
    }
  }
};

export function TriageView({
  more,
  now,
  suggestions,
}: {
  more: boolean;
  now: string;
  suggestions: SuggestionView[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ids = useMemo(() => suggestions.map((suggestion) => suggestion.id), [suggestions]);
  const [expanded, setExpanded] = useState<string | null>(ids[0] ?? null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, ClientError | undefined>>({});
  const focusAfterMove = useRef(false);
  const today = useMemo(() => new Date(now), [now]);

  const needsList = useQuery({
    enabled: suggestions.some((item) => item.kind === "theme" || item.kind === "merge"),
    queryFn: () => unwrap(browserSignal.listOperatorNeeds({})),
    queryKey: operatorNeedsKey,
    staleTime: 60_000,
  });
  const themes = useMemo(() => themesOf(needsList.data?.needs ?? []), [needsList.data]);

  const resolved = useMemo(() => new Set(Object.keys(outcomes)), [outcomes]);
  const pendingLeft = ids.length - resolved.size;

  const open = useCallback((id: string | null, focus = false) => {
    setExpanded(id);
    setMode(null);
    focusAfterMove.current = focus;
  }, []);

  useEffect(() => {
    if (!focusAfterMove.current || !expanded) return;
    focusAfterMove.current = false;
    const trigger = document.querySelector<HTMLButtonElement>(
      `[data-suggestion="${expanded}"] [data-slot=ruled-row-trigger]`,
    );
    trigger?.focus();
    trigger?.scrollIntoView({ block: "nearest" });
  }, [expanded]);

  /** Counts, needs, and need details all change when a suggestion is applied or undone. */
  const refreshAfterChange = () => {
    void invalidateAfterWrite(queryClient);
  };

  const fail = (id: string, error: ClientError) =>
    setErrors((current) => ({ ...current, [id]: error }));

  const resolve = async (
    suggestion: SuggestionView,
    action: Outcome["action"],
    {
      edit,
      applied,
      reason,
    }: { applied: Proposal; edit?: Record<string, unknown>; reason?: string },
  ) => {
    setBusy(suggestion.id);
    setErrors((current) => ({ ...current, [suggestion.id]: undefined }));
    const result = await browserSignal.resolveSuggestion({
      action,
      edit,
      id: suggestion.id,
      reason: reason || undefined,
    });
    setBusy(null);
    if (!result.ok) {
      fail(suggestion.id, result.error);
      return;
    }
    const mergeId = result.data.result?.mergeId;
    setOutcomes((current) => ({
      ...current,
      [suggestion.id]: {
        action,
        applied,
        mergeId: suggestion.kind === "merge" && typeof mergeId === "string" ? mergeId : undefined,
        reason,
      },
    }));
    refreshAfterChange();
    open(nextPendingAfter(ids, suggestion.id, new Set([...resolved, suggestion.id])), true);
  };

  const undo = async (suggestion: SuggestionView) => {
    const outcome = outcomes[suggestion.id];
    if (!outcome?.mergeId) return;
    setBusy(suggestion.id);
    const result = await browserSignal.undoMerge({ id: outcome.mergeId });
    setBusy(null);
    if (!result.ok) {
      fail(suggestion.id, result.error);
      return;
    }
    setOutcomes((current) => ({ ...current, [suggestion.id]: { ...outcome, undone: true } }));
    refreshAfterChange();
  };

  /** A: accept as proposed (a public summary first passes the identifying-text check). */
  const accept = async (suggestion: SuggestionView) => {
    const applied = proposalOf(suggestion);
    if (suggestion.kind === "public_summary") {
      const findings = await checkText(applied.summary, suggestion.needId);
      if (findings instanceof OperatorCallError) {
        fail(suggestion.id, findings.error);
        return;
      }
      queryClient.setQueryData(checkKey(applied.summary, suggestion.needId), findings);
      if (findings.length > 0) return;
    }
    await resolve(suggestion, "accept", { applied });
  };

  const byId = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.id, suggestion])),
    [suggestions],
  );

  const runCommand = (command: TriageCommand, event: KeyboardEvent) => {
    const current = expanded ? byId.get(expanded) : undefined;
    const pending = current !== undefined && !outcomes[current.id];
    if (command === "next" || command === "previous") {
      event.preventDefault();
      open(stepExpanded(ids, expanded, command === "next" ? 1 : -1), true);
    } else if (command === "cancel") {
      if (mode) setMode(null);
      else if (expanded) open(null);
    } else if (!current || !pending) {
      // Accept, edit, and reject act only on the open, pending row.
    } else if (command === "accept") {
      if (mode) return;
      event.preventDefault();
      accept(current);
    } else {
      event.preventDefault();
      if (command === "edit" && needPageKinds.has(current.kind) && current.needId)
        router.push(`/operator/needs/${current.needId}`);
      else setMode({ id: current.id, kind: command });
    }
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || busy) return;
    const command = triageCommand({
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      key: event.key,
      metaKey: event.metaKey,
      typing: isTyping(event.target),
    });
    if (command) runCommand(command, event);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const caughtUp = pendingLeft === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <ConsoleHeading title="Triage">
          {caughtUp
            ? "All caught up"
            : `${pendingLeft}${more ? "+" : ""} ${pendingLeft === 1 ? "suggestion" : "suggestions"} to review`}
        </ConsoleHeading>
        {ids.length > 0 ? (
          <KbdHints aria-label="Keyboard shortcuts">
            <KbdHint keys={["j", "k"]}>move</KbdHint>
            <KbdHint keys={["a"]}>accept</KbdHint>
            <KbdHint keys={["e"]}>edit</KbdHint>
            <KbdHint keys={["r"]}>reject</KbdHint>
            <KbdHint keys={["esc"]}>cancel</KbdHint>
          </KbdHints>
        ) : null}
      </div>

      {caughtUp ? (
        <div className="border-rule-strong border-t pt-6" data-testid="caught-up">
          <p className="font-serif text-xl">All caught up</p>
          <p className="text-muted-foreground mt-1">
            Nothing is waiting for a decision. New suggestions arrive as people file signals.{" "}
            <Link
              className="text-primary underline-offset-4 hover:underline"
              href="/operator/needs"
            >
              Review needs
            </Link>
          </p>
        </div>
      ) : null}

      {ids.length > 0 ? (
        <RuledList
          aria-label="Suggestions"
          expanded={expanded}
          onExpandedChange={(value) => open(value)}
        >
          {suggestions.map((suggestion) => {
            const outcome = outcomes[suggestion.id];
            const proposal = outcome?.applied ?? proposalOf(suggestion);
            const Icon = kindIcons[suggestion.kind];
            const mergeUndoable = outcome?.mergeId && !outcome.undone;
            return (
              <RuledRow
                actions={
                  mergeUndoable ? (
                    <Button
                      disabled={busy === suggestion.id}
                      onClick={() => undo(suggestion)}
                      size="sm"
                      variant="ghost"
                    >
                      Undo merge
                    </Button>
                  ) : undefined
                }
                data-kind={suggestion.kind}
                data-outcome={outcomeKey(outcome)}
                data-suggestion={suggestion.id}
                key={suggestion.id}
                summary={
                  <span className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                    <span className="text-foreground inline-flex w-32 shrink-0 items-center gap-2 text-[13px] font-medium">
                      <Icon
                        aria-hidden="true"
                        className="text-muted-foreground size-4"
                        strokeWidth={1.6}
                      />
                      {kindLabels[suggestion.kind]}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate border-l-[1.5px] pl-3 font-serif text-[15px]",
                        headRule[pencilStateOf(outcome)],
                      )}
                    >
                      {headText(suggestion, proposal, themes)}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
                      {outcome ? (
                        <span className="text-foreground font-medium">
                          {outcome.undone ? "Merge undone" : outcomeWords[outcome.action]}
                        </span>
                      ) : (
                        <span className="font-mono">
                          {relativeAge(suggestion.createdAt, today)}
                        </span>
                      )}
                    </span>
                  </span>
                }
                value={suggestion.id}
              >
                <SuggestionPanel
                  busy={busy === suggestion.id}
                  error={errors[suggestion.id]}
                  mode={mode?.id === suggestion.id ? mode.kind : null}
                  needs={needsList.data?.needs ?? []}
                  onAccept={() => accept(suggestion)}
                  onCancel={() => setMode(null)}
                  onEdit={(edit, applied) => resolve(suggestion, "edit", { applied, edit })}
                  onMode={(kind) => setMode({ id: suggestion.id, kind })}
                  onReject={(reason) =>
                    resolve(suggestion, "reject", { applied: proposalOf(suggestion), reason })
                  }
                  onUndo={() => undo(suggestion)}
                  outcome={outcome}
                  suggestion={suggestion}
                  themes={themes}
                />
              </RuledRow>
            );
          })}
        </RuledList>
      ) : null}
    </div>
  );
}

interface PanelProps {
  busy: boolean;
  error: ClientError | undefined;
  mode: "edit" | "reject" | null;
  needs: { id: string; people: number; statement: string; status: string }[];
  onAccept: () => void;
  onCancel: () => void;
  onEdit: (edit: Record<string, unknown>, applied: Proposal) => Promise<void>;
  onMode: (mode: "edit" | "reject") => void;
  onReject: (reason: string) => void;
  onUndo: () => void;
  outcome: Outcome | undefined;
  suggestion: SuggestionView;
  themes: { id: string; name: string }[];
}

/** Everything needed to decide one suggestion, read in place. */
function SuggestionPanel(props: PanelProps) {
  const { error, outcome, suggestion } = props;
  const proposal = outcome?.applied ?? proposalOf(suggestion);
  const state = pencilStateOf(outcome);
  const isSummary = suggestion.kind === "public_summary";
  const check = useTextCheck(proposal.summary, suggestion.needId, isSummary && !outcome);
  const blocked = isSummary && (!check.data || check.data.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-6 sm:pl-36" data-slot="suggestion-panel">
      <KindBody {...props} proposal={proposal} state={state} />

      {suggestion.reason ? (
        <Pencil
          className="max-w-prose"
          label={suggestion.kind === "merge" ? "Why merge" : "Why"}
          state={outcome?.action === "reject" ? "rejected" : state}
        >
          <p className="font-serif text-[15px] leading-relaxed">{suggestion.reason}</p>
        </Pencil>
      ) : null}

      {isSummary && !outcome && props.mode !== "edit" ? (
        <CheckLine
          error={check.error instanceof OperatorCallError ? check.error.error : null}
          findings={check.data}
          loading={check.isFetching && !check.data}
        />
      ) : null}

      {error ? <ConsoleError error={error} /> : null}

      <PanelActions {...props} blocked={blocked} />
    </div>
  );
}

/** The row's actions: resolved line, the reject or edit form, or Accept / Edit / Reject. */
function PanelActions(props: PanelProps & { blocked: boolean }) {
  const { blocked, busy, mode, onAccept, onMode, outcome, suggestion } = props;
  if (outcome) return <ResolvedLine {...props} />;
  if (mode === "reject") return <RejectForm {...props} />;
  if (mode === "edit") return <EditForm {...props} proposal={proposalOf(suggestion)} />;
  const needHref = suggestion.needId ? `/operator/needs/${suggestion.needId}` : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={busy || blocked} onClick={onAccept}>
        <Check aria-hidden="true" /> Accept
        <kbd className="border-primary-foreground/40 ml-1 rounded-[3px] border px-1 font-mono text-[11px] leading-4 pointer-coarse:hidden">
          a
        </kbd>
      </Button>
      {needPageKinds.has(suggestion.kind) && needHref ? (
        <Link
          className="hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium"
          href={needHref}
        >
          <PencilIcon aria-hidden="true" className="size-4" /> Edit on the need page
        </Link>
      ) : (
        <Button disabled={busy} onClick={() => onMode("edit")} variant="ghost">
          <PencilIcon aria-hidden="true" /> Edit
        </Button>
      )}
      <Button disabled={busy} onClick={() => onMode("reject")} variant="ghost">
        <X aria-hidden="true" /> Reject
      </Button>
    </div>
  );
}

function ResolvedLine({ outcome, suggestion }: PanelProps) {
  if (!outcome) return null;
  if (outcome.action === "reject")
    return (
      <p className="text-muted-foreground text-sm">
        Rejected{outcome.reason ? `: “${outcome.reason}”` : "."} Nothing changed.
      </p>
    );
  if (suggestion.kind === "merge")
    return outcome.undone ? (
      <p className="text-muted-foreground text-sm">
        Merge undone. Its signals are back on the original need.
      </p>
    ) : (
      <p className="text-muted-foreground text-sm">
        Merged. The signals moved as written; nothing was deleted. Undo merge stays on this row for
        the session.
      </p>
    );
  return <p className="text-muted-foreground text-sm">{outcomeWords[outcome.action]}. Saved.</p>;
}

function RejectForm({ busy, onCancel, onReject }: PanelProps) {
  const [reason, setReason] = useState("");
  return (
    // Keys typed in the form's fields bubble here: Esc cancels.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      className="flex max-w-xl flex-col gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        onReject(reason.trim());
      }}
    >
      <label className="text-muted-foreground text-xs" htmlFor="reject-reason">
        Why reject? Optional, kept for review, never public.
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          autoFocus
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3"
          id="reject-reason"
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. Too broad"
          value={reason}
        />
        <Button disabled={busy} type="submit" variant="outline">
          Reject
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Editing starts after the existing words, not before them. */
const caretToEnd = (event: React.FocusEvent<HTMLTextAreaElement>) => {
  const { length } = event.currentTarget.value;
  event.currentTarget.setSelectionRange(length, length);
};

const fieldClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-2 text-[15px] outline-none focus-visible:ring-3";

function EditForm(props: PanelProps & { proposal: Proposal }) {
  const { busy, needs, onCancel, onEdit, proposal, suggestion, themes } = props;
  const [values, setValues] = useState<Proposal>(proposal);
  const [problem, setProblem] = useState<string | null>(null);
  const [findings, setFindings] = useState<PublicTextFinding[] | null>(null);
  const [checking, setChecking] = useState(false);
  const detail = useNeedDetail(suggestion.needId, suggestion.kind === "split");
  const [newTheme, setNewTheme] = useState(!proposal.themeId);
  const [targetQuery, setTargetQuery] = useState("");

  const save = async () => {
    const shaped =
      suggestion.kind === "theme" ? { ...values, themeId: newTheme ? "" : values.themeId } : values;
    const built = buildEdit(suggestion.kind, shaped);
    if ("error" in built) {
      setProblem(built.error);
      return;
    }
    if (
      suggestion.kind === "split" &&
      detail.data &&
      values.signalIds.length >= detail.data.signals.length
    ) {
      setProblem("Leave at least one signal on the original need.");
      return;
    }
    if (suggestion.kind === "public_summary") {
      setChecking(true);
      const found = await checkText(values.summary.trim(), suggestion.needId);
      setChecking(false);
      if (found instanceof OperatorCallError) {
        setProblem(found.error.message);
        return;
      }
      setFindings(found);
      if (found.length > 0) return;
    }
    setProblem(null);
    await onEdit(built.edit, shaped);
  };

  const targets = needs
    .filter((need) => need.id !== suggestion.needId)
    .filter((need) =>
      targetQuery.trim()
        ? need.statement.toLowerCase().includes(targetQuery.trim().toLowerCase())
        : true,
    )
    .slice(0, 6);

  return (
    // Keys typed in the form's fields bubble here: Esc cancels, ⌘/Ctrl+Enter saves.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      className="flex max-w-2xl flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {suggestion.kind === "draft_need" || suggestion.kind === "split" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">
            {suggestion.kind === "split" ? "New need statement" : "Need statement"}
          </span>
          <textarea
            autoFocus
            className={cn(fieldClass, "font-serif")}
            onFocus={caretToEnd}
            onChange={(event) => setValues({ ...values, statement: event.target.value })}
            rows={3}
            value={values.statement}
          />
        </label>
      ) : null}

      {suggestion.kind === "split" ? (
        <SplitSignals
          detail={detail.data}
          onChange={(signalIds) => setValues({ ...values, signalIds })}
          selected={values.signalIds}
        />
      ) : null}

      {suggestion.kind === "public_summary" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Public summary</span>
          <textarea
            autoFocus
            className={cn(fieldClass, "font-serif")}
            onFocus={caretToEnd}
            onChange={(event) => {
              setValues({ ...values, summary: event.target.value });
              setFindings(null);
            }}
            rows={3}
            value={values.summary}
          />
        </label>
      ) : null}

      {suggestion.kind === "merge" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-muted-foreground mb-1.5 text-xs">
            Merge into a different need
          </legend>
          <input
            autoFocus
            aria-label="Find a need"
            className={cn(fieldClass, "h-8 py-1 text-sm")}
            onChange={(event) => setTargetQuery(event.target.value)}
            placeholder="Find a need"
            value={targetQuery}
          />
          <ul className="m-0 flex list-none flex-col p-0">
            {targets.map((need) => (
              <li className="border-border border-b" key={need.id}>
                <label className="flex cursor-pointer items-start gap-3 py-2">
                  <input
                    checked={values.intoNeedId === need.id}
                    className="accent-primary mt-1"
                    name={`into-${suggestion.id}`}
                    onChange={() => setValues({ ...values, intoNeedId: need.id })}
                    type="radio"
                  />
                  <span className="min-w-0 flex-1 font-serif text-[15px]">{need.statement}</span>
                  <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                    {need.people}
                  </span>
                </label>
              </li>
            ))}
            {targets.length === 0 ? (
              <li className="text-muted-foreground py-2 text-sm">No need matches.</li>
            ) : null}
          </ul>
        </fieldset>
      ) : null}

      {suggestion.kind === "theme" ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-muted-foreground mb-1.5 text-xs">Theme</legend>
          {themes.map((theme) => (
            <label className="flex items-center gap-3 py-1" key={theme.id}>
              <input
                checked={!newTheme && values.themeId === theme.id}
                className="accent-primary"
                name={`theme-${suggestion.id}`}
                onChange={() => {
                  setNewTheme(false);
                  setValues({ ...values, themeId: theme.id });
                }}
                type="radio"
              />
              {theme.name}
            </label>
          ))}
          <label className="flex items-center gap-3 py-1">
            <input
              checked={newTheme}
              className="accent-primary"
              name={`theme-${suggestion.id}`}
              onChange={() => setNewTheme(true)}
              type="radio"
            />
            New theme
          </label>
          {newTheme ? (
            <input
              aria-label="New theme name"
              className={cn(fieldClass, "ml-7 h-8 max-w-sm py-1 text-sm")}
              maxLength={80}
              onChange={(event) => setValues({ ...values, themeName: event.target.value })}
              placeholder="Theme name"
              value={values.themeName}
            />
          ) : null}
        </fieldset>
      ) : null}

      {findings && findings.length > 0 ? (
        <CheckLine error={null} findings={findings} loading={false} />
      ) : null}
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || checking} type="submit">
          {saveLabel(checking, suggestion.kind)}
        </Button>
        <Button onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <KbdHints>
          <KbdHint keys={["⌘", "↵"]}>save</KbdHint>
          <KbdHint keys={["esc"]}>cancel</KbdHint>
        </KbdHints>
      </div>
    </form>
  );
}

/** The proposal itself, by kind: pencil until resolved, customers' words as quotes. */
function KindBody({
  outcome,
  proposal,
  state,
  suggestion,
  themes,
}: PanelProps & { proposal: Proposal; state: PencilState }) {
  const { need } = suggestion;
  const needHref = suggestion.needId ? `/operator/needs/${suggestion.needId}` : null;
  const needLine = need ? (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <ConsoleStatus status={need.status as "open"} />
      {needHref ? (
        <Link
          className="text-primary inline-flex items-center gap-1 underline-offset-4 hover:underline"
          href={needHref}
        >
          Open need <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      ) : null}
    </p>
  ) : null;

  switch (suggestion.kind) {
    case "merge": {
      return <MergePanel outcome={outcome} proposal={proposal} suggestion={suggestion} />;
    }
    case "draft_need": {
      return (
        <div className="flex flex-col gap-5">
          <Pencil label="Suggested statement" state={state}>
            <p className="font-serif text-lg leading-snug">
              {proposal.statement || need?.statement}
            </p>
          </Pencil>
          <NeedSignals needId={suggestion.needId} />
        </div>
      );
    }
    case "split": {
      return (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
              Split from
            </p>
            <p className="font-serif text-[15px]">{need?.statement}</p>
            {needLine}
          </div>
          <Pencil label="New need" state={state}>
            <p className="font-serif text-lg leading-snug">{proposal.statement}</p>
          </Pencil>
          <NeedSignals
            label="Signals that move"
            needId={suggestion.needId}
            only={proposal.signalIds}
          />
        </div>
      );
    }
    case "public_summary": {
      return (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <p className="font-serif text-[15px]">{need?.statement}</p>
            {needLine}
          </div>
          <Pencil label="Public summary" state={state}>
            <p className="font-serif text-lg leading-snug">{proposal.summary}</p>
          </Pencil>
        </div>
      );
    }
    case "theme": {
      return (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <p className="font-serif text-[15px]">{need?.statement}</p>
            {needLine}
          </div>
          <Pencil
            label={proposal.themeId ? "Suggested theme" : "Suggested new theme"}
            state={state}
          >
            <p className="font-serif text-lg">{themeNameOf(proposal, themes)}</p>
            {proposal.themeDescription ? (
              <p className="mt-1 text-sm">{proposal.themeDescription}</p>
            ) : null}
          </Pencil>
        </div>
      );
    }
    case "priority": {
      return (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <p className="font-serif text-[15px]">{need?.statement}</p>
            {needLine}
          </div>
          <Pencil label="Suggested scores" state={state}>
            <dl className="m-0 grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
              {criterionKeys
                .filter((key) => proposal.scores[key] !== undefined)
                .map((key) => (
                  <div className="contents" key={key}>
                    <dt>{criterionLabels[key]}</dt>
                    <dd className="m-0 text-right font-mono tabular-nums">
                      {proposal.scores[key]?.toFixed(1)}
                    </dd>
                  </div>
                ))}
            </dl>
          </Pencil>
          <p className="text-muted-foreground text-xs">
            Override a score with a note on the need page.
          </p>
        </div>
      );
    }
    case "decision_brief": {
      return (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <p className="font-serif text-[15px]">{need?.statement}</p>
            {needLine}
          </div>
          <Pencil label="Decision brief" state={state}>
            <div className="line-clamp-[12] max-w-prose text-sm leading-relaxed whitespace-pre-wrap">
              {proposal.markdown}
            </div>
          </Pencil>
        </div>
      );
    }
    default: {
      return null;
    }
  }
}
