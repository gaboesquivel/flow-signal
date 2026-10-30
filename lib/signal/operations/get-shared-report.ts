import type { PlannedOperation } from "./types";

/** Spec 013 task 04; replace this file with `defineOperation(...)`. */
export const getSharedReport: PlannedOperation = {
  access: "public",
  http: { method: "GET", path: "/api/shared-reports/:token" },
  name: "get_shared_report",
  planned: true,
};
