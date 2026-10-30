import { asc } from "drizzle-orm";
import { z } from "zod";

import { themes } from "@/lib/db/schema";

import { generateReport as generate } from "../domain/report-generation";
import {
  datasetDescriptions,
  datasetNames,
  datasetResultSchema,
  runReportDataset,
} from "../domain/report-datasets";
import { reportSpecSchema } from "../domain/report-spec";
import { defineOperation } from "./types";

const catalogLines = datasetNames.map((name) => `- ${datasetDescriptions[name]}`).join("\n");

export const generateReport = defineOperation({
  access: "operator",
  description: `Build a report from a plain-words request ("ARR-weighted demand by theme, plus the top 10 Enterprise needs"). Signal plans dataset queries from a fixed catalog, runs them on the server, and lays out headings, short text, KPIs, charts (bar, line, area, scatter, donut), and tables that reference dataset columns; every number comes from the data. Pass the previous \`report\` as \`prior\` with a refinement ("make it weekly", "only Growth accounts") to modify it. Returns \`{ report, data, asOf, warnings }\`; \`warnings\` names parts of the request no dataset covers and blocks that were dropped. Saves nothing: call save_report to keep it. Fails with ai_unavailable when the model is unreachable, and validation_failed when no dataset or block could be built. Datasets:\n${catalogLines}`,
  effects: "read",
  errors: ["ai_unavailable"],
  http: { method: "POST", path: "/api/operator/reports/generate" },
  input: z.object({
    prior: reportSpecSchema.optional(),
    prompt: z.string().trim().min(1).max(2000),
  }),
  limits: { maxBodyBytes: 64 * 1024 },
  name: "generate_report",
  output: z.object({
    asOf: z.iso.datetime(),
    data: z.record(z.string(), datasetResultSchema),
    report: reportSpecSchema,
    warnings: z.array(z.string()),
  }),
  run(input, { ai, clock, db }) {
    const now = clock.now();
    return generate(
      {
        now,
        reasoner: ai.reasoner,
        runDataset: (query) => runReportDataset(db, query, now),
        themes: () =>
          db.select({ id: themes.id, name: themes.name }).from(themes).orderBy(asc(themes.name)),
      },
      input,
    );
  },
});
