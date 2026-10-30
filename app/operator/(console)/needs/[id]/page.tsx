import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ConsoleError, ConsoleHeading } from "../../_components/console-bits";
import { operatorServerClient } from "../../_lib/operator-client";
import { NeedView } from "./need-view";

export const metadata: Metadata = { title: "Need · Signal" };

/**
 * One need, read and decided (spec 006 task 06): every signal verbatim, accounts, merge history,
 * the priority breakdown, then draft brief → decide → publish. Reads get_need_detail.
 */
export default async function NeedDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await operatorServerClient();
  const result = await client.getNeedDetail({ id });

  if (!result.ok) {
    if (result.error.code === "unauthorized") redirect("/operator/access");
    if (result.error.code === "not_found" || result.error.code === "validation_failed") notFound();
    return (
      <div className="flex flex-col gap-6">
        <ConsoleHeading title="Need" />
        <ConsoleError error={result.error} />
      </div>
    );
  }

  return <NeedView initial={result.data} />;
}
