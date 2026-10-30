import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const getNeedDetail = plannedOperation({
  access: "operator",
  http: { method: "GET", path: "/api/operator/needs/:id" },
  name: "get_need_detail",
});
