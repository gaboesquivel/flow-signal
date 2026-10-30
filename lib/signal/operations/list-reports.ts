import type { PlannedOperation } from "./types";

/** Spec 013 task 04; replace this file with `defineOperation(...)`. */
export const listReports: PlannedOperation = {
  access: "operator",
  http: { method: "GET", path: "/api/operator/reports" },
  name: "list_reports",
  planned: true,
};
