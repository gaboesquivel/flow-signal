"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { Label } from "@/components/label";
import { Textarea } from "@/components/textarea";
import { createSignalClient } from "@/lib/signal/client";
import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

import { SignalErrorAlert } from "./error-alert";
import { formatDate, formatUsd, supportersLabel } from "./labels";

type StrategyRead = SignalOperations["get_strategy"]["output"];
export interface ThemeOption {
  id: string;
  name: string;
}

const signal = createSignalClient();

const readyLine = ({
  readinessArrCents,
  readinessSupporters,
}: StrategyRead["defaults"]): string => {
  const parts = [
    readinessArrCents > 0 ? `${formatUsd(readinessArrCents)} ARR` : null,
    readinessSupporters > 0 ? supportersLabel(readinessSupporters) : null,
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
      setInvalid("Capacity, ARR, and supporters must be whole numbers of 0 or more.");
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
    <section aria-labelledby="strategy-heading" className="space-y-4">
      <header className="flex items-baseline justify-between gap-4 border-b pb-2">
        <h2 className="font-serif text-lg" id="strategy-heading">
          Strategy
        </h2>
        <p className="text-muted-foreground font-mono text-xs">
          {strategy
            ? `v${strategy.version} · ${formatDate(strategy.createdAt)}`
            : `No strategy yet · ready at ${readyLine(initial.defaults)}`}
        </p>
      </header>

      <form className="space-y-4 text-sm" onSubmit={save}>
        <fieldset className="space-y-2">
          <legend className="font-medium">Focus themes</legend>
          {options.length === 0 ? (
            <p className="text-muted-foreground">No themes yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {options.map((theme) => (
                <li key={theme.id}>
                  <label className="flex items-center gap-2">
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

        <div className="space-y-1.5">
          <Label htmlFor="strategy-revenue">Revenue focus</Label>
          <Input
            id="strategy-revenue"
            maxLength={500}
            onChange={(e) => setRevenueFocus(e.target.value)}
            placeholder="e.g. Expand enterprise accounts"
            value={revenueFocus}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="strategy-capacity">Capacity per quarter</Label>
            <Input
              className="font-mono"
              id="strategy-capacity"
              inputMode="numeric"
              min={0}
              onChange={(e) => setCapacity(e.target.value)}
              step={1}
              type="number"
              value={capacity}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="strategy-arr">Ready at ARR ($)</Label>
            <Input
              className="font-mono"
              id="strategy-arr"
              inputMode="numeric"
              min={0}
              onChange={(e) => setArrDollars(e.target.value)}
              step={1}
              type="number"
              value={arrDollars}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="strategy-supporters">or supporters</Label>
            <Input
              className="font-mono"
              id="strategy-supporters"
              inputMode="numeric"
              min={0}
              onChange={(e) => setSupporters(e.target.value)}
              step={1}
              type="number"
              value={supporters}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          A need is ready when its supporting accounts reach the ARR or the supporter count. Set
          either to 0 to ignore it.
        </p>

        <div className="space-y-1.5">
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
        {error ? <SignalErrorAlert error={error} /> : null}

        <div className="flex items-center gap-4">
          <Button disabled={saving} type="submit" variant="outline">
            {saving ? "Saving…" : "Save strategy"}
          </Button>
          {message ? (
            <p aria-live="polite" className="text-muted-foreground">
              {message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
