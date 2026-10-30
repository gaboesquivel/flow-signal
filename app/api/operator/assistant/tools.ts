import { jsonSchema, tool } from "ai";
import type { JSONValue, ToolSet } from "ai";
import { z } from "zod";

import {
  assistantReadTools,
  PROPOSE_PREFIX,
  SHOW_DATA_MAX_BLOCKS,
  SHOW_DATA_MAX_DATASETS,
  SHOW_DATA_TOOL,
  showDataBlockKinds,
} from "@/app/operator/(console)/_lib/assistant";
import type { ProposeOutput, ShowDataOutput } from "@/app/operator/(console)/_lib/assistant";
import { inputJsonSchema } from "@/lib/signal/adapters/schema";
import type { SignalDb } from "@/lib/signal/db";
import { proposeAction } from "@/lib/signal/domain/assistant-actions";
import { assistantAgentActor } from "@/lib/signal/domain/assistant-action-contract";
import type { ActionContext } from "@/lib/signal/domain/assistant-actions";
import {
  datasetColumns,
  datasetDescriptions,
  datasetQuerySchema,
  runReportDataset,
} from "@/lib/signal/domain/report-datasets";
import type { DatasetName } from "@/lib/signal/domain/report-datasets";
import { blockSchema, reportSpecSchema, validateReportSpec } from "@/lib/signal/domain/report-spec";
import type { ReportData, ReportSpecIssue } from "@/lib/signal/domain/report-spec";
import { describeUnexpectedError, INTERNAL_ERROR_MESSAGE, SignalError } from "@/lib/signal/errors";
import { executeOperation } from "@/lib/signal/operations/execute";
import { operations as registry } from "@/lib/signal/operations/registry";
import type { AnyOperation } from "@/lib/signal/operations/types";

/**
 * The Operator assistant's tools (spec 014 → Assistant routes, decision 0011): reads through
 * `executeOperation` as the assistant agent, `show_data` (a cut-down report spec run on the
 * server, so no model writes a number), and `propose_<operation>` for each write operation with a
 * `preview`, which stores a pending action and changes nothing. No tool here runs a write.
 */

type RunOperation = typeof executeOperation;

export interface AssistantToolDeps extends ActionContext {
  db: SignalDb;
  /** Every tool result, for the traceability check. */
  onResult?: (call: { input: unknown; name: string; output: unknown }) => void;
  /** Tests replace the read runner; the route uses `executeOperation`. */
  run?: RunOperation;
}

/** Operations the model reaches: reads by name, and writes with a preview (proposal only). */
const readOperations = (all: readonly AnyOperation[]) =>
  assistantReadTools.flatMap((name) => {
    const operation = all.find((candidate) => candidate.name === name);
    return operation && operation.effects !== "write" ? [operation] : [];
  });

export const proposableOperationsIn = (all: readonly AnyOperation[]) =>
  all.filter((operation) => operation.effects === "write" && operation.preview);

/** The operation's input minus `idempotencyKey` (confirm uses the action id). */
const proposeInputSchema = (operation: AnyOperation): z.ZodObject =>
  Object.hasOwn(operation.input.shape as Record<string, unknown>, "idempotencyKey")
    ? (operation.input as z.ZodObject).omit({ idempotencyKey: true })
    : operation.input;

const withoutKey = (input: unknown) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const { idempotencyKey: _ignored, ...rest } = input as Record<string, unknown>;
  return rest;
};

const errorOf = (error: unknown, label: string) => {
  if (error instanceof SignalError) return { code: error.code, message: error.message };
  console.error(`[operator-assistant] ${label} failed: ${describeUnexpectedError(error)}`);
  return { code: "internal", message: INTERNAL_ERROR_MESSAGE };
};

/* ---------------------------------------------------------------------------------------------
 * show_data
 * ------------------------------------------------------------------------------------------- */

/** What the model sends: a report spec (spec 013) limited to an inline view. */
export const showDataInputSchema = z.object({
  blocks: z.array(blockSchema).min(1).max(SHOW_DATA_MAX_BLOCKS),
  datasets: z.array(datasetQuerySchema).min(1).max(SHOW_DATA_MAX_DATASETS),
  title: z.string().min(1).max(120),
  version: z.literal(1).default(1),
});

const zodIssues = (error: z.ZodError): ReportSpecIssue[] =>
  error.issues.map((issue) => ({
    block: issue.path[0] === "blocks" && typeof issue.path[1] === "number" ? issue.path[1] : null,
    message: `${issue.path.join(".") || "spec"}: ${issue.message}`,
  }));

/**
 * Checks a `show_data` spec and runs its datasets: `{ issues }` for the model to correct, else
 * `{ spec, data, asOf }` with every dataset's rows as `get_report_dataset` returns them.
 */
export const runShowData = async (
  input: unknown,
  { clock, db }: Pick<AssistantToolDeps, "clock" | "db">,
): Promise<ShowDataOutput> => {
  const parsed = showDataInputSchema.safeParse(input ?? {});
  if (!parsed.success) return { issues: zodIssues(parsed.error) };
  const kindIssues = parsed.data.blocks.flatMap((block, index) =>
    (showDataBlockKinds as readonly string[]).includes(block.kind)
      ? []
      : [
          {
            block: index,
            message: `show_data takes ${showDataBlockKinds.join(", ")} blocks, not ${block.kind}.`,
          },
        ],
  );
  const spec = reportSpecSchema.parse(parsed.data);
  const issues = [...kindIssues, ...validateReportSpec(spec)];
  if (issues.length > 0) return { issues };

  const now = clock.now();
  const data: ReportData = {};
  for (const query of spec.datasets)
    try {
      data[query.id] = await runReportDataset(db, query, now);
    } catch (error) {
      issues.push({
        block: null,
        message: `Dataset "${query.id}": ${errorOf(error, "show_data").message}`,
      });
    }
  if (issues.length > 0) return { issues };
  return { asOf: now.toISOString(), data, spec };
};

/** Rows the model sees per dataset; the UI gets every row. */
const MODEL_SAMPLE_ROWS = 50;

const showDataDescription = [
  "Show numbers as an inline chart, table, or KPI row. Use it whenever an answer has more than 3 values. Input is a report spec: `title`, `datasets` (1–3 queries `{ id, name, params }`, id lowercase snake_case), and `blocks` (1–6 of heading `{ kind, text }`, kpi `{ kind, items: [{ label, dataset, column, aggregate }] }`, chart `{ kind, chart: bar|line|area|scatter|donut, title, dataset, x, y: [columns], seriesBy?, aggregate?, sort?, limit?, horizontal?, stacked? }`, table `{ kind, title, dataset, columns, sort?, limit? }`). The server runs the datasets; you never write the numbers. On `issues`, fix the spec and call again. Money columns are cents. Datasets and their columns:",
  ...(Object.keys(datasetDescriptions) as DatasetName[]).map(
    (name) =>
      `- ${datasetDescriptions[name]} Columns: ${datasetColumns[name].map((column) => column.key).join(", ")}.`,
  ),
].join("\n");

/** What the model reads back from `show_data`: issues, or each dataset's first rows. */
const modelView = (output: ShowDataOutput): JSONValue =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON round trip for a JSONValue
  JSON.parse(
    JSON.stringify(
      "issues" in output
        ? { issues: output.issues }
        : {
            asOf: output.asOf,
            datasets: Object.fromEntries(
              Object.entries(output.data).map(([id, result]) => [
                id,
                {
                  rowCount: result.rows.length,
                  rows: result.rows.slice(0, MODEL_SAMPLE_ROWS),
                  truncated: result.truncated || result.rows.length > MODEL_SAMPLE_ROWS,
                },
              ]),
            ),
            shown: "The PM sees this view inline; summarize it in a sentence or two.",
          },
    ),
  ) as JSONValue;

/* ---------------------------------------------------------------------------------------------
 * The tool set
 * ------------------------------------------------------------------------------------------- */

export const buildAssistantTools = (deps: AssistantToolDeps): ToolSet => {
  const all = deps.operations ?? registry;
  const run = deps.run ?? executeOperation;
  const report = (name: string, input: unknown, output: unknown) => {
    deps.onResult?.({ input, name, output });
    return output;
  };

  const reads = Object.fromEntries(
    readOperations(all).map((operation) => [
      operation.name,
      tool({
        description: operation.description,
        execute: async (input: unknown) => {
          const result = await run(operation, input, assistantAgentActor);
          return report(operation.name, input, result.ok ? result.data : { error: result.error });
        },
        // Advertise the real shape; executeOperation validates and returns the error envelope.
        inputSchema: jsonSchema(inputJsonSchema(operation.input)),
      }),
    ]),
  );

  const proposals = Object.fromEntries(
    proposableOperationsIn(all).map((operation) => [
      `${PROPOSE_PREFIX}${operation.name}`,
      tool({
        description: `Propose ${operation.name} for the PM to confirm on a card. Nothing changes until the PM confirms. Only when the PM asked for this change in this conversation. Pass any text the PM dictated (note, statement, title, reason) word for word; never rewrite, soften, or remove names from it: the card checks it for identifying text and the PM edits it there. Guidance below on writing text for customers applies only to text you draft yourself. What ${operation.name} does: ${operation.description}`,
        execute: async (input: unknown): Promise<ProposeOutput> => {
          let output: ProposeOutput;
          try {
            output = await proposeAction(
              deps.db,
              { input: withoutKey(input), operation: operation.name },
              deps,
            );
          } catch (error) {
            output = { error: errorOf(error, `propose_${operation.name}`) };
          }
          return report(`${PROPOSE_PREFIX}${operation.name}`, input, output) as ProposeOutput;
        },
        inputSchema: jsonSchema(inputJsonSchema(proposeInputSchema(operation))),
      }),
    ]),
  );

  const showData = tool({
    description: showDataDescription,
    execute: async (input: unknown): Promise<ShowDataOutput> =>
      report(SHOW_DATA_TOOL, input, await runShowData(input, deps)) as ShowDataOutput,
    inputSchema: jsonSchema(inputJsonSchema(showDataInputSchema)),
    // The model gets a sample of rows; the UI renders every row.
    toModelOutput: ({ output }: { output: unknown }) => ({
      type: "json" as const,
      value: modelView(output as ShowDataOutput),
    }),
  });

  return { ...reads, ...proposals, [SHOW_DATA_TOOL]: showData };
};
