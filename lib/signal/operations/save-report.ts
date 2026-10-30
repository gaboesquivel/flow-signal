import { z } from "zod";

import { reportIdempotencyKeySchema, reportDepsFor, saveReport as save } from "../domain/reports";
import { reportSpecSchema } from "../domain/report-spec";
import { defineOperation } from "./types";

export const saveReport = defineOperation({
  access: "operator",
  description:
    "Save a report spec (usually the `report` that generate_report returned) so the PM can reopen it later. Pass `title`, the `prompt` it was generated from, and `spec`; omit `reportId` to create a report, or pass it to update that report in place (same id). Never send data rows: Signal validates the spec and re-runs every dataset on the server to store the snapshot. An invalid spec (unknown dataset id, missing or non-numeric column, a donut with two y columns) is `validation_failed` with the issues in the message; an unknown `reportId` is `not_found`. Pass an `idempotencyKey` when you may retry: a retry with the same key returns the first result and is counted once. Returns `{ reportId, created, title, updatedAt, snapshotAt }`. While a report has a live share link, saving does not change what the link shows; refresh it with share_report.",
  effects: "write",
  errors: ["not_found"],
  http: { method: "POST", path: "/api/operator/reports" },
  input: z.object({
    idempotencyKey: reportIdempotencyKeySchema.optional(),
    prompt: z.string().max(2000),
    reportId: z.uuid().optional(),
    spec: reportSpecSchema,
    title: z.string().trim().min(1).max(120),
  }),
  limits: { maxBodyBytes: 64 * 1024 },
  name: "save_report",
  output: z.object({
    created: z.boolean(),
    reportId: z.uuid(),
    snapshotAt: z.iso.datetime({ offset: true }),
    title: z.string(),
    updatedAt: z.iso.datetime({ offset: true }),
  }),
  run(input, ctx) {
    return save(reportDepsFor(ctx), input);
  },
});
