import type { PlannedOperation } from "./types";

/** Spec 013 task 03; replace this file with `defineOperation(...)`. */
export const generateReport: PlannedOperation = {
  access: "operator",
  http: { method: "POST", path: "/api/operator/reports/generate" },
  name: "generate_report",
  planned: true,
};
