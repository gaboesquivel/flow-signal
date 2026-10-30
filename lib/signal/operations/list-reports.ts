import { z } from "zod";

import { listReports as list } from "../domain/reports";
import { defineOperation } from "./types";

export const listReports = defineOperation({
  access: "operator",
  description:
    "List the PM's saved reports, most recently updated first: `reportId`, `title`, `updatedAt`, and `sharedAt` (when its read-only link was first shared, or null when it has no live link). Open one with get_report.",
  errors: [],
  http: { method: "GET", path: "/api/operator/reports" },
  input: z.object({}),
  name: "list_reports",
  output: z.object({
    reports: z.array(
      z.object({
        reportId: z.uuid(),
        sharedAt: z.iso.datetime({ offset: true }).nullable(),
        title: z.string(),
        updatedAt: z.iso.datetime({ offset: true }),
      }),
    ),
  }),
  async run(_input, { db }) {
    return { reports: await list(db) };
  },
});
