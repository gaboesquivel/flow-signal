import type { PlannedOperation } from "./types";

/** Spec 013 task 04; replace this file with `defineOperation(...)`. */
export const getReport: PlannedOperation = {
  access: "operator",
  http: { method: "GET", path: "/api/operator/reports/:reportId" },
  name: "get_report",
  planned: true,
};
