import type { Metadata } from "next";

import { ReadyNeeds } from "@/app/_components/signal/ready-needs";
import { signalOperatorServerClient } from "@/app/_components/signal/server-client";
import { StrategyForm } from "@/app/_components/signal/strategy-form";

import { ConsoleError, ConsoleHeading } from "../_components/console-bits";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Decide · Signal" };

export default async function DecidePage() {
  const signal = await signalOperatorServerClient();
  const [strategy, ready, themes] = await Promise.all([
    signal.getStrategy({}),
    signal.listReadyNeeds({}),
    signal.listThemes({}),
  ]);
  // After a save, `router.refresh()` re-renders this page; a new strategy version or ready list
  // changes this key, so the ready list remounts with the fresh data.
  const version = strategy.ok ? (strategy.data.strategy?.version ?? 0) : 0;
  const readyKey = ready.ok ? ready.data.needs.map((n) => n.needId).join(",") : "";

  return (
    <div className="flex flex-col gap-8">
      <ConsoleHeading title="Decide">
        Needs past your readiness line, each with a drafted brief. Nothing is published until you
        do.
      </ConsoleHeading>
      <div className="flex max-w-3xl min-w-0 flex-col gap-14">
        {ready.ok ? (
          <ReadyNeeds initial={ready.data} key={`ready-${version}-${readyKey}`} />
        ) : (
          <ConsoleError error={ready.error} />
        )}
        {strategy.ok ? (
          <StrategyForm
            initial={strategy.data}
            themes={themes.ok ? themes.data.themes.map(({ id, name }) => ({ id, name })) : []}
          />
        ) : (
          <ConsoleError error={strategy.error} />
        )}
      </div>
    </div>
  );
}
