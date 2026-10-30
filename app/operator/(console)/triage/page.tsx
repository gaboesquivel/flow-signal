import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConsoleError, ConsoleHeading } from "../_components/console-bits";
import { operatorServerClient } from "../_lib/operator-client";
import { TriageView } from "./triage-view";

export const metadata: Metadata = { title: "Triage · Signal" };

/** Pending AI suggestions, newest first (list_suggestions), cleared one row at a time. */
export default async function TriagePage() {
  const client = await operatorServerClient();
  const result = await client.listSuggestions({ limit: 100 });

  if (!result.ok) {
    if (result.error.code === "unauthorized") redirect("/operator/access");
    return (
      <div className="flex flex-col gap-6">
        <ConsoleHeading title="Triage" />
        <ConsoleError error={result.error} />
      </div>
    );
  }

  return (
    <TriageView
      more={result.data.nextCursor !== null}
      // A server component renders once per request; "now" anchors the rows' ages.
      // oxlint-disable-next-line react/purity
      now={new Date().toISOString()}
      suggestions={result.data.suggestions}
    />
  );
}
