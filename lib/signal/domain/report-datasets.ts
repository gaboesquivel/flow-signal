import { z } from "zod";

import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { accountPlans } from "./demand";

/**
 * The report dataset catalog (spec 013, decision 0010): the only data a report can show. Each
 * dataset is one read-only SQL query with typed params and fixed columns; no dataset returns
 * submitter names, emails, or verbatim signal text. Money is in cents.
 */

export const datasetNames = [
  "needs",
  "signals_weekly",
  "accounts",
  "decisions",
  "metrics_weekly",
] as const;
export type DatasetName = (typeof datasetNames)[number];

/** Rows returned per dataset at most; beyond it `truncated` is true. */
export const MAX_DATASET_ROWS = 500;

const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const liveNeedStatuses = [
  "draft",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
] as const;

export const datasetParamsSchemas = {
  accounts: z.object({ plan: z.enum(accountPlans).optional() }).strict(),
  decisions: z
    .object({
      since: instant.optional(),
      themeId: z.uuid().optional(),
      until: instant.optional(),
    })
    .strict(),
  metrics_weekly: z
    .object({
      actor: z.enum(["all", "human", "agent"]).default("all"),
      since: instant.optional(),
      until: instant.optional(),
    })
    .strict(),
  needs: z
    .object({
      includeDecided: z.boolean().default(true),
      plan: z.enum(accountPlans).optional(),
      status: z.array(z.enum(liveNeedStatuses)).min(1).optional(),
      themeId: z.uuid().optional(),
    })
    .strict(),
  signals_weekly: z
    .object({
      groupBy: z.enum(["none", "theme", "plan", "actor"]).default("none"),
      since: instant.optional(),
      until: instant.optional(),
    })
    .strict(),
} as const satisfies Record<DatasetName, z.ZodObject>;

export type DatasetParams<N extends DatasetName = DatasetName> = z.input<
  (typeof datasetParamsSchemas)[N]
>;

export const columnDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "date"]),
  unit: z.enum(["cents", "count", "days", "percent", "score"]).optional(),
});
export type ColumnDef = z.infer<typeof columnDefSchema>;

const col = (
  key: string,
  label: string,
  type: ColumnDef["type"],
  unit?: ColumnDef["unit"],
): ColumnDef => (unit ? { key, label, type, unit } : { key, label, type });

/** Fixed columns per dataset; `validateReportSpec` checks block references against these. */
export const datasetColumns: Record<DatasetName, ColumnDef[]> = {
  accounts: [
    col("accountId", "Account id", "string"),
    col("account", "Account", "string"),
    col("plan", "Plan", "string"),
    col("arrCents", "ARR", "number", "cents"),
    col("openDealCents", "Open deals", "number", "cents"),
    col("needsSupported", "Needs supported", "number", "count"),
    col("signals", "Signals", "number", "count"),
    col("lastSignalAt", "Last signal", "date"),
  ],
  decisions: [
    col("needId", "Need id", "string"),
    col("statement", "Need", "string"),
    col("theme", "Theme", "string"),
    col("status", "Decision", "string"),
    col("publishedAt", "Published", "date"),
    col("latencyDays", "Days to decide", "number", "days"),
    col("recommendedStatus", "Recommended", "string"),
  ],
  metrics_weekly: [
    col("weekStart", "Week", "date"),
    col("preventionRate", "Prevention rate", "number", "percent"),
    col("signals", "Signals", "number", "count"),
    col("attachedExisting", "Attached to existing", "number", "count"),
    col("mergedLater", "Merged later", "number", "count"),
  ],
  needs: [
    col("needId", "Need id", "string"),
    col("statement", "Need", "string"),
    col("theme", "Theme", "string"),
    col("status", "Status", "string"),
    col("people", "People", "number", "count"),
    col("accounts", "Accounts", "number", "count"),
    col("arrCents", "ARR", "number", "cents"),
    col("openDealCents", "Open deals", "number", "cents"),
    col("score", "Priority score", "number", "score"),
    col("trend", "Trend", "string"),
    col("createdAt", "Created", "date"),
    col("readyAt", "Ready", "date"),
    col("decidedAt", "Decided", "date"),
  ],
  signals_weekly: [
    col("weekStart", "Week", "date"),
    col("group", "Group", "string"),
    col("signals", "Signals", "number", "count"),
    col("attachedExisting", "Attached to existing", "number", "count"),
    col("attachedDraft", "New needs", "number", "count"),
  ],
};

/** One line per dataset for model prompts and the `get_report_dataset` description. */
export const datasetDescriptions: Record<DatasetName, string> = {
  accounts:
    "accounts: one row per customer account with plan, ARR, open deals, how many live needs it supports, its signal count, and its last signal. Params: plan?.",
  decisions:
    "decisions: one row per published decision (newest first) with the need, theme, status, days from the need's first signal to the decision, and the brief's recommended status. Params: since? (default 180 days ago), until?, themeId?.",
  metrics_weekly:
    "metrics_weekly: the get_metrics weekly series: prevention rate (0–1), signals, attached to existing, and drafts merged later, per week. Params: since? (default 12 weeks ago), until?, actor (all | human | agent).",
  needs:
    "needs: one row per live need (merged-away excluded) with theme, status, people, requesting accounts, their ARR and open deals, priority score (0–5), trend (rising | steady | falling), and created/ready/decided dates. Params: themeId?, plan? (needs some account on that plan supports), status?[], includeDecided (default true).",
  signals_weekly:
    "signals_weekly: signals per week (weekStart, Monday UTC) split by group (theme name, account plan, or human/agent; 'All' when groupBy is none), with how many attached to an existing need vs. created a new draft. Params: since? (default 12 weeks ago), until?, groupBy (none | theme | plan | actor).",
};

export const datasetQuerySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/u),
    name: z.enum(datasetNames),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((query, context) => {
    const parsed = datasetParamsSchemas[query.name].safeParse(query.params);
    if (!parsed.success)
      context.addIssue({
        code: "custom",
        message: `Invalid params for dataset ${query.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"} ${issue.message}`).join("; ")}`,
        path: ["params"],
      });
  });
export type DatasetQuery = z.infer<typeof datasetQuerySchema>;

export const datasetCellSchema = z.union([z.string(), z.number(), z.null()]);
export const datasetResultSchema = z.object({
  columns: z.array(columnDefSchema),
  rows: z.array(z.record(z.string(), datasetCellSchema)),
  truncated: z.boolean(),
});
export type DatasetResult = z.infer<typeof datasetResultSchema>;

/** Runs one dataset query (task 02 builds the SQL). Params are validated here. */
export const runReportDataset = (
  _db: SignalQueryable,
  query: Pick<DatasetQuery, "name" | "params">,
  _now: Date,
): Promise<DatasetResult> => {
  datasetParamsSchemas[query.name].parse(query.params);
  return Promise.reject(new SignalError("internal", "Report datasets are not built yet."));
};

export type RunReportDataset = typeof runReportDataset;
