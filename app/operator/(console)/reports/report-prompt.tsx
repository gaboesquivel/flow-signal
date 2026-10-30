"use client";

import { ArrowRight } from "lucide-react";
import type { Ref } from "react";

import { Button } from "@/components/button";

/** One plain-words field with a submit button, shared by "describe" and "refine". */
export function ReportPrompt({
  busy = false,
  inputRef,
  label,
  onChange,
  onSubmit,
  placeholder,
  submitLabel,
  value,
  variant = "outline",
}: {
  busy?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  submitLabel: string;
  value: string;
  /** "default" when the prompt is the page's one primary action. */
  variant?: "default" | "outline";
}) {
  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && value.trim()) onSubmit();
      }}
    >
      <label className="min-w-0 flex-1">
        <span className="sr-only">{label}</span>
        <input
          autoComplete="off"
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-10 w-full rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:ring-3"
          maxLength={2000}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          ref={inputRef}
          value={value}
        />
      </label>
      <Button
        className="h-10 px-4"
        disabled={busy || !value.trim()}
        type="submit"
        variant={variant}
      >
        {submitLabel} <ArrowRight aria-hidden="true" data-icon="inline-end" />
      </Button>
    </form>
  );
}
