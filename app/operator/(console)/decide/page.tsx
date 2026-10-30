import Link from "next/link";

import { SignalErrorAlert } from "@/app/_components/signal/error-alert";
import { ReadyNeeds } from "@/app/_components/signal/ready-needs";
import { signalOperatorServerClient } from "@/app/_components/signal/server-client";
import { StrategyForm } from "@/app/_components/signal/strategy-form";
import type { ThemeOption } from "@/app/_components/signal/strategy-form";
import type { SignalClient } from "@/lib/signal/client";

export const dynamic = "force-dynamic";

/**
 * Themes for the focus picker. No operation lists themes yet, so this collects the themes of
 * live needs from `search_needs` (a few pages); themes with no live need are not offered.
 */
const listThemes = async (signal: SignalClient): Promise<ThemeOption[]> => {
  const found = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    // Pages depend on the previous cursor, so they load one after another.
    // oxlint-disable-next-line no-await-in-loop
    const result = await signal.searchNeeds({ cursor, limit: 50 });
    if (!result.ok) break;
    for (const need of result.data.needs) if (need.theme) found.set(need.theme.id, need.theme.name);
    if (!result.data.nextCursor) break;
    cursor = result.data.nextCursor;
  }
  return [...found]
    .map(([id, name]) => ({ id, name }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

export default async function DecidePage() {
  const signal = await signalOperatorServerClient();
  const [strategy, ready, themes] = await Promise.all([
    signal.getStrategy({}),
    signal.listReadyNeeds({}),
    listThemes(signal),
  ]);
  // After a save, `router.refresh()` re-renders this page; a new strategy version or ready list
  // changes this key, so the ready list remounts with the fresh data.
  const version = strategy.ok ? (strategy.data.strategy?.version ?? 0) : 0;
  const readyKey = ready.ok ? ready.data.needs.map((n) => n.needId).join(",") : "";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-baseline justify-between border-b px-6 py-3">
        <div>
          <p className="text-muted-foreground text-xs uppercase tracking-wide">Operator</p>
          <h1 className="font-semibold text-sm">Decide</h1>
        </div>
        <Link className="text-muted-foreground text-sm hover:underline" href="/operator">
          Console
        </Link>
      </header>
      <main className="mx-auto w-full max-w-3xl space-y-10 px-4 py-8 text-sm sm:px-6">
        {ready.ok ? (
          <ReadyNeeds initial={ready.data} key={`ready-${version}-${readyKey}`} />
        ) : (
          <SignalErrorAlert error={ready.error} />
        )}
        {strategy.ok ? (
          <StrategyForm initial={strategy.data} themes={themes} />
        ) : (
          <SignalErrorAlert error={strategy.error} />
        )}
      </main>
    </div>
  );
}
