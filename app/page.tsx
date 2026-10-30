import type { Metadata } from "next";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/empty";
import { Input } from "@/components/input";
import { Label } from "@/components/label";
import { NativeSelect, NativeSelectOption } from "@/components/native-select";

import { SignalErrorAlert } from "./_components/signal/error-alert";
import { boardStatuses, isBoardStatus, statusLabels } from "./_components/signal/labels";
import { NeedCard } from "./_components/signal/need-card";
import { signalServerClient } from "./_components/signal/server-client";
import { PageShell } from "./_components/signal/site-header";

export const metadata: Metadata = {
  description: "What customers are asking for, how it is grouped, and what was decided.",
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

export default async function BoardPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = single(params.q)?.slice(0, 200);
  const theme = single(params.theme)?.slice(0, 120);
  const statusParam = single(params.status);
  const status = isBoardStatus(statusParam) ? statusParam : undefined;
  const cursor = single(params.cursor);
  const filtered = Boolean(q || theme || status);

  const client = await signalServerClient();
  const [page, all] = await Promise.all([
    client.searchNeeds({ cursor, q, status, theme }),
    // The theme filter offers the themes that needs on the board belong to.
    client.searchNeeds({ limit: 50 }),
  ]);
  const themes = all.ok
    ? [
        ...new Map(
          all.data.needs.flatMap((need) => (need.theme ? [[need.theme.name, need.theme]] : [])),
        ).values(),
      ].toSorted((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <PageShell>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">What customers are asking for</h1>
        <p className="text-muted-foreground text-sm">
          Each need groups everyone who asked for the same thing, in their own words. Search before
          you submit, or{" "}
          <Link className="text-primary underline-offset-4 hover:underline" href="/submit">
            submit a request
          </Link>{" "}
          and we&apos;ll check for matches as you type.
        </p>
      </header>

      <search>
        <form action="/" className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="board-q">Search needs</Label>
            <Input
              defaultValue={q}
              id="board-q"
              maxLength={200}
              name="q"
              placeholder="e.g. PDF export"
              type="search"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="board-theme">Theme</Label>
            <NativeSelect defaultValue={theme ?? ""} id="board-theme" name="theme">
              <NativeSelectOption value="">All themes</NativeSelectOption>
              {themes.map((item) => (
                <NativeSelectOption key={item.id} value={item.name}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="board-status">Status</Label>
            <NativeSelect defaultValue={status ?? ""} id="board-status" name="status">
              <NativeSelectOption value="">Any status</NativeSelectOption>
              {boardStatuses.map((item) => (
                <NativeSelectOption key={item} value={item}>
                  {statusLabels[item]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit">Search</Button>
        </form>
      </search>

      <section aria-label="Needs" aria-live="polite" className="flex flex-col gap-3">
        {page.ok ? (
          <>
            {page.data.needs.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>{filtered ? "No needs match" : "No needs yet"}</EmptyTitle>
                  <EmptyDescription>
                    {filtered
                      ? "Try fewer words or another theme or status. If nobody has asked for it yet, you can be the first."
                      : "Nobody has submitted a request yet. Be the first."}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Link className={buttonVariants()} href="/submit">
                    Submit a request
                  </Link>
                  {filtered ? (
                    <Link className={buttonVariants({ variant: "ghost" })} href="/">
                      Clear filters
                    </Link>
                  ) : null}
                </EmptyContent>
              </Empty>
            ) : (
              page.data.needs.map((need) => <NeedCard key={need.id} need={need} />)
            )}
            <nav aria-label="Pages" className="flex justify-between gap-2">
              {cursor ? (
                <Link
                  className={buttonVariants({ variant: "ghost" })}
                  href={boardHref({ q, status, theme })}
                >
                  Back to the first page
                </Link>
              ) : (
                <span />
              )}
              {page.data.nextCursor ? (
                <Link
                  className={buttonVariants({ variant: "outline" })}
                  href={boardHref({ cursor: page.data.nextCursor, q, status, theme })}
                >
                  More needs
                </Link>
              ) : null}
            </nav>
          </>
        ) : (
          <SignalErrorAlert error={page.error} />
        )}
      </section>
    </PageShell>
  );
}
