"use client";

import { cn } from "cn";
import { useState } from "react";

import { Pencil } from "@/app/_components/signal/pencil";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { Textarea } from "@/components/textarea";
import type { SignalClientError } from "@/lib/signal/client";

import { ConsoleError } from "../../_components/console-bits";
import { browserSignal } from "../../_components/operator-browser";
import type { CriterionKey, NeedDetail } from "../../_lib/console";
import { criterionKeys, criterionLabels, formatScore } from "../../_lib/console";
import type { PriorityOverrideDraft } from "../../_lib/decide";
import { pendingOfKind, priorityOverride, priorityProposal } from "../../_lib/decide";
import { sectionLabel, useAfterWrite } from "./need-shared";

type ClientError = Pick<SignalClientError, "code" | "message">;

/** Criterion · score · reason; on phone the reason takes its own line. */
const rowGrid =
  "grid grid-cols-[minmax(0,1fr)_3rem] items-baseline gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,8.5rem)_3rem_minmax(0,1fr)]";
const reasonCell = "col-span-2 sm:col-span-1";

/**
 * Priority breakdown. While an AI priority suggestion is pending its per-criterion scores and
 * reasons are pencil, and the PM may override any criterion with a required note (saved as a
 * resolve_suggestion edit). Once resolved, the scores are ink; overriding is no longer offered.
 */
export function PriorityPanel({ need }: { need: NeedDetail }) {
  const pending = pendingOfKind(need, "priority");
  return (
    <section aria-labelledby="priority" className="flex scroll-mt-6 flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className={sectionLabel} id="priority">
          Priority
        </h2>
        <p className="text-muted-foreground text-xs">
          Weighted score{" "}
          <span className="text-foreground font-mono tabular-nums" data-testid="priority-score">
            {formatScore(need.priorityScore)}
          </span>{" "}
          / 5
        </p>
      </div>
      {pending ? (
        <PendingPriority key={pending.id} need={need} suggestion={pending} />
      ) : (
        <CurrentScores need={need} />
      )}
    </section>
  );
}

function CurrentScores({ need }: { need: NeedDetail }) {
  if (need.scores.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        Not scored yet. The AI suggests scores as signals arrive; you can override them while that
        suggestion is pending.
      </p>
    );
  const edited = need.scores.some((score) => score.source === "pm");
  return (
    <Pencil label="Priority breakdown" state={edited ? "edited" : "accepted"}>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0" data-testid="priority-scores">
        {criterionKeys.map((criterion) => {
          const score = need.scores.find((item) => item.criterion === criterion);
          if (!score) return null;
          return (
            <li
              className={rowGrid}
              data-criterion={criterion}
              data-source={score.source}
              key={criterion}
            >
              <span className="text-[13px] font-medium">{criterionLabels[criterion]}</span>
              <span className="text-right font-mono text-[13px] tabular-nums">
                {formatScore(score.score)}
              </span>
              <span className={cn("text-muted-foreground text-[13px] break-words", reasonCell)}>
                {score.reason}
                {score.source === "pm" ? (
                  <span className="font-serif italic"> · set by you</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </Pencil>
  );
}

function PendingPriority({
  need,
  suggestion,
}: {
  need: NeedDetail;
  suggestion: NeedDetail["suggestions"][number];
}) {
  const afterWrite = useAfterWrite(need.id);
  const rows = priorityProposal(suggestion);
  const [overrides, setOverrides] = useState<PriorityOverrideDraft>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const count = Object.keys(overrides).length;

  const setOverride = (criterion: CriterionKey, value: { note: string; score: string } | null) =>
    setOverrides((current) =>
      value
        ? { ...current, [criterion]: value }
        : Object.fromEntries(Object.entries(current).filter(([key]) => key !== criterion)),
    );

  const resolve = async (action: "accept" | "edit" | "reject") => {
    setProblem(null);
    setError(null);
    let edit: Record<string, unknown> | undefined;
    if (action === "edit") {
      const built = priorityOverride(overrides);
      if ("error" in built) {
        setProblem(built.error);
        return;
      }
      ({ edit } = built);
    }
    setBusy(true);
    const result = await browserSignal.resolveSuggestion({ action, edit, id: suggestion.id });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await afterWrite(result.data.suggestion);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="priority-pending">
      <Pencil label="Suggested priority" state="suggested">
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map(({ criterion, reason, score }) => {
            const override = overrides[criterion];
            return (
              <li
                className="border-border flex flex-col gap-2 border-b py-2.5 last:border-b-0"
                data-criterion={criterion}
                key={criterion}
              >
                <div className={rowGrid}>
                  <span className="text-foreground text-[13px] font-medium">
                    {criterionLabels[criterion]}
                  </span>
                  <span
                    className={cn(
                      "text-right font-mono text-[13px] tabular-nums",
                      override && "line-through opacity-60",
                    )}
                  >
                    {formatScore(score)}
                  </span>
                  <span
                    className={cn(
                      "flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1",
                      reasonCell,
                    )}
                  >
                    <span className="min-w-0 flex-1 font-serif text-[15px] break-words">
                      {reason}
                    </span>
                    {override ? null : (
                      <button
                        className="text-primary text-xs underline-offset-4 hover:underline"
                        onClick={() =>
                          setOverride(criterion, {
                            note: "",
                            score: score === null ? "" : String(score),
                          })
                        }
                        type="button"
                      >
                        Override<span className="sr-only"> {criterionLabels[criterion]}</span>
                      </button>
                    )}
                  </span>
                </div>
                {override ? (
                  <div className="text-foreground grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
                    <label className="flex flex-col gap-1 text-xs">
                      Your score
                      <Input
                        aria-label={`Your ${criterionLabels[criterion]} score`}
                        inputMode="decimal"
                        max={5}
                        min={0}
                        onChange={(event) =>
                          setOverride(criterion, { ...override, score: event.target.value })
                        }
                        step={0.5}
                        type="number"
                        value={override.score}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      Why (required)
                      <Textarea
                        aria-label={`Why ${criterionLabels[criterion]} changes`}
                        className="min-h-10"
                        onChange={(event) =>
                          setOverride(criterion, { ...override, note: event.target.value })
                        }
                        placeholder="What the AI missed"
                        required
                        value={override.note}
                      />
                    </label>
                    <button
                      className="text-muted-foreground w-fit text-xs underline-offset-4 hover:underline sm:col-start-2"
                      onClick={() => setOverride(criterion, null)}
                      type="button"
                    >
                      Keep the AI score
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Pencil>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => resolve(count > 0 ? "edit" : "accept")}>
          {count > 0 ? `Save ${count === 1 ? "override" : `${count} overrides`}` : "Accept scores"}
        </Button>
        <Button disabled={busy} onClick={() => resolve("reject")} variant="ghost">
          Reject
        </Button>
        {busy ? <span className="text-muted-foreground text-xs">Saving…</span> : null}
      </div>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      {error ? <ConsoleError error={error} /> : null}
    </div>
  );
}
