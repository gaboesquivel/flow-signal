import { plannedOperation } from "./types";

/** Planned (spec 001 Tasks); replace this file with `defineOperation(...)` when building it. */
export const resolveSuggestion = plannedOperation({
  access: "operator",
  http: { method: "POST", path: "/api/operator/suggestions/:id/resolve" },
  name: "resolve_suggestion",
});
