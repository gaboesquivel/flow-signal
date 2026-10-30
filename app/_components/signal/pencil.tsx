import { cn } from "cn";
import { Check, Pencil as PencilIcon, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * AI output in pencil until a person confirms it in ink (DESIGN.md → Pencil / ink).
 * - suggested: dashed `ai` rule, `ai-foreground` text, italic small-caps label.
 * - accepted: solid `rule-strong` rule, normal text.
 * - edited: accepted plus a small italic "edited by you".
 * - rejected: struck and faded text; the label stays at full contrast and says "rejected".
 */
export type PencilState = "accepted" | "edited" | "rejected" | "suggested";

const ruleByState: Record<PencilState, string> = {
  accepted: "border-rule-strong text-foreground",
  edited: "border-rule-strong text-foreground",
  rejected: "border-border text-foreground",
  suggested: "border-ai text-ai-foreground border-dashed",
};

const labelIcon = { "aria-hidden": true, className: "size-3 shrink-0" } as const;

export function Pencil({
  children,
  className,
  label = "Suggested",
  state,
}: {
  children: ReactNode;
  className?: string;
  /** Names what the AI wrote, e.g. "Why it matches" or "Your need, as we understand it". */
  label?: string;
  state: PencilState;
}) {
  const ink = state === "accepted" || state === "edited";
  return (
    <div
      className={cn("border-l-[1.5px] py-px pl-3.5", ruleByState[state], className)}
      data-slot="pencil"
      data-state={state}
    >
      <p
        className={cn(
          "inline-flex items-center gap-1.5 font-serif text-base leading-tight tracking-wide [font-variant-caps:all-small-caps]",
          state === "suggested" ? "text-ai-foreground italic" : "text-foreground",
        )}
      >
        {state === "suggested" ? <PencilIcon {...labelIcon} strokeWidth={1.75} /> : null}
        {ink ? <Check {...labelIcon} strokeWidth={2.25} /> : null}
        {state === "rejected" ? <X {...labelIcon} strokeWidth={2.25} /> : null}
        {label}
        {state === "suggested" ? <span className="sr-only"> (Suggested by AI)</span> : null}
        {state === "rejected" ? (
          <span className="text-muted-foreground font-serif text-sm italic [font-variant-caps:normal]">
            rejected
          </span>
        ) : null}
      </p>
      <div
        className={cn(
          "mt-1",
          state === "rejected" && "text-muted-foreground line-through decoration-1 opacity-70",
        )}
      >
        {children}
      </div>
      {state === "edited" ? (
        <p className="text-muted-foreground mt-1 font-serif text-[13px] italic">edited by you</p>
      ) : null}
    </div>
  );
}
