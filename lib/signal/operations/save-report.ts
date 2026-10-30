import { z } from "zod";

import {
  previewSaveReport,
  reportIdempotencyKeySchema,
  reportDepsFor,
  saveReport as save,
} from "../domain/reports";
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
  async preview(input, { db }) {
    const effect = await previewSaveReport(db, input);
    const kindCounts = new Map<string, number>();
    for (const block of effect.spec.blocks)
      kindCounts.set(block.kind, (kindCounts.get(block.kind) ?? 0) + 1);
    const blockKinds = [...kindCounts].map(([kind, count]) => `${count} ${kind}`);
    return {
      blocks: [],
      editable: [{ key: "title", kind: "text", label: "Title" }],
      lines: [
        { label: "Action", value: effect.created ? "Create" : "Update" },
        { label: "Title", value: input.title },
        ...(effect.existingTitle && effect.existingTitle !== input.title
          ? [{ label: "Title before", value: effect.existingTitle }]
          : []),
        { label: "Blocks", value: `${effect.spec.blocks.length} (${blockKinds.join(", ")})` },
        {
          label: "Datasets",
          value: effect.spec.datasets.map((dataset) => dataset.name).join(", ") || "none",
        },
      ],
      needs: [],
      notes: [
        ...(effect.keepsSharedSnapshot
          ? ["The share link keeps showing its snapshot until you refresh it."]
          : []),
        ...(effect.replay ? ["Already saved with this key; confirming returns that save."] : []),
      ],
      title: effect.created ? "Save a new report" : "Update a saved report",
    };
  },
  run(input, ctx) {
    return save(reportDepsFor(ctx), input);
  },
});
