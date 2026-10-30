import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

/** Display text for the public need view (GLOSSARY: draft needs show as "new"). */

export type PublicNeed = SignalOperations["get_need"]["output"];
export type NeedStatus = PublicNeed["status"];
export type BoardStatus = NonNullable<SignalOperations["search_needs"]["input"]["status"]>;

export const statusLabels: Record<NeedStatus, string> = {
  declined: "Declined",
  in_progress: "In progress",
  merged: "Merged",
  new: "New",
  open: "Open",
  planned: "Planned",
  shipped: "Shipped",
};

/** Board filter order: the life of a need. */
export const boardStatuses: BoardStatus[] = [
  "new",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
];

export const isBoardStatus = (value: unknown): value is BoardStatus =>
  boardStatuses.includes(value as BoardStatus);

export const demandLabels: Record<PublicNeed["demandBand"], string> = {
  high: "High demand",
  low: "Low demand",
  medium: "Medium demand",
};

export const urgencyLabels = { high: "High", low: "Low", medium: "Medium" } as const;

/** "1 person" / "11 people": how public pages count who asked. */
export const peopleLabel = (count: number) => (count === 1 ? "1 person" : `${count} people`);

export const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

/** What to tell a person when a call fails; never a stack trace or a raw code. */
export const errorCopy = (
  error: Pick<SignalClientError, "code">,
): { description: string; title: string } => {
  switch (error.code) {
    case "database_unavailable": {
      return {
        description:
          "Signal can't reach its database right now, so needs can't be shown or saved. Nothing is saved half-way, so you can safely try again in a few minutes.",
        title: "Signal is temporarily unavailable",
      };
    }
    case "rate_limited": {
      return {
        description: "You've made a lot of requests in the last minute. Wait a moment and retry.",
        title: "Too many requests",
      };
    }
    case "network_error": {
      return {
        description: "Couldn't reach Signal. Check your connection and try again.",
        title: "You appear to be offline",
      };
    }
    default: {
      return {
        description: "Something went wrong on our side. Try again in a moment.",
        title: "Something went wrong",
      };
    }
  }
};

/** Whole dollars from cents, e.g. `$250,000`. */
export const formatUsd = (cents: number) =>
  new Intl.NumberFormat("en", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(cents / 100);
