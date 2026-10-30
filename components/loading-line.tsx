import { cn } from "cn";
import type * as React from "react";

/**
 * A calm one-line loading state with a thin progress rule; never a spinner over content
 * (DESIGN.md → Loading). Reduced motion shows a still rule.
 */
function LoadingLine({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-live="polite"
      className={cn("text-muted-foreground py-2", className)}
      data-slot="loading-line"
      role="status"
      {...props}
    >
      <p className="m-0 font-serif text-lg">{children}</p>
      <div aria-hidden="true" className="bg-border mt-4 h-0.5 max-w-60 overflow-hidden">
        <div className="bg-primary animate-loading-line h-full w-[35%] motion-reduce:w-[60%] motion-reduce:animate-none" />
      </div>
    </div>
  );
}

export { LoadingLine };
