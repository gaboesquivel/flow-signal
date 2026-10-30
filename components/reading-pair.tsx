import { cn } from "cn";
import type * as React from "react";

/**
 * Side-by-side reading for "are these the same need?" (DESIGN.md → Side-by-side reading).
 * Two columns once its container is wide enough (@xl, 36rem); narrower, the panes stack and
 * `stackFirst` picks which leads — "end" (default) puts the need, usually on the right, first.
 */
function ReadingPair({
  className,
  stackFirst = "end",
  ...props
}: React.ComponentProps<"div"> & { stackFirst?: "start" | "end" }) {
  return (
    <div className="@container min-w-0" data-slot="reading-pair">
      <div
        className={cn(
          "grid min-w-0 gap-8 @xl:grid-cols-2 @xl:gap-14",
          stackFirst === "end" && "@max-xl:*:last:order-first",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** One side of a reading pair, headed by a small uppercase label. */
function ReadingPane({
  children,
  className,
  label,
  ...props
}: React.ComponentProps<"section"> & { label: React.ReactNode }) {
  return (
    <section className={cn("min-w-0 break-words", className)} data-slot="reading-pane" {...props}>
      <h3 className="text-muted-foreground mb-3.5 text-[11px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

export { ReadingPair, ReadingPane };
