"use client";

import { useId } from "react";

import { demandLabels, statusLabels, supportersLabel } from "../_components/signal/labels";
import type { ChosenNeed } from "./submit-model";

const optionClass =
  "has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-ring/50 flex cursor-pointer gap-3 rounded-lg border p-3 has-focus-visible:ring-3";

/** A matching need as a radio option: statement, status, supporters, and why it matches. */
export function MatchOption({
  checked,
  need,
  onSelect,
}: {
  checked: boolean;
  need: ChosenNeed;
  onSelect: () => void;
}) {
  const id = useId();
  return (
    <label className={optionClass} htmlFor={id}>
      <input
        checked={checked}
        className="accent-primary mt-1 size-4 shrink-0"
        id={id}
        name="target"
        onChange={onSelect}
        type="radio"
        value={need.needId}
      />
      <span className="flex flex-col gap-1">
        <span className="text-sm leading-snug font-medium">{need.statement}</span>
        <span className="text-muted-foreground text-xs">
          {statusLabels[need.status]} · {supportersLabel(need.supporterCount)} ·{" "}
          {demandLabels[need.demandBand]}
        </span>
        {need.reason ? <span className="text-sm">Why it matches: {need.reason}</span> : null}
      </span>
    </label>
  );
}

/** "None of these": always one click away. */
export function NoneOfTheseOption({
  checked,
  onSelect,
}: {
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label className={optionClass} htmlFor="target-new">
      <input
        checked={checked}
        className="accent-primary mt-1 size-4 shrink-0"
        id="target-new"
        name="target"
        onChange={onSelect}
        type="radio"
        value="new"
      />
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium">None of these</span>
        <span className="text-muted-foreground text-xs">
          Submit it as a new need. It shows as New on the board.
        </span>
      </span>
    </label>
  );
}
