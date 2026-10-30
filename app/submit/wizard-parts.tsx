"use client";

import { cn } from "cn";
import type { ComponentProps, ReactNode, Ref } from "react";

import type { WizardStep } from "./submit-model";

const shownSteps = [
  { label: "Describe", step: "describe" },
  { label: "Check", step: "check" },
  { label: "Details", step: "details" },
] as const;
const order: WizardStep[] = ["describe", "check", "details", "done"];

/** A hairline rule per step at the top of the wizard: done in ink, current in the primary. */
export function StepRule({ step }: { step: WizardStep }) {
  const current = order.indexOf(step);
  return (
    <ol aria-label="Steps" className="m-0 grid list-none grid-cols-3 gap-1.5 p-0">
      {shownSteps.map((item, index) => {
        let state: "current" | "done" | "todo" = "todo";
        if (index < current) state = "done";
        else if (index === current) state = "current";
        return (
          <li
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "border-t-2 pt-2 text-xs",
              state === "done" && "border-foreground text-muted-foreground",
              state === "current" && "border-primary text-foreground font-medium",
              state === "todo" && "border-border text-muted-foreground",
            )}
            key={item.step}
          >
            {item.label}
            {state === "done" ? <span className="sr-only"> (done)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The step's question, focused when the step opens so screen readers hear where they are. */
export function StepTitle({
  children,
  headingRef,
  sub,
}: {
  children: ReactNode;
  headingRef: Ref<HTMLHeadingElement>;
  sub?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      <h1
        className="font-serif text-[25px] leading-tight font-medium tracking-tight outline-none sm:text-[30px]"
        ref={headingRef}
        tabIndex={-1}
      >
        {children}
      </h1>
      {sub ? <p className="text-muted-foreground text-[15px]">{sub}</p> : null}
    </header>
  );
}

/** A secondary action as text, never a second primary button. */
export function TextButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      className={cn(
        "text-primary focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 disabled:opacity-50",
        className,
      )}
      type="button"
      {...props}
    />
  );
}

/** The foot of a step: secondary text actions on the left, the one primary action on the right. */
export function StepFoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse items-stretch gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Field label with an optional "Optional" marker. */
export function FieldLabel({
  children,
  htmlFor,
  optional,
}: {
  children: ReactNode;
  htmlFor: string;
  optional?: boolean;
}) {
  return (
    <label className="text-sm font-medium" htmlFor={htmlFor}>
      {children}
      {optional ? (
        <span className="text-muted-foreground ml-1.5 text-xs font-normal">Optional</span>
      ) : null}
    </label>
  );
}

export const primaryButton = "h-10 px-4 text-[15px]";
