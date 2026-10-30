import Link from "next/link";

import { buttonVariants } from "@/components/button";

/** Header for the public Signal pages. */
export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
        <Link
          className="focus-visible:ring-ring/50 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-3"
          href="/"
        >
          Signal
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1">
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/">
            Board
          </Link>
          <Link className={buttonVariants({ size: "sm" })} href="/submit">
            Submit a request
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8" id="main">
        {children}
      </main>
    </>
  );
}
