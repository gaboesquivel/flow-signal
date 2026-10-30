"use client";

import { cn } from "cn";
import { parseAsNumberLiteral, useQueryState } from "nuqs";
import { useTransition } from "react";

import type { WindowDays } from "../_lib/metrics-view";
import { windowDays } from "../_lib/metrics-view";

/** 28 / 90 days, kept in the URL (`?days=90`); the server re-reads get_metrics on change. */
export function WindowToggle({ days }: { days: WindowDays }) {
  const [loading, startTransition] = useTransition();
  const [, setDays] = useQueryState(
    "days",
    parseAsNumberLiteral(windowDays).withDefault(28).withOptions({
      clearOnDefault: true,
      shallow: false,
      startTransition,
    }),
  );
  return (
    <fieldset
      aria-busy={loading}
      className="border-input m-0 inline-flex shrink-0 rounded-md border p-0.5"
    >
      <legend className="sr-only">Window</legend>
      {windowDays.map((option) => (
        <button
          aria-pressed={days === option}
          className={cn(
            "focus-visible:ring-ring/50 rounded-[5px] px-3 py-1 text-[13px] outline-none focus-visible:ring-3",
            days === option
              ? "bg-foreground text-background font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option}
          onClick={() => setDays(option)}
          type="button"
        >
          {option} days
        </button>
      ))}
    </fieldset>
  );
}
