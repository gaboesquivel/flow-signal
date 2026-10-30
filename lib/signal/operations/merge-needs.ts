import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const mergeNeeds = plannedOperation({
  access: "operator",
  http: { method: "POST", path: "/api/operator/needs/:id/merge" },
  name: "merge_needs",
});
