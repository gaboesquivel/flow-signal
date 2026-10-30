import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * Text a person wrote or confirmed, in ink: a solid `rule-strong` rule and a small-caps label
 * (DESIGN.md → Pencil / ink). Used for approved summaries and published decision notes.
 */
export function InkNote({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: ReactNode;
}) {
  return (
    <div
      className={cn("border-rule-strong border-l-[1.5px] py-px pl-3.5", className)}
      data-slot="ink"
    >
      <p className="text-foreground font-serif text-base leading-tight tracking-wide [font-variant-caps:all-small-caps]">
        {label}
      </p>
      <div className="mt-1 font-serif text-base leading-normal break-words">{children}</div>
    </div>
  );
}
