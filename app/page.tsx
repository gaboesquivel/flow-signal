import { SearchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/button";

import { SignalErrorAlert } from "./_components/signal/error-alert";
import { isBoardStatus } from "./_components/signal/labels";
import { NeedRow } from "./_components/signal/need-card";
import { signalServerClient } from "./_components/signal/server-client";
import { PageHeading, PageShell } from "./_components/signal/site-header";
import { StatusFilter } from "./_components/signal/status-filter";

export const metadata: Metadata = {
  description: "What customers have asked for, and what we decided.",
  title: "Board · Signal",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const single = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

const boardHref = (params: Record<string, string | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const search = query.toString();
  return search ? `/?${search}` : "/";
};

const textLink = "text-primary underline-offset-4 hover:underline";

export default async function BoardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = single(params.q)?.slice(0, 200);
  // Theme links from elsewhere still filter; the board itself offers search and status only.
  const theme = single(params.theme)?.slice(0, 120);
  const statusParam = single(params.status);
  const status = isBoardStatus(statusParam) ? statusParam : undefined;
  const cursor = single(params.cursor);
  const filtered = Boolean(q || theme || status);

  const client = await signalServerClient();
  const page = await client.searchNeeds({ cursor, q, status, theme });

  return (
    <PageShell>
      <PageHeading lede="What customers have asked for, and what we decided.">Board</PageHeading>

      <div className="flex min-w-0 flex-col">
        <search>
          <form action="/" className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b pb-4">
            <label className="flex min-w-0 flex-1 basis-60 items-center gap-2">
              <SearchIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
              <span className="sr-only">Search needs</span>
              <input
                className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent py-1 text-[15px] outline-none"
                defaultValue={q}
                maxLength={200}
                name="q"
                placeholder="Search needs"
                type="search"
              />
            </label>
            {theme ? <input name="theme" type="hidden" value={theme} /> : null}
            <StatusFilter status={status} />
            <button className="sr-only" type="submit">
              Search
            </button>
          </form>
        </search>

        <section aria-label="Needs" aria-live="polite" className="flex flex-col gap-6">
          {page.ok ? (
            <>
              {page.data.needs.length === 0 ? (
                <div className="flex flex-col items-start gap-3 py-10">
                  <p className="font-serif text-xl">
                    {filtered ? "No needs match." : "Nobody has asked for anything yet."}
                  </p>
                  <p className="text-muted-foreground text-[15px]">
                    {filtered
                      ? "Try fewer words or another status. If nobody has asked for it yet, you can be the first."
                      : "Be the first: tell us what you need."}
                  </p>
                  <div className="flex flex-wrap items-center gap-4">
                    <Link className={buttonVariants()} href="/submit">
                      Submit a request
                    </Link>
                    {filtered ? (
                      <Link className={textLink} href="/">
                        Clear search
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : (
                <ol className="m-0 list-none p-0">
                  {page.data.needs.map((need) => (
                    <NeedRow key={need.id} need={need} />
                  ))}
                </ol>
              )}
              {cursor || page.data.nextCursor ? (
                <nav aria-label="Pages" className="flex justify-between gap-2 text-sm">
                  {cursor ? (
                    <Link className={textLink} href={boardHref({ q, status, theme })}>
                      ← First page
                    </Link>
                  ) : (
                    <span />
                  )}
                  {page.data.nextCursor ? (
                    <Link
                      className={textLink}
                      href={boardHref({ cursor: page.data.nextCursor, q, status, theme })}
                    >
                      More needs →
                    </Link>
                  ) : null}
                </nav>
              ) : null}
            </>
          ) : (
            <div className="pt-8">
              <SignalErrorAlert
                error={page.error}
                retryHref={boardHref({ cursor, q, status, theme })}
              />
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
