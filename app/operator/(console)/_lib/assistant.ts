import type { UIMessage } from "ai";

import type { ActionPreview, ActionStatus } from "@/lib/signal/domain/assistant-actions";
import type { ReportData, ReportSpec, ReportSpecIssue } from "@/lib/signal/domain/report-spec";

/**
 * Operator assistant (spec 014) message shapes shared by `POST /api/operator/assistant` and the
 * console chat UI. Browser-safe: type-only imports, plus constant name lists.
 */

/** Read operations the assistant may call (each exists in the registry; missing ones are skipped). */
export const assistantReadTools = [
  "get_demand_summary",
  "list_operator_needs",
  "search_needs",
  "get_need",
  "get_need_detail",
  "get_criteria",
  "get_metrics",
  "list_suggestions",
  "get_report_dataset",
  "list_themes",
  "get_strategy",
  "list_ready_needs",
  "list_reports",
  "get_report",
] as const;
export type AssistantReadTool = (typeof assistantReadTools)[number];

export const SHOW_DATA_TOOL = "show_data";
export const PROPOSE_PREFIX = "propose_";

/** The write operations spec 014 previews; `propose_<name>` exists once the operation has a preview. */
export const proposableOperations = [
  "merge_needs",
  "undo_merge",
  "split_need",
  "resolve_suggestion",
  "set_criteria",
  "set_strategy",
  "publish_decision",
  "save_report",
  "share_report",
] as const;
export type ProposableOperation = (typeof proposableOperations)[number];
export type ProposeToolName = `propose_${ProposableOperation}`;

export const isProposeTool = (name: string): name is ProposeToolName =>
  name.startsWith(PROPOSE_PREFIX);

/** `show_data` limits: a spec 013 report spec cut down to an inline view. */
export const SHOW_DATA_MAX_DATASETS = 3;
export const SHOW_DATA_MAX_BLOCKS = 6;
export const showDataBlockKinds = ["heading", "kpi", "chart", "table"] as const;

/** `show_data` output: render with `ReportView` (`components/report/`), or show the issues. */
export type ShowDataOutput =
  | { asOf: string; data: ReportData; spec: ReportSpec }
  | { issues: ReportSpecIssue[] };

/**
 * A `propose_*` output. While streaming: `{ actionId, operation, preview }` (status implied
 * `proposed`; the card fetches `GET /api/operator/assistant/actions/:id` on mount). In history the
 * server replaces it with the stored action (`status`, `result`, `edited`, `errorCode`), and an
 * unknown id becomes `{ status: "unknown" }`. `{ error }` is a proposal the server refused.
 */
export type ProposeOutput =
  | {
      actionId: string;
      edited?: boolean;
      errorCode?: string | null;
      operation: string;
      preview: ActionPreview;
      result?: unknown;
      status?: ActionStatus;
    }
  | { error: { code: string; message: string } }
  | { status: "unknown" };

/** `data-warnings`: figures in the answer that match no number the tools returned. */
export interface AssistantWarnings {
  figures: string[];
}

// oxlint-disable-next-line typescript/consistent-type-definitions -- UIDataTypes needs an index-compatible type
export type AssistantDataParts = { warnings: AssistantWarnings };

type ReadToolTypes = Record<AssistantReadTool, { input: unknown; output: unknown }>;
type ProposeToolTypes = Record<
  ProposeToolName,
  { input: Record<string, unknown>; output: ProposeOutput }
>;

export type AssistantUITools = ReadToolTypes &
  ProposeToolTypes & { show_data: { input: ReportSpec; output: ShowDataOutput } };

/** The assistant's UI messages: `tool-<name>` parts typed as above, plus `data-warnings`. */
export type AssistantUIMessage = UIMessage<never, AssistantDataParts, AssistantUITools>;
