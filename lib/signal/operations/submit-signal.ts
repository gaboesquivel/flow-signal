import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const submitSignal = plannedOperation({
  access: "public",
  http: { method: "POST", path: "/api/signals" },
  name: "submit_signal",
});
