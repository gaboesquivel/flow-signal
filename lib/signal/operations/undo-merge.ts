import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const undoMerge = plannedOperation({
  access: "operator",
  http: { method: "POST", path: "/api/operator/merges/:id/undo" },
  name: "undo_merge",
});
