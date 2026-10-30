import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const getMySignals = plannedOperation({
  access: "public",
  http: { method: "GET", path: "/api/my-signals/:token" },
  name: "get_my_signals",
});
