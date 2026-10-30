import type { PlannedOperation } from "./types";

/** Spec 013 task 04; replace this file with `defineOperation(...)`. */
export const shareReport: PlannedOperation = {
  access: "operator",
  http: { method: "POST", path: "/api/operator/reports/:reportId/share" },
  name: "share_report",
  planned: true,
};
