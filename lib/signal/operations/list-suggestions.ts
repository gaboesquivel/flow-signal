import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const listSuggestions = plannedOperation({
  access: "operator",
  http: { method: "GET", path: "/api/operator/suggestions" },
  name: "list_suggestions",
});
