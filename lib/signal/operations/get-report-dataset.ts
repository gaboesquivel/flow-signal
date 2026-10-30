import { z } from "zod";

import { accountPlans } from "../domain/demand";
import {
  datasetDescriptions,
  datasetNames,
  datasetParamsSchemas,
  datasetResultSchema,
  MAX_DATASET_ROWS,
  runReportDataset,
} from "../domain/report-datasets";
import type { DatasetName } from "../domain/report-datasets";
import { SignalError } from "../errors";
import { defineOperation } from "./types";

/** An ISO date (`2026-10-26`, midnight UTC) or a date-time with an offset. */
const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/** Dataset params, flattened so REST can send them as a GET query. */
const getReportDatasetInput = z.object({
  actor: z.enum(["all", "human", "agent"]).optional(),
  groupBy: z.enum(["none", "theme", "plan", "actor"]).optional(),
  /** `"true"` / `"false"` from a GET query, or a boolean over MCP. */
  includeDecided: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  name: z.enum(datasetNames),
  plan: z.enum(accountPlans).optional(),
  since: instant.optional(),
  /** Comma-separated need statuses (`open,planned`), or a list. */
  status: z.union([z.string().max(200), z.array(z.string().max(40)).max(10)]).optional(),
  themeId: z.uuid().optional(),
  until: instant.optional(),
});
type GetReportDatasetInput = z.infer<typeof getReportDatasetInput>;

/** The named dataset's params from the flattened input; `validation_failed` for a stray one. */
const paramsFor = ({ name, ...flat }: GetReportDatasetInput) => {
  const accepted = Object.keys(datasetParamsSchemas[name].shape);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (value === undefined) continue;
    if (!accepted.includes(key))
      throw new SignalError(
        "validation_failed",
        `\`${key}\` does not apply to dataset ${name}; it takes: ${accepted.join(", ")}.`,
      );
    if (key === "status")
      params.status = (Array.isArray(value) ? value : String(value).split(","))
        .map((status) => status.trim())
        .filter(Boolean);
    else if (key === "includeDecided") params.includeDecided = value === true || value === "true";
    else params[key] = value;
  }
  return params;
};

export const getReportDataset = defineOperation({
  access: "operator",
  description: [
    `Read one report dataset by \`name\`: fixed columns (\`columns\`, each with a type and unit), at most ${MAX_DATASET_ROWS} rows (\`truncated\` is true beyond), from Signal's own records only. Money is in cents; dates are ISO strings; cells may be null. No dataset returns submitter names, emails, or verbatim signal text. Pass the dataset's params as top-level fields; a param that does not apply to the named dataset is rejected. Datasets:`,
    ...(Object.keys(datasetDescriptions) as DatasetName[]).map(
      (name) => `- ${datasetDescriptions[name]}`,
    ),
    "Dates (`since`, `until`) are ISO dates or date-times; `until` is exclusive. `status` is comma-separated (draft, open, planned, in_progress, shipped, declined); `includeDecided` is true or false. Operator only: contains revenue and account names.",
  ].join("\n"),
  errors: [],
  http: { method: "GET", path: "/api/operator/report-datasets/:name" },
  input: getReportDatasetInput,
  name: "get_report_dataset",
  output: datasetResultSchema,
  run(input, { clock, db }) {
    return runReportDataset(db, { name: input.name, params: paramsFor(input) }, clock.now());
  },
});
