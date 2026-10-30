"use client";

import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import * as React from "react";

/** Opening a row closes any other; opening the open row closes it. */
export function toggleExpanded(current: string | null, value: string): string | null {
  return current === value ? null : value;
}

/** J/K: open the next or previous row, stopping at the ends; from nothing, start at an end. */
export function stepExpanded(
  values: readonly string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (values.length === 0) return null;
  const index = current === null ? -1 : values.indexOf(current);
  if (index === -1) return (delta === 1 ? values[0] : values.at(-1)) ?? null;
  return values[Math.min(Math.max(index + delta, 0), values.length - 1)] ?? null;
}

type RuledListContextValue = {
  expanded: string | null;
  id: string;
  setExpanded: (value: string | null) => void;
};

const RuledListContext = React.createContext<RuledListContextValue | null>(null);

/**
 * One-line rows between hairlines; exactly one row expands inline (DESIGN.md → Ruled lists).
 * Controlled with `expanded` / `onExpandedChange`, or uncontrolled with `defaultExpanded`.
 * Rows are buttons: Tab or ↑/↓ move between them, Enter/Space open, Esc closes.
 */
function RuledList({
  children,
  className,
  defaultExpanded = null,
  expanded: expandedProp,
  onExpandedChange,
  onKeyDown,
  ...props
}: Omit<React.ComponentProps<"ul">, "defaultValue"> & {
  defaultExpanded?: string | null;
  expanded?: string | null;
  onExpandedChange?: (value: string | null) => void;
}) {
  const id = React.useId();
  const [uncontrolled, setUncontrolled] = React.useState(defaultExpanded);
  const expanded = expandedProp === undefined ? uncontrolled : expandedProp;
  const context = React.useMemo<RuledListContextValue>(
    () => ({
      expanded,
      id,
      setExpanded: (value) => {
        if (expandedProp === undefined) setUncontrolled(value);
        onExpandedChange?.(value);
      },
    }),
    [expanded, expandedProp, id, onExpandedChange],
  );

  const moveFocus = (event: React.KeyboardEvent<HTMLUListElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const triggers = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ":scope > li > [data-slot=ruled-row-trigger]",
      ),
    ];
    const index = triggers.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    triggers[
      Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), triggers.length - 1)
    ]?.focus();
  };

  return (
    <RuledListContext value={context}>
      <ul
        data-slot="ruled-list"
        className={cn("border-rule-strong m-0 list-none border-t p-0", className)}
        onKeyDown={moveFocus}
        {...props}
      >
        {children}
      </ul>
    </RuledListContext>
  );
}

/** A plain ruled row, for lists whose rows link elsewhere instead of expanding. */
function RuledItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="ruled-item"
      className={cn("border-border min-w-0 border-b py-3.5", className)}
      {...props}
    />
  );
}

/**
 * An expandable row. `summary` is the one-line head (phrasing content: it sits in a button);
 * `children` show inline only while this row is the open one.
 */
function RuledRow({
  children,
  className,
  summary,
  value,
  ...props
}: Omit<React.ComponentProps<"li">, "value"> & { summary: React.ReactNode; value: string }) {
  const context = React.use(RuledListContext);
  if (!context) throw new Error("RuledRow must be inside a RuledList");
  const { expanded, id, setExpanded } = context;
  const open = expanded === value;
  const panelId = `${id}-${value}`;
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  return (
    <li
      data-slot="ruled-row"
      data-state={open ? "open" : "closed"}
      className={cn("border-border min-w-0 border-b", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setExpanded(null);
        triggerRef.current?.focus();
      }}
      {...props}
    >
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        className="focus-visible:ring-ring/50 group/ruled-row flex w-full min-w-0 items-center gap-4 rounded-sm py-3.5 text-left outline-none focus-visible:ring-3"
        data-slot="ruled-row-trigger"
        onClick={() => setExpanded(toggleExpanded(expanded, value))}
        ref={triggerRef}
        type="button"
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="min-w-0 pb-8" data-slot="ruled-row-panel" id={panelId}>
          {children}
        </div>
      ) : null}
    </li>
  );
}

export { RuledItem, RuledList, RuledRow };
