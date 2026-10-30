import { z } from "zod";

import type { Reasoner } from "../ai/ports";
import { SignalError } from "../errors";
import {
  datasetColumns,
  datasetDescriptions,
  datasetNames,
  datasetQuerySchema,
} from "./report-datasets";
import type { DatasetQuery, DatasetResult } from "./report-datasets";
import {
  applyBlockData,
  blockSchema,
  computeKpi,
  formatValue,
  kpiColumn,
  MAX_REPORT_BLOCKS,
  MAX_REPORT_DATASETS,
  MAX_TEXT_BLOCK_CHARS,
  reportSpecSchema,
  validateReportSpec,
} from "./report-spec";
import type { Block, ReportData, ReportSpec } from "./report-spec";

/**
 * `generate_report` (spec 013, decision 0010): plan dataset queries from a fixed catalog
 * (`report_plan`), run them on the server, lay out blocks over their columns
 * (`report_compose`), then validate the spec and check that every number in prose traces to
 * the data. One repair round per model step; what still fails is dropped with a warning.
 * Saves nothing.
 */

export interface ReportGenerationDeps {
  now: Date;
  reasoner: Reasoner;
  /** Runs one validated dataset query (`runReportDataset` in production). */
  runDataset: (query: DatasetQuery) => Promise<DatasetResult>;
  themes: () => Promise<{ id: string; name: string }[]>;
}

export interface GenerateReportInput {
  prior?: ReportSpec;
  prompt: string;
}

export interface GeneratedReport {
  asOf: string;
  data: ReportData;
  report: ReportSpec;
  warnings: string[];
}

/** Sample rows per dataset the compose prompt sees. */
export const COMPOSE_SAMPLE_ROWS = 20;

// ---------------------------------------------------------------------------------------------
// Traceability: numbers in prose must come from the data.
// ---------------------------------------------------------------------------------------------

export interface TextNumber {
  /** The token as written, e.g. `$1.2M`, `45%`. */
  raw: string;
  /** How far off a value may be and still display as `raw` (half the last shown digit). */
  tolerance: number;
  /** Magnitude after stripping `$`, `%`, commas, and applying a k/M/B suffix. */
  value: number;
}

const multipliers: Record<string, number> = { b: 1e9, k: 1e3, m: 1e6 };
const months =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const listMarker = /^[ \t]*(?:[-*+][ \t]+)?\d{1,3}[.)](?=\s)/gmu;
const isoDate = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/gu;
const monthDay = new RegExp(`\\b(?:${months})\\.?\\s+\\d{1,2}\\b`, "giu");
const dayMonth = new RegExp(`\\b\\d{1,2}\\s+(?:${months})\\b`, "giu");
const numberToken =
  /(?<![\w.,$])(?<dollar>\$)?[-−]?(?<whole>\d{1,3}(?:,\d{3})+|\d+)(?<fraction>\.\d+)?(?<suffix>[kKmMbB])?(?<percent>%)?(?!\w|[.,]\d)/gu;

/**
 * The figures a sentence cites. Years (1900–2100 written plainly), ISO and month-name dates,
 * markdown list markers, ordinals ("2nd"), and digits inside words ("Q3", "H1") are not figures.
 */
export const extractTextNumbers = (text: string): TextNumber[] => {
  const cleaned = text
    .replaceAll(listMarker, " ")
    .replaceAll(isoDate, " ")
    .replaceAll(monthDay, " ")
    .replaceAll(dayMonth, " ");
  const found: TextNumber[] = [];
  for (const match of cleaned.matchAll(numberToken)) {
    const [raw] = match;
    const { dollar, fraction = "", percent, suffix, whole = "" } = match.groups ?? {};
    const plain = !dollar && !percent && !suffix && !fraction && !whole.includes(",");
    const base = Number(`${whole.replaceAll(",", "")}${fraction}`);
    if (plain && whole.length === 4 && base >= 1900 && base <= 2100) continue;
    const multiplier = suffix ? (multipliers[suffix.toLowerCase()] ?? 1) : 1;
    const decimals = Math.max(0, fraction.length - 1);
    found.push({
      raw,
      tolerance: 0.5 * 10 ** -decimals * multiplier,
      value: base * multiplier,
    });
  }
  return found;
};

/** The tokens in `text` that match no allowed value within their display rounding. */
export const findUntraceableNumbers = (text: string, allowed: Iterable<number>): string[] => {
  const magnitudes = [...new Set([...allowed].map((value) => Math.abs(value)))];
  return extractTextNumbers(text)
    .filter(
      ({ tolerance, value }) =>
        !magnitudes.some(
          (candidate) =>
            Math.abs(candidate - value) <= tolerance + 1e-9 * Math.max(1, Math.abs(value)),
        ),
    )
    .map(({ raw }) => raw);
};

type Unit = DatasetResult["columns"][number]["unit"];

/** A number plus the scale it is usually written in (dollars for cents, 45 for 0.45). */
const withUnit = (value: number, unit: Unit) => {
  if (unit === "cents") return [value, value / 100];
  if (unit === "percent") return [value, value * 100];
  return [value];
};

/**
 * Every number a text block may cite: the data's numeric cells (cents also as dollars,
 * ratios also as percents) and numbers inside string cells; row counts and distinct counts of
 * string columns; what each chart or table block plots (pivoted sums) and how many rows it
 * shows; each KPI the spec computes, raw and as `formatValue` displays it; block limits; and
 * numbers the requester wrote in the prompt ("top 10", "last 12 weeks").
 */
export const traceableValues = (spec: ReportSpec, data: ReportData, prompt = ""): number[] => {
  const values = new Set<number>();
  const add = (value: number | null | undefined, unit?: Unit) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    for (const scaled of withUnit(value, unit)) values.add(scaled);
  };
  const addText = (text: string) => {
    for (const { value } of extractTextNumbers(text)) values.add(value);
  };
  addDataValues(data, add, addText);
  for (const block of spec.blocks) addBlockValues(block, data, add, addText);
  addText(prompt);
  return [...values];
};

type AddValue = (value: number | null | undefined, unit?: Unit) => void;
type AddText = (text: string) => void;

const addDataValues = (data: ReportData, add: AddValue, addText: AddText) => {
  for (const result of Object.values(data)) {
    add(result.rows.length);
    for (const column of result.columns) {
      const distinct = new Set<string | number | null | undefined>();
      for (const row of result.rows) {
        const cell = row[column.key];
        distinct.add(cell);
        if (typeof cell === "number") add(cell, column.unit);
        else if (typeof cell === "string" && column.type === "string") addText(cell);
      }
      if (column.type === "string") add(distinct.size);
    }
  }
};

const addBlockValues = (block: Block, data: ReportData, add: AddValue, addText: AddText) => {
  if (block.kind === "kpi")
    for (const item of block.items) {
      const result = data[item.dataset];
      if (!result) continue;
      const value = computeKpi(item, result);
      const column = kpiColumn(item, result);
      add(value, column?.unit);
      addText(formatValue(value, column));
    }
  if (block.kind === "chart" || block.kind === "table") {
    if (block.limit) add(block.limit);
    const result = data[block.dataset];
    if (!result) return;
    const shown = applyBlockData(block, result);
    add(shown.rows.length);
    if (block.kind === "chart") {
      const unit = result.columns.find((column) => column.key === block.y[0])?.unit;
      for (const row of shown.rows)
        for (const { key } of shown.series) {
          const cell = row[key];
          if (typeof cell === "number") add(cell, unit);
        }
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Model-facing schemas: loose on purpose, so one bad query or block is repaired or dropped
// instead of failing the whole call. Every value is re-validated with the contract schemas.
// ---------------------------------------------------------------------------------------------

const optionalText = z.string().nullish();

const planParamsSchema = z.object({
  actor: optionalText.describe("metrics_weekly: all | human | agent"),
  groupBy: optionalText.describe("signals_weekly: none | theme | plan | actor"),
  includeDecided: z.boolean().nullish().describe("needs: include decided needs (default true)"),
  plan: optionalText.describe("needs, accounts: an account plan"),
  since: optionalText.describe("signals_weekly, decisions, metrics_weekly: ISO date"),
  status: z.array(z.string()).nullish().describe("needs: need statuses"),
  themeId: optionalText.describe("needs, decisions: a theme id from the theme list"),
  until: optionalText.describe("signals_weekly, decisions, metrics_weekly: ISO date"),
});

export const reportPlanOutputSchema = z.object({
  datasets: z.array(
    z.object({
      id: z.string().describe('Short id blocks reference: "d1", "d2", …'),
      name: z.string().describe(`One of: ${datasetNames.join(", ")}`),
      params: planParamsSchema.nullish(),
    }),
  ),
  gaps: z
    .array(z.string())
    .describe("Parts of the request no dataset can answer, as short noun phrases"),
});
export type ReportPlanOutput = z.infer<typeof reportPlanOutputSchema>;

/**
 * Each block is its kind plus its other fields as a JSON string. Constrained decoding against a
 * wide object of optional fields took 45–120 s+ per call; this shape decodes in seconds, and
 * the fields are parsed and validated afterwards (bad JSON goes to the repair round).
 */
const composeBlockSchema = z.object({
  json: z
    .string()
    .describe('The block\'s other fields as a JSON object, e.g. {"text":"Demand by theme"}'),
  kind: z.enum(["heading", "text", "kpi", "chart", "table"]),
});

export const reportComposeOutputSchema = z.object({
  blocks: z.array(composeBlockSchema),
  title: z.string(),
});
export type ReportComposeOutput = z.infer<typeof reportComposeOutputSchema>;

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

const json = (value: unknown) => JSON.stringify(value, null, 2);

const PLAN_SYSTEM = `You plan data for a product manager's report in Signal, a feedback and demand tool.
Pick dataset queries from the catalog below; the server runs them. You never write numbers or SQL.

Rules:
- Use only catalog datasets and their documented params. Never invent a dataset, param, or column.
- Use 1–${MAX_REPORT_DATASETS} queries, each with a short unique id ("d1", "d2", …). One query per distinct question; reuse a query when two blocks can share it.
- Filter with params instead of asking for everything (plan, themeId from the theme list, status, since/until as ISO dates, groupBy for weekly series). Omit a param to use its default.
- If part of the request has no dataset (NPS, revenue by region, churn, anything not in the catalog), list it in "gaps" as a short noun phrase and plan only what the catalog covers. Do not approximate a missing measure with an unrelated one.
- When a prior report is given, this is a refinement: keep its queries (same ids and params) unless the request changes them, and add or adjust only what the request asks for.`;

const COMPOSE_SYSTEM = `You lay out a product manager's report in Signal from datasets the server already ran.
You write a title and blocks that reference dataset ids and column keys; the app computes and draws every figure from the rows.

Return each block as { kind, json }: json is a JSON object (as a string) of the block's other fields.

Block kinds:
- heading: { kind: "heading", text }
- text: { kind: "text", markdown } — at most ${MAX_TEXT_BLOCK_CHARS} characters
- kpi: { kind: "kpi", items: [{ label, dataset, column, aggregate: sum | count | avg | median | min | max | latest }] } — 1–4 items
- chart: { kind: "chart", chart: bar | line | area | scatter | donut, title, caption?, dataset, x, y: [numeric column keys], seriesBy? (string column, needs exactly one y), aggregate? (sum | avg | count | min | max: how rows sharing an x combine; default sum, e.g. x theme over needs sums ARR per theme; use avg for scores and rates), stacked?, horizontal?, sort? { column, direction: asc | desc }, limit? (1–100) }
- table: { kind: "table", title, dataset, columns: [column keys], sort?, limit? (1–100) }

Rules:
- Never write a number in text that is not in the sample rows, a KPI you define, or the request itself. Prefer describing what a chart shows in words ("Reporting leads") over quoting figures; if you quote one, copy it as the data shows it (money is in cents: 48000000 cents is $480,000 or $480K; percent columns are ratios: 0.45 is 45%). Write no totals, averages, or differences you computed yourself; add a KPI instead.
- Use only the dataset ids and column keys listed. Never invent a dataset or column. y, scatter x, and KPI columns (except count) must be numeric; a donut has exactly one y.
- One clear chart per question. Bar for comparing categories (horizontal for long labels such as need statements), line or area for weekly series (seriesBy for one line per group, stacked for parts of a whole), scatter for two numeric measures, donut only for a few parts of one whole.
- KPIs only for headline figures. No chart that just repeats a single number: if the answer is one number, use a KPI.
- Tables for ranked lists ("top 10 needs"): sort by the ranking column, desc, and set limit.
- Text is short and plain: one or two sentences that say what to look at. No marketing tone, no filler, no heading inside text.
- Lead with what was asked. Keep the report short: a heading, the KPIs, then charts and tables; at most ${MAX_REPORT_BLOCKS} blocks.
- When a prior report is given, this is a refinement: start from its blocks, keep the ones the request does not affect unchanged and in order, and change or add only what was asked.
- If some of the request is not covered by any dataset, do not fill the gap; the app shows a warning.
- Return null or omit fields a block kind does not use.`;

interface Theme {
  id: string;
  name: string;
}

const catalog = () =>
  datasetNames.map((name) => ({
    columns: datasetColumns[name].map(({ key, type, unit }) =>
      unit ? `${key} (${type}, ${unit})` : `${key} (${type})`,
    ),
    description: datasetDescriptions[name],
    name,
  }));

const planPrompt = (input: GenerateReportInput, themes: Theme[], now: Date) =>
  [
    `Today: ${now.toISOString().slice(0, 10)}`,
    `Request:\n${input.prompt}`,
    input.prior ? `Prior report (refine it):\n${json(input.prior)}` : "Prior report: none",
    `Dataset catalog:\n${json(catalog())}`,
    `Themes (use the id as themeId):\n${json(themes)}`,
  ].join("\n\n");

const planRepairPrompt = (base: string, previous: ReportPlanOutput, issues: string[]) =>
  [
    base,
    `Your previous plan:\n${json(previous)}`,
    `It has problems; return a corrected full plan:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
  ].join("\n\n");

const datasetBrief = (queries: DatasetQuery[], data: ReportData) =>
  queries.map((query) => {
    const result = data[query.id];
    return {
      columns: result?.columns ?? datasetColumns[query.name],
      id: query.id,
      name: query.name,
      params: query.params,
      rowCount: result?.rows.length ?? 0,
      sampleRows: result?.rows.slice(0, COMPOSE_SAMPLE_ROWS) ?? [],
      truncated: result?.truncated ?? false,
    };
  });

const composePrompt = (
  input: GenerateReportInput,
  queries: DatasetQuery[],
  data: ReportData,
  gaps: string[],
) =>
  [
    `Request:\n${input.prompt}`,
    input.prior ? `Prior report (refine it):\n${json(input.prior)}` : "Prior report: none",
    `Datasets (sample rows only; the app reads every row):\n${json(datasetBrief(queries, data))}`,
    gaps.length ? `Not covered by any dataset (do not fill): ${gaps.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

const composeRepairPrompt = (base: string, previous: ReportComposeOutput, issues: string[]) =>
  [
    base,
    `Your previous report:\n${json(previous)}`,
    `These blocks have problems. Return the full corrected report; fix or remove each listed block and keep the others:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
  ].join("\n\n");

// ---------------------------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------------------------

const withoutNulls = (value: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== null && entry !== undefined),
  );

interface CheckedPlan {
  issues: string[];
  queries: DatasetQuery[];
}

const zodIssues = (error: z.ZodError) =>
  error.issues
    .map((issue) => issue.message.replace(/^Invalid params for dataset \w+: /u, ""))
    .join("; ");

const checkPlan = (plan: ReportPlanOutput): CheckedPlan => {
  const issues: string[] = [];
  const queries: DatasetQuery[] = [];
  const ids = new Set<string>();
  for (const raw of plan.datasets) {
    const label = `Query ${raw.id || "(no id)"} (${raw.name})`;
    if (queries.length >= MAX_REPORT_DATASETS) {
      issues.push(`${label}: at most ${MAX_REPORT_DATASETS} queries.`);
      continue;
    }
    if (!(datasetNames as readonly string[]).includes(raw.name)) {
      issues.push(
        `${label}: unknown dataset "${raw.name}"; use one of ${datasetNames.join(", ")}.`,
      );
      continue;
    }
    const parsed = datasetQuerySchema.safeParse({
      id: raw.id,
      name: raw.name,
      params: withoutNulls(raw.params),
    });
    if (!parsed.success) {
      issues.push(`${label}: ${zodIssues(parsed.error)}`);
      continue;
    }
    if (ids.has(parsed.data.id)) {
      issues.push(`${label}: duplicate id ${parsed.data.id}.`);
      continue;
    }
    ids.add(parsed.data.id);
    queries.push(parsed.data);
  }
  if (plan.datasets.length === 0) issues.push("The plan has no dataset queries.");
  return { issues, queries };
};

const sentence = (text: string) => {
  const trimmed = text.trim().replace(/[.\s]+$/u, "");
  return trimmed ? `${trimmed}.` : "";
};

const gapWarnings = (gaps: string[]) =>
  gaps
    .map(sentence)
    .filter(Boolean)
    .map((gap) => `No dataset covers ${gap}`);

// ---------------------------------------------------------------------------------------------
// Compose validation
// ---------------------------------------------------------------------------------------------

const blockKeys: Record<Block["kind"], string[]> = {
  chart: [
    "aggregate",
    "caption",
    "chart",
    "dataset",
    "horizontal",
    "limit",
    "seriesBy",
    "sort",
    "stacked",
    "title",
    "x",
    "y",
  ],
  heading: ["text"],
  kpi: ["items"],
  table: ["columns", "dataset", "limit", "sort", "title"],
  text: ["markdown"],
};

type RawBlock = ReportComposeOutput["blocks"][number];

const blockFields = (raw: RawBlock): Record<string, unknown> | null => {
  try {
    const fields: unknown = JSON.parse(raw.json);
    return fields && typeof fields === "object" && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const normalizeBlock = (raw: RawBlock, fields: Record<string, unknown>) => {
  const present = withoutNulls({ ...fields, kind: raw.kind });
  if (raw.kind === "text" && present.markdown === undefined && present.text !== undefined)
    present.markdown = present.text;
  return Object.fromEntries(
    Object.entries(present).filter(([key]) => key === "kind" || blockKeys[raw.kind].includes(key)),
  );
};

interface BlockIssue {
  index: number;
  kind: string;
  message: string;
}

interface CheckedCompose {
  blocks: { block: Block; index: number }[];
  issues: BlockIssue[];
  title: string;
}

const specOf = (title: string, datasets: DatasetQuery[], blocks: Block[]): ReportSpec => ({
  blocks,
  datasets,
  title,
  version: 1,
});

const checkCompose = (
  output: ReportComposeOutput,
  queries: DatasetQuery[],
  data: ReportData,
  prompt: string,
): CheckedCompose => {
  const issues: BlockIssue[] = [];
  const title = output.title.trim().slice(0, 120) || "Report";
  let parsed: { block: Block; index: number }[] = [];

  for (const [index, raw] of output.blocks.entries()) {
    if (index >= MAX_REPORT_BLOCKS) {
      issues.push({ index, kind: raw.kind, message: `at most ${MAX_REPORT_BLOCKS} blocks` });
      continue;
    }
    const fields = blockFields(raw);
    if (!fields) {
      issues.push({ index, kind: raw.kind, message: "json must be one JSON object" });
      continue;
    }
    const result = blockSchema.safeParse(normalizeBlock(raw, fields));
    if (result.success) parsed.push({ block: result.data, index });
    else
      issues.push({
        index,
        kind: raw.kind,
        message: result.error.issues
          .map((issue) => `${issue.path.join(".") || raw.kind} ${issue.message}`)
          .join("; "),
      });
  }

  const refIssues = validateReportSpec(
    specOf(
      title,
      queries,
      parsed.map(({ block }) => block),
    ),
  );
  const badRefs = new Set<number>();
  for (const issue of refIssues) {
    if (issue.block === null) continue;
    const entry = parsed[issue.block];
    if (!entry) continue;
    badRefs.add(issue.block);
    issues.push({ index: entry.index, kind: entry.block.kind, message: issue.message });
  }
  parsed = parsed.filter((_, position) => !badRefs.has(position));

  const allowed = traceableValues(
    specOf(
      title,
      queries,
      parsed.map(({ block }) => block),
    ),
    data,
    prompt,
  );
  const traced = parsed.filter(({ block, index }) => {
    if (block.kind !== "text") return true;
    const untraceable = findUntraceableNumbers(block.markdown, allowed);
    if (untraceable.length === 0) return true;
    issues.push({
      index,
      kind: "text",
      message: `cites ${untraceable.map((raw) => `"${raw}"`).join(", ")}, which ${untraceable.length === 1 ? "does" : "do"} not appear in the data`,
    });
    return false;
  });

  return { blocks: traced, issues: issues.toSorted((a, b) => a.index - b.index), title };
};

const describeIssue = ({ index, kind, message }: BlockIssue) =>
  `Block ${index + 1} (${kind}): ${message}.`;

// ---------------------------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------------------------

export const generateReport = async (
  deps: ReportGenerationDeps,
  input: GenerateReportInput,
): Promise<GeneratedReport> => {
  const warnings: string[] = [];
  const themes = await deps.themes();

  // 1. Plan, with one repair round for invalid queries.
  const planBase = planPrompt(input, themes, deps.now);
  const plan = async (prompt: string) => {
    const { value } = await deps.reasoner.generate({
      prompt,
      schema: reportPlanOutputSchema,
      system: PLAN_SYSTEM,
      task: "report_plan",
    });
    return value;
  };
  let planned = await plan(planBase);
  let checked = checkPlan(planned);
  if (checked.issues.length > 0) {
    planned = await plan(planRepairPrompt(planBase, planned, checked.issues));
    checked = checkPlan(planned);
    for (const issue of checked.issues) warnings.push(`Skipped a dataset query. ${issue}`);
  }
  const gaps = gapWarnings(planned.gaps);
  if (checked.queries.length === 0)
    throw new SignalError(
      "validation_failed",
      ["No dataset query in the plan is valid.", ...checked.issues, ...gaps].join(" "),
    );
  warnings.unshift(...gaps);
  const { queries } = checked;

  // 2. Run the queries on the server.
  const data: ReportData = Object.fromEntries(
    await Promise.all(
      queries.map(async (query) => [query.id, await deps.runDataset(query)] as const),
    ),
  );

  // 3. Compose, validate, and trace; one repair round, then drop what still fails.
  const composeBase = composePrompt(input, queries, data, planned.gaps);
  const compose = async (prompt: string) => {
    const { value } = await deps.reasoner.generate({
      prompt,
      schema: reportComposeOutputSchema,
      system: COMPOSE_SYSTEM,
      task: "report_compose",
    });
    return value;
  };
  let composed = await compose(composeBase);
  let layout = checkCompose(composed, queries, data, input.prompt);
  if (layout.issues.length > 0) {
    composed = await compose(
      composeRepairPrompt(composeBase, composed, layout.issues.map(describeIssue)),
    );
    layout = checkCompose(composed, queries, data, input.prompt);
    for (const issue of layout.issues)
      warnings.push(`Dropped a ${issue.kind} block: ${issue.message}.`);
  }
  if (layout.blocks.length === 0)
    throw new SignalError(
      "validation_failed",
      ["The report has no valid blocks.", ...layout.issues.map(describeIssue)].join(" "),
    );

  const report = reportSpecSchema.parse(
    specOf(
      layout.title,
      queries,
      layout.blocks.map(({ block }) => block),
    ),
  );
  return { asOf: deps.now.toISOString(), data, report, warnings };
};
