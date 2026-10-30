import type { PlannedOperation } from "./types";

/** Spec 013 task 04; replace this file with `defineOperation(...)`. */
export const saveReport: PlannedOperation = {
  access: "operator",
  http: { method: "POST", path: "/api/operator/reports" },
  name: "save_report",
  planned: true,
};
