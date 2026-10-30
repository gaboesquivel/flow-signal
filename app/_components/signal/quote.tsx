import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * A customer's words, verbatim, in serif italic behind a solid quote rule (DESIGN.md → Quotes).
 * `cite` (person · account · plan) is for the PM console only; public pages leave it out.
 */
export function Quote({
  children,
  cite,
  className,
}: {
  children: ReactNode;
  cite?: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("border-quote-rule m-0 border-l-[3px] py-0.5 pl-4", className)}>
      <blockquote className="font-serif text-[17px] leading-snug italic break-words">
        {children}
      </blockquote>
      {cite ? (
        <figcaption className="text-muted-foreground mt-1.5 font-sans text-xs not-italic">
          {cite}
        </figcaption>
      ) : null}
    </figure>
  );
}
