"use client";

import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowRight, Check, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/button";
import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

import { ConsoleError, ConsoleHeading } from "../_components/console-bits";
import { browserSignal, needDetailPrefix, operatorNeedsKey } from "../_components/operator-browser";
import type { CriterionKey } from "../_lib/console";
import { criterionKeys, criterionLabels } from "../_lib/console";
import type { Hundredths, PreviewNeed } from "../_lib/criteria";
import {
  balanceOthers,
  formatWeight,
  fromHundredths,
  rerankPreview,
  saveState,
  toHundredths,
} from "../_lib/criteria";

type Criteria = SignalOperations["get_criteria"]["output"]["criteria"];

const weightsOf = (criteria: Criteria): Hundredths =>
  toHundredths(
    Object.fromEntries(criteria.map((criterion) => [criterion.key, criterion.weight])) as Record<
      CriterionKey,
      number
    >,
  );

const label = "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";

type Saved = { message: string; previous: Hundredths } | { restored: true } | null;

export function CriteriaView({ criteria, needs }: { criteria: Criteria; needs: PreviewNeed[] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const descriptions = new Map(criteria.map((criterion) => [criterion.key, criterion.description]));
  const [saved, setSaved] = useState(() => weightsOf(criteria));
  const [draft, setDraft] = useState(saved);
  const [lastMoved, setLastMoved] = useState<CriterionKey>("demand");
  const [status, setStatus] = useState<Saved>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Pick<SignalClientError, "code" | "message"> | null>(null);

  const { canSave, changed, total } = saveState(draft, saved);
  const preview = useMemo(() => rerankPreview(needs, saved, draft), [needs, saved, draft]);

  const setWeight = (key: CriterionKey, hundredths: number) => {
    setDraft((current) => ({ ...current, [key]: Math.min(Math.max(hundredths, 0), 100) }));
    setLastMoved(key);
    setStatus(null);
    setError(null);
  };

  const write = async (weights: Hundredths) => {
    setBusy(true);
    setError(null);
    const result = await browserSignal.setCriteria({ weights: fromHundredths(weights) });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    // Scores changed everywhere: the Needs table and any open need re-read them.
    void queryClient.invalidateQueries({ queryKey: operatorNeedsKey });
    void queryClient.invalidateQueries({ queryKey: needDetailPrefix });
    router.refresh();
    return weightsOf(result.data.criteria);
  };

  const save = async () => {
    const [before] = rerankPreview(needs, saved, saved).rows;
    const previous = saved;
    const next = await write(draft);
    if (!next) return;
    const [first] = rerankPreview(needs, next, next).rows;
    setSaved(next);
    setDraft(next);
    setStatus({
      message:
        first && first.id !== before?.id
          ? `Needs re-ranked. “${first.statement}” is now first.`
          : "Needs re-ranked with the new weights.",
      previous,
    });
  };

  const undo = async (previous: Hundredths) => {
    const next = await write(previous);
    if (!next) return;
    setSaved(next);
    setDraft(next);
    setStatus({ restored: true });
  };

  let sumMessage = "Saved weights";
  if (total !== 100) sumMessage = "Weights must add up to 1.00";
  else if (changed) sumMessage = "Not saved yet";

  return (
    <div className="flex flex-col gap-8">
      <ConsoleHeading title="Criteria">
        How priority is weighed. A need’s score is the weighted sum of its 0–5 criterion scores.
      </ConsoleHeading>

      <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-14">
        <section aria-labelledby="weights-heading" className="flex min-w-0 flex-col gap-4">
          <h2 className={label} id="weights-heading">
            Weights
          </h2>
          <ol className="border-rule-strong m-0 list-none border-t p-0">
            {criterionKeys.map((key) => (
              <WeightRow
                changed={draft[key] !== saved[key]}
                description={descriptions.get(key) ?? ""}
                key={key}
                name={criterionLabels[key]}
                onChange={(value) => setWeight(key, value)}
                value={draft[key]}
                weightKey={key}
              />
            ))}
          </ol>
          <div
            className={cn(
              "flex items-baseline justify-between gap-4 text-[13px]",
              total === 100 ? "text-muted-foreground" : "text-destructive",
            )}
            data-testid="weights-sum"
          >
            <span aria-live="polite" role={total === 100 ? undefined : "alert"}>
              {sumMessage}
            </span>
            <span className="flex items-baseline gap-2">
              Total
              <span
                className="text-foreground font-mono text-sm tabular-nums"
                data-testid="weights-total"
              >
                {formatWeight(total)}
              </span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button disabled={!canSave || busy} onClick={save} size="lg">
              {busy ? "Saving…" : "Save weights"}
            </Button>
            <button
              className="text-foreground decoration-input text-sm font-medium underline underline-offset-4 disabled:no-underline disabled:opacity-50"
              disabled={total === 100}
              onClick={() => setDraft((current) => balanceOthers(current, lastMoved))}
              type="button"
            >
              Balance the others
            </button>
            <button
              className="text-foreground decoration-input text-sm font-medium underline underline-offset-4 disabled:no-underline disabled:opacity-50"
              disabled={!changed}
              onClick={() => {
                setDraft(saved);
                setError(null);
              }}
              type="button"
            >
              Reset
            </button>
          </div>
          {error ? <ConsoleError error={error} /> : null}
          {status && "message" in status ? (
            <div className="flex flex-col gap-3" data-testid="criteria-saved">
              <div className="border-rule-strong border-l-[1.5px] py-px pl-3.5">
                <p className="inline-flex items-center gap-1.5 font-serif text-base leading-tight tracking-wide [font-variant-caps:all-small-caps]">
                  <Check aria-hidden="true" className="size-3" strokeWidth={2.25} /> Saved
                </p>
                <p className="mt-1">{status.message}</p>
              </div>
              <p className="flex flex-wrap gap-x-5 gap-y-2">
                <button
                  className="text-foreground decoration-input inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-4 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => undo(status.previous)}
                  type="button"
                >
                  <Undo2 aria-hidden="true" className="size-3.5" /> Undo
                </button>
                <Link
                  className="text-primary inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
                  href="/operator/needs"
                >
                  See the Needs table <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
              </p>
            </div>
          ) : null}
          {status && "restored" in status ? (
            <output className="text-muted-foreground block text-[13px]">
              Previous weights restored.
            </output>
          ) : null}
        </section>

        <section aria-labelledby="preview-heading" className="flex min-w-0 flex-col gap-4">
          <h2 className={label} id="preview-heading">
            Preview · scored needs
          </h2>
          {preview.rows.length === 0 ? (
            <p className="text-muted-foreground">
              No need has scores yet. Accept a priority suggestion in Triage to score one.
            </p>
          ) : (
            <ol
              aria-label="Scored needs ranked with these weights"
              className="border-rule-strong m-0 list-none border-t p-0"
            >
              {preview.rows.map((row) => (
                <li
                  className={cn(
                    "border-border grid grid-cols-[1.5rem_minmax(0,1fr)_auto_2.5rem] items-baseline gap-x-3 border-b py-2.5",
                    row.move !== 0 && "bg-muted/40",
                  )}
                  data-move={row.move}
                  data-preview-need={row.id}
                  key={row.id}
                >
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {row.rank}
                  </span>
                  <span
                    className="line-clamp-2 font-serif text-[15px] leading-snug"
                    title={row.statement}
                  >
                    {row.statement}
                  </span>
                  <span
                    className="text-right font-mono text-[13px] tabular-nums"
                    data-testid="preview-score"
                  >
                    {row.before === row.after ? (
                      row.after.toFixed(2)
                    ) : (
                      <>
                        <span className="text-muted-foreground">{row.before.toFixed(2)} → </span>
                        {row.after.toFixed(2)}
                      </>
                    )}
                  </span>
                  <Move move={row.move} />
                </li>
              ))}
            </ol>
          )}
          {total === 100 ? null : (
            <p className="text-muted-foreground text-[13px]">
              The weights add up to {formatWeight(total)}, so these scores are{" "}
              {total > 100 ? "overstated" : "understated"} until they sum to 1.00.
            </p>
          )}
          {preview.unscored > 0 ? (
            <p className="text-muted-foreground text-[13px]">
              The other {preview.unscored} needs have no scores yet, so they rank below these by
              people and do not move.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function Move({ move }: { move: number }) {
  if (move === 0)
    return (
      <span
        className="text-muted-foreground text-right font-mono text-xs"
        data-testid="preview-move"
      >
        —<span className="sr-only">no change</span>
      </span>
    );
  const up = move > 0;
  return (
    <span
      className={cn(
        "text-right font-mono text-xs font-medium tabular-nums",
        up ? "text-status-shipped" : "text-status-declined",
      )}
      data-testid="preview-move"
    >
      <span aria-hidden="true">
        {up ? "↑" : "↓"}
        {Math.abs(move)}
      </span>
      <span className="sr-only">
        {up ? "up" : "down"} {Math.abs(move)}
      </span>
    </span>
  );
}

function WeightRow({
  changed,
  description,
  name,
  onChange,
  value,
  weightKey,
}: {
  changed: boolean;
  description: string;
  name: string;
  onChange: (hundredths: number) => void;
  value: number;
  weightKey: CriterionKey;
}) {
  // The typed text is kept while the PM edits so "0." is not rewritten mid-keystroke.
  const [text, setText] = useState<string | null>(null);
  const inputId = `weight-${weightKey}`;
  return (
    <li className="border-border grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-4 gap-y-2 border-b py-3.5">
      <div className="min-w-0">
        <label className="block font-medium" htmlFor={inputId}>
          {name}
        </label>
        {description ? (
          <p className="text-muted-foreground text-[13px] leading-snug">{description}</p>
        ) : null}
      </div>
      <input
        aria-label={`${name} weight`}
        className={cn(
          "border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border bg-transparent px-2 text-right font-mono text-sm tabular-nums outline-none focus-visible:ring-3",
          changed && "text-primary font-medium",
        )}
        id={inputId}
        inputMode="decimal"
        onBlur={() => setText(null)}
        onChange={(event) => {
          setText(event.target.value);
          // A text field keeps "0.35" as typed in every locale; a comma decimal is read too.
          const parsed = Number(event.target.value.trim().replace(",", "."));
          if (event.target.value.trim() !== "" && Number.isFinite(parsed))
            onChange(Math.round(parsed * 100));
        }}
        type="text"
        value={text ?? formatWeight(value)}
      />
      <input
        aria-label={`${name} weight slider`}
        className="accent-primary col-span-2 w-full"
        max={100}
        min={0}
        onChange={(event) => {
          setText(null);
          onChange(Number(event.target.value));
        }}
        step={5}
        type="range"
        value={value}
      />
    </li>
  );
}
