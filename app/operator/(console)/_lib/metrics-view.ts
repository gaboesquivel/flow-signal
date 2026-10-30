import type { SignalOperations } from "@/lib/signal/client";

import type { SuggestionKind } from "./console";
import { kindLabels } from "./console";

/** Formats and view rules for the Metrics screen (spec 006 task 07). Browser-safe. */

export type Metrics = SignalOperations["get_metrics"]["output"];
type ByKind = Metrics["suggestionAcceptance"]["byKind"][number];
export type Acceptance = ByKind["all"];

export const windowDays = [28, 90] as const;
export type WindowDays = (typeof windowDays)[number];

export const parseWindowDays = (value: string | string[] | undefined | null): WindowDays =>
  value === "90" ? 90 : 28;

const DAY_MS = 86_400_000;

/** get_metrics input for the last `days` days ending now. */
export const metricsWindow = (days: WindowDays, now: Date) => ({
  from: new Date(now.getTime() - days * DAY_MS).toISOString(),
  to: now.toISOString(),
});

export const formatRate = (rate: number | null) =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

const oneDecimal = (value: number) => String(Math.round(value * 10) / 10);

export const formatDays = (days: number | null) => (days === null ? "—" : `${oneDecimal(days)} d`);

export const formatHours = (hours: number | null) =>
  hours === null ? "—" : `${oneDecimal(hours)} h`;

export const resolvedCount = (acceptance: Acceptance) =>
  acceptance.accepted + acceptance.edited + acceptance.rejected;

const isKind = (kind: string): kind is SuggestionKind => kind in kindLabels;

/** Acceptance per suggestion kind that had any resolution in the window, busiest first. */
export const acceptanceRows = (byKind: readonly ByKind[]) =>
  byKind
    .map((row) => ({
      ...row,
      label: isKind(row.kind) ? kindLabels[row.kind] : row.kind,
      total: resolvedCount(row.all),
    }))
    .filter((row) => row.total > 0)
    .toSorted((left, right) => right.total - left.total || left.label.localeCompare(right.label));

type KillVerdict = Metrics["killCriterion"]["populations"]["all"]["verdict"];

export const verdictLabels: Record<KillVerdict, string> = {
  fail: "Fails",
  insufficient_data: "Not enough data",
  pass: "Passes",
};

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export const formatWindow = (window: Metrics["window"]) => {
  const format = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${format.format(new Date(window.from))} – ${format.format(new Date(window.to))}`;
};
