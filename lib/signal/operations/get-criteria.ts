import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const getCriteria = plannedOperation({
  access: "operator",
  http: { method: "GET", path: "/api/operator/criteria" },
  name: "get_criteria",
});
