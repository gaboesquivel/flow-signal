"use client";

import { ChevronDownIcon } from "lucide-react";

import { boardStatuses, statusLabels } from "./labels";
import type { BoardStatus } from "./labels";

/** The board's quiet status filter: a word that submits the search form when it changes. */
export function StatusFilter({ status }: { status?: BoardStatus }) {
  return (
    <label className="text-muted-foreground focus-within:ring-ring/50 relative inline-flex items-center gap-1 rounded-sm text-sm whitespace-nowrap focus-within:ring-3">
      Status:
      <select
        className="text-foreground cursor-pointer appearance-none bg-transparent pr-5 font-medium outline-none"
        defaultValue={status ?? ""}
        name="status"
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        <option value="">All</option>
        {boardStatuses.map((item) => (
          <option key={item} value={item}>
            {statusLabels[item]}
          </option>
        ))}
      </select>
      <ChevronDownIcon aria-hidden="true" className="pointer-events-none absolute right-0 size-4" />
    </label>
  );
}
