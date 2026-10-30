import type { Metadata } from "next";
import { redirect } from "next/navigation";

import type { SignalClientError } from "@/lib/signal/client";

import { ConsoleError, ConsoleHeading } from "../_components/console-bits";
import { operatorServerClient } from "../_lib/operator-client";
import { CriteriaView } from "./criteria-view";

export const metadata: Metadata = { title: "Criteria · Signal" };

/** The four priority weights (get_criteria) and every need's criterion scores for the preview. */
export default async function CriteriaPage() {
  const client = await operatorServerClient();
  const [criteria, needs] = await Promise.all([
    client.getCriteria({}),
    client.listOperatorNeeds({ sort: "priority" }),
  ]);

  if (!criteria.ok) return <Failed error={criteria.error} />;
  if (!needs.ok) return <Failed error={needs.error} />;

  return (
    <CriteriaView
      criteria={criteria.data.criteria}
      needs={needs.data.needs.map(({ criterionScores, id, people, statement }) => ({
        criterionScores,
        id,
        people,
        statement,
      }))}
    />
  );
}

function Failed({ error }: { error: Pick<SignalClientError, "code" | "message"> }) {
  if (error.code === "unauthorized") redirect("/operator/access");
  return (
    <div className="flex flex-col gap-6">
      <ConsoleHeading title="Criteria" />
      <ConsoleError error={error} />
    </div>
  );
}
