"use client";

import { useQueryClient } from "@tanstack/react-query";

import { invalidateAfterWrite, needDetailKey } from "../../_components/operator-browser";
import type { NeedDetail, SuggestionView } from "../../_lib/console";

/**
 * After a write on the need page: put the returned suggestion in the cached need detail at once
 * (so the page doesn't flash back while it refetches), then invalidate need detail, operator
 * needs, and the Triage count.
 */
export function useAfterWrite(needId: string) {
  const queryClient = useQueryClient();
  return async (suggestion?: SuggestionView) => {
    if (suggestion)
      queryClient.setQueryData<NeedDetail>(needDetailKey(needId), (current) =>
        current
          ? {
              ...current,
              suggestions: current.suggestions.some((item) => item.id === suggestion.id)
                ? current.suggestions.map((item) => (item.id === suggestion.id ? suggestion : item))
                : [suggestion, ...current.suggestions],
            }
          : current,
      );
    await invalidateAfterWrite(queryClient);
  };
}

/** Small uppercase section label, as on the Needs table and reading panes. */
export const sectionLabel =
  "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";
