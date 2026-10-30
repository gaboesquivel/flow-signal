import { cn } from "cn";
import type { ReactNode } from "react";

import type { NeedStatus } from "./labels";
import { statusLabels } from "./labels";

/** Status is always a word plus a small shape, never colour alone (DESIGN.md → Tokens). */

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;

const shapes: Record<NeedStatus, ReactNode> = {
  declined: (
    <>
      <rect height="9.6" rx="1.5" width="9.6" x="1.2" y="1.2" {...stroke} />
      <path d="M3.6 3.6l4.8 4.8M8.4 3.6 3.6 8.4" {...stroke} strokeLinecap="round" />
    </>
  ),
  in_progress: (
    <>
      <circle cx="6" cy="6" r="4.6" {...stroke} />
      <path d="M6 1.4a4.6 4.6 0 0 1 0 9.2Z" fill="currentColor" />
    </>
  ),
  // Two rules converging into one, like the mark: this need now lives in another.
  merged: <path d="M1 2.5h3.5L8 6 4.5 9.5H1M8 6h3" {...stroke} strokeLinejoin="round" />,
  new: <circle cx="6" cy="6" r="4.6" {...stroke} />,
  open: <circle cx="6" cy="6" fill="currentColor" r="5.2" />,
  planned: (
    <>
      <path d="M6 .8 11.2 6 6 11.2.8 6Z" {...stroke} />
      <circle cx="6" cy="6" fill="currentColor" r="1.8" />
    </>
  ),
  shipped: (
    <>
      <rect fill="currentColor" height="10.8" rx="2" width="10.8" x=".6" y=".6" />
      <path
        className="stroke-background"
        d="m3.2 6.1 1.9 1.9 3.8-4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </>
  ),
};

const colors: Record<NeedStatus, string> = {
  declined: "text-status-declined",
  in_progress: "text-status-progress",
  merged: "text-status-new",
  new: "text-status-new",
  open: "text-status-open",
  planned: "text-status-planned",
  shipped: "text-status-shipped",
};

export function StatusShape({ className, status }: { className?: string; status: NeedStatus }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-[11px] shrink-0", colors[status], className)}
      viewBox="0 0 12 12"
    >
      {shapes[status]}
    </svg>
  );
}

export function Status({ className, status }: { className?: string; status: NeedStatus }) {
  return (
    <span
      className={cn(
        "text-foreground inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap",
        className,
      )}
      data-slot="status"
      data-status={status}
    >
      <StatusShape status={status} />
      {statusLabels[status]}
    </span>
  );
}
