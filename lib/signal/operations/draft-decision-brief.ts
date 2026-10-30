import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const draftDecisionBrief = plannedOperation({
  access: "operator",
  http: { method: "POST", path: "/api/operator/needs/:id/decision-brief" },
  name: "draft_decision_brief",
});
