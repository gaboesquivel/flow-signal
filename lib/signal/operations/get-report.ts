import { z } from "zod";

import { datasetResultSchema } from "../domain/report-datasets";
import { reportSpecSchema } from "../domain/report-spec";
import { getReport as get, reportDepsFor } from "../domain/reports";
import { defineOperation } from "./types";

export const getReport = defineOperation({
  access: "operator",
  description:
    "Open a saved report by `reportId` (from list_reports or save_report). Re-runs its dataset queries now, with no model call, and returns `{ reportId, title, prompt, spec, data, asOf, share }`: `data` holds each dataset's columns and rows keyed by dataset id (money in cents), `asOf` is when the queries ran, and `share` is `{ path, sharedAt, snapshotAt }` while a read-only link is live (the link shows the snapshot from `snapshotAt`, not this data), else null. Every figure must come from `data`. Unknown id: `not_found`.",
  errors: ["not_found"],
  http: { method: "GET", path: "/api/operator/reports/:reportId" },
  input: z.object({ reportId: z.uuid() }),
  name: "get_report",
  output: z.object({
    asOf: z.iso.datetime({ offset: true }),
    data: z.record(z.string(), datasetResultSchema),
    prompt: z.string(),
    reportId: z.uuid(),
    share: z
      .object({
        path: z.string(),
        sharedAt: z.iso.datetime({ offset: true }),
        snapshotAt: z.iso.datetime({ offset: true }),
      })
      .nullable(),
    spec: reportSpecSchema,
    title: z.string(),
  }),
  run({ reportId }, ctx) {
    return get(reportDepsFor(ctx), reportId);
  },
});
