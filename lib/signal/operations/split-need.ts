import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const splitNeed = plannedOperation({
  access: "operator",
  http: { method: "POST", path: "/api/operator/needs/:id/split" },
  name: "split_need",
});
