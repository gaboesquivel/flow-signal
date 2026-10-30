import type { PlannedOperation } from "./types";

/** Spec 013 task 02; replace this file with `defineOperation(...)`. */
export const getReportDataset: PlannedOperation = {
  access: "operator",
  http: { method: "GET", path: "/api/operator/report-datasets/:name" },
  name: "get_report_dataset",
  planned: true,
};
