import { PlusIcon } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/button";

/** The Signal mark: three rules, the outer two converging into one line (DESIGN.md → Identity). */
function SignalMark({ className }: { className?: string }) {
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

/** Header for the public Signal pages: mark and wordmark, Board, and the one way to submit. */
function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-[880px] items-center justify-between gap-4 px-4 py-3">
        <Link
          aria-label="Signal, the board"
          className="focus-visible:ring-ring/50 inline-flex items-center gap-2 rounded-md outline-none focus-visible:ring-3"
          href="/"
        >
          <SignalMark className="size-[22px]" />
          <span className="font-serif text-xl font-semibold tracking-tight">Signal</span>
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1">
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/">
            Board
          </Link>
          <Link className={buttonVariants({ size: "sm" })} href="/submit">
            <PlusIcon aria-hidden="true" />
            <span className="max-[359px]:sr-only">Submit a request</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

/** A public page: header, then one column (narrow for forms and reading, wide for lists). */
export function PageShell({
  children,
  width = "wide",
}: {
  children: React.ReactNode;
  width?: "narrow" | "wide";
}) {
  return (
    <>
      <SiteHeader />
      <main
        className={`mx-auto flex w-full min-w-0 flex-col gap-8 px-4 pt-10 pb-16 ${width === "narrow" ? "max-w-[720px]" : "max-w-[880px]"}`}
        id="main"
      >
        {children}
      </main>
    </>
  );
}

/** A page heading in Newsreader with an optional one-line lede. */
export function PageHeading({
  children,
  lede,
}: {
  children: React.ReactNode;
  lede?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-serif text-[30px] leading-tight font-medium tracking-tight">
        {children}
      </h1>
      {lede ? <p className="text-muted-foreground text-[15px]">{lede}</p> : null}
    </header>
  );
}
