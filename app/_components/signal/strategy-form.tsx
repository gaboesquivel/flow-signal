"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { ConsoleError } from "@/app/operator/(console)/_components/console-bits";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { Label } from "@/components/label";
import { Textarea } from "@/components/textarea";
import { createSignalClient } from "@/lib/signal/client";
import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

import { formatDate, formatUsd, peopleLabel } from "./labels";

type StrategyRead = SignalOperations["get_strategy"]["output"];
interface ThemeOption {
  id: string;
  name: string;
}

const signal = createSignalClient();

const sectionLabel = "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";

const readyLine = ({
  readinessArrCents,
  readinessSupporters,
}: StrategyRead["defaults"]): string => {
  const parts = [
    readinessArrCents > 0 ? `${formatUsd(readinessArrCents)} ARR` : null,
    readinessSupporters > 0 ? peopleLabel(readinessSupporters) : null,
  ].filter(Boolean);
  return parts.join(" or ");
};

const toWholeNumber = (value: string) => {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
};

/** Spec 007 → Strategy: the PM writes a new strategy version; Save reports newly ready needs. */
export function StrategyForm({
  initial,
  themes,
}: {
  initial: StrategyRead;
  themes: ThemeOption[];
}) {
  const router = useRouter();
  const current = initial.strategy;
  const line = current ?? initial.defaults;
  const [strategy, setStrategy] = useState(current);
  const [focus, setFocus] = useState<Set<string>>(
    () => new Set(current?.focusThemes.map((t) => t.id)),
  );
  const [revenueFocus, setRevenueFocus] = useState(current?.revenueFocus ?? "");
  const [capacity, setCapacity] = useState(String(current?.capacityPerQuarter ?? ""));
  const [arrDollars, setArrDollars] = useState(String(Math.round(line.readinessArrCents / 100)));
  const [supporters, setSupporters] = useState(String(line.readinessSupporters));
  const [notes, setNotes] = useState(current?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [error, setError] = useState<SignalClientError | null>(null);

  // Focus themes no longer seen on any need still show, so a save never drops them silently.
  const options = [
    ...themes,
    ...(current?.focusThemes ?? []).filter((t) => !themes.some((o) => o.id === t.id)),
  ];

  const toggle = (id: string) =>
    setFocus((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setInvalid(null);
    setError(null);
    const capacityPerQuarter = toWholeNumber(capacity);
    const dollars = toWholeNumber(arrDollars);
    const readinessSupporters = toWholeNumber(supporters);
    if (
      !Number.isInteger(capacityPerQuarter) ||
      Number.isNaN(dollars) ||
      !Number.isInteger(readinessSupporters)
    ) {
      setInvalid("Capacity, ARR, and people must be whole numbers of 0 or more.");
      return;
    }
    const readinessArrCents = Math.round(dollars * 100);
    if (readinessArrCents === 0 && readinessSupporters === 0) {
      setInvalid("Set at least one readiness threshold above 0.");
      return;
    }
    setSaving(true);
    const result = await signal.setStrategy({
      capacityPerQuarter,
      focusThemeIds: [...focus],
      notes: notes.trim() || undefined,
      readinessArrCents,
      readinessSupporters,
      revenueFocus: revenueFocus.trim(),
    });
    setSaving(false);
    if (!result.ok) {
      if (result.error.code === "validation_failed") setInvalid(result.error.message);
      else setError(result.error);
      return;
    }
    setStrategy(result.data.strategy);
    const n = result.data.newlyReady;
    setMessage(n === 1 ? "1 need became ready." : `${n} needs became ready.`);
    router.refresh();
  };

  return (
    <section aria-labelledby="strategy-heading" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={sectionLabel} id="strategy-heading">
          Strategy
        </h2>
        <p className="text-muted-foreground font-mono text-xs tabular-nums">
          {strategy
            ? `v${strategy.version} · ${formatDate(strategy.createdAt)}`
            : `No strategy yet · ready at ${readyLine(initial.defaults)}`}
        </p>
      </div>

      <form
        className="border-rule-strong flex flex-col gap-5 border-t pt-5 text-sm"
        onSubmit={save}
      >
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-[13px] font-medium">Focus themes</legend>
          {options.length === 0 ? (
            <p className="text-muted-foreground">No themes yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0">
              {options.map((theme) => (
                <li key={theme.id}>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      checked={focus.has(theme.id)}
                      className="accent-primary size-4"
                      onChange={() => toggle(theme.id)}
                      type="checkbox"
                    />
                    {theme.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="strategy-revenue">Revenue focus</Label>
          <Input
            id="strategy-revenue"
            maxLength={500}
            onChange={(e) => setRevenueFocus(e.target.value)}
            placeholder="e.g. Expand enterprise accounts"
            value={revenueFocus}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="strategy-capacity"
              label="Capacity per quarter"
              onChange={setCapacity}
              value={capacity}
            />
            <NumberField
              id="strategy-arr"
              label="Ready at ARR ($)"
              onChange={setArrDollars}
              value={arrDollars}
            />
            <NumberField
              id="strategy-supporters"
              label="or people"
              onChange={setSupporters}
              value={supporters}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            A need is ready when its supporting accounts reach the ARR or the number of people. Set
            either to 0 to ignore it.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="strategy-notes">Notes</Label>
          <Textarea
            id="strategy-notes"
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            value={notes}
          />
        </div>

        {invalid ? (
          <p className="text-destructive" role="alert">
            {invalid}
          </p>
        ) : null}
        {error ? <ConsoleError error={error} /> : null}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {/* Publish on a ready need is the page's primary action; saving strategy is secondary. */}
          <Button disabled={saving} type="submit" variant="outline">
            {saving ? "Saving…" : "Save strategy"}
          </Button>
          {message ? (
            <p
              aria-live="polite"
              className="border-rule-strong inline-flex items-center gap-1.5 border-l-[1.5px] pl-2.5"
            >
              <Check aria-hidden="true" className="size-3" strokeWidth={2.25} />
              {message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function NumberField({
  id,
  label,
  onChange,
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        className="font-mono tabular-nums"
        id={id}
        inputMode="numeric"
        min={0}
        onChange={(e) => onChange(e.target.value)}
        step={1}
        type="number"
        value={value}
      />
    </div>
  );
}
