import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const setCriteria = plannedOperation({
  access: "operator",
  http: { method: "PUT", path: "/api/operator/criteria" },
  name: "set_criteria",
});
