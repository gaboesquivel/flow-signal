import { cn } from "cn";
import type * as React from "react";

/** Quiet keyboard hints in small muted mono; hidden on touch screens, which have no keys. */
function KbdHints({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-hints"
      className={cn(
        "text-muted-foreground flex flex-wrap items-center gap-3.5 text-xs pointer-coarse:hidden",
        className,
      )}
      {...props}
    />
  );
}

/** One hint: the keys, then what they do, e.g. `<KbdHint keys={["j", "k"]}>move</KbdHint>`. */
function KbdHint({
  children,
  className,
  keys,
  ...props
}: React.ComponentProps<"span"> & { keys: readonly string[] }) {
  return (
    <span
      data-slot="kbd-hint"
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    >
      <span className="inline-flex gap-0.5">
        {keys.map((key) => (
          <kbd
            className="border-border text-muted-foreground inline-block min-w-4 rounded-[3px] border px-1 text-center font-mono text-[11px] leading-4"
            key={key}
          >
            {key}
          </kbd>
        ))}
      </span>
      {children}
    </span>
  );
}

export { KbdHint, KbdHints };
