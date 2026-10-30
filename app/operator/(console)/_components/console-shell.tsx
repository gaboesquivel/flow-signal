"use client";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { browserSignal, pendingCountKey } from "./operator-browser";

/** The live triage count: pending suggestions, re-read every minute and after each resolve. */
export interface PendingCount {
  count: number;
  more: boolean;
}

const PENDING_LIMIT = 100;

export const fetchPendingCount = async (): Promise<PendingCount> => {
  const result = await browserSignal.listSuggestions({ limit: PENDING_LIMIT });
  if (!result.ok) throw new Error(result.error.code);
  return { count: result.data.suggestions.length, more: result.data.nextCursor !== null };
};

const links = [
  { href: "/operator/triage", label: "Triage" },
  { href: "/operator/needs", label: "Needs" },
  { href: "/operator/criteria", label: "Criteria" },
  { href: "/operator/metrics", label: "Metrics" },
  { href: "/operator/chat", label: "Chat" },
] as const;

function Mark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 32 32">
      <g fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="3.2">
        <path d="M2 6.5h7.5L18 16" />
        <path d="M2 25.5h7.5L18 16" />
        <path d="M2 16h28" />
      </g>
    </svg>
  );
}

/** PM console top bar (DESIGN.md → PM console): mark, Triage (count) · Needs · Criteria · Metrics · Chat. */
export function ConsoleShell({
  children,
  initialPending,
}: {
  children: ReactNode;
  initialPending: PendingCount | null;
}) {
  const pathname = usePathname();
  const pending = useQuery({
    initialData: initialPending ?? undefined,
    queryFn: fetchPendingCount,
    queryKey: pendingCountKey,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  return (
    <div className="bg-background flex min-h-screen flex-col text-sm">
      <header className="border-border border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-x-6 px-4 sm:px-6">
          <Link
            className="focus-visible:ring-ring/50 flex shrink-0 items-center gap-2 rounded-sm py-3 outline-none focus-visible:ring-3"
            href="/operator/triage"
          >
            <Mark className="size-5" />
            <span className="font-serif text-lg font-semibold tracking-tight max-sm:sr-only">
              Signal
            </span>
          </Link>
          <nav aria-label="Console" className="-mb-px flex min-w-0 flex-1 overflow-x-auto">
            <ul className="m-0 flex list-none gap-1 p-0 sm:gap-3">
              {links.map((link) => {
                const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
                return (
                  <li key={link.href}>
                    <Link
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "focus-visible:ring-ring/50 flex items-baseline gap-1.5 border-b-2 px-1.5 py-3.5 whitespace-nowrap outline-none focus-visible:ring-3",
                        current
                          ? "border-rule-strong text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground border-transparent",
                      )}
                      href={link.href}
                    >
                      {link.label}
                      {link.href === "/operator/triage" && pending.data ? (
                        <span
                          className="text-primary font-mono text-xs tabular-nums"
                          data-testid="pending-count"
                        >
                          <span className="sr-only">, </span>
                          {pending.data.count}
                          {pending.data.more ? "+" : ""}
                          <span className="sr-only"> pending</span>
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <p className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase max-md:hidden">
            Operator
          </p>
        </div>
      </header>
      <main
        className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 pt-8 pb-16 sm:px-6 lg:px-28"
        id="main"
      >
        {children}
      </main>
    </div>
  );
}
