import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { SearchParams } from "nuqs/server";

import { ConsoleError, ConsoleHeading } from "../_components/console-bits";
import { themesOf } from "../_lib/console";
import { loadNeedsSearchParams } from "../_lib/needs-params";
import { operatorServerClient } from "../_lib/operator-client";
import { NeedsView } from "./needs-view";

export const metadata: Metadata = { title: "Needs · Signal" };

/** Every live need in one list_operator_needs call, filtered and sorted from the URL. */
export default async function NeedsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { q, sort, status, theme } = loadNeedsSearchParams(await searchParams);
  const filtered = Boolean(q || status || theme);
  const client = await operatorServerClient();
  const [result, all] = await Promise.all([
    client.listOperatorNeeds({
      query: q || undefined,
      sort,
      status: status ?? undefined,
      themeId: theme ?? undefined,
    }),
    // Theme options come from every need, so filtering by one theme keeps the others listed.
    filtered ? client.listOperatorNeeds({}) : null,
  ]);

  if (!result.ok) {
    if (result.error.code === "unauthorized") redirect("/operator/access");
    return (
      <div className="flex flex-col gap-6">
        <ConsoleHeading title="Needs" />
        <ConsoleError error={result.error} />
      </div>
    );
  }

  const themeSource = all?.ok ? all.data.needs : result.data.needs;
  return <NeedsView needs={result.data.needs} themes={themesOf(themeSource)} />;
}
