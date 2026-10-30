import { answerSuggestedMatch } from "./answer-suggested-match";
import { checkPublicText } from "./check-public-text";
import { draftDecisionBrief } from "./draft-decision-brief";
import { getCriteria } from "./get-criteria";
import { getDemandSummary } from "./get-demand-summary";
import { getMetrics } from "./get-metrics";
import { generateReport } from "./generate-report";
import { getMySignals } from "./get-my-signals";
import { getNeed } from "./get-need";
import { getNeedDetail } from "./get-need-detail";
import { getReport } from "./get-report";
import { getReportDataset } from "./get-report-dataset";
import { getSharedReport } from "./get-shared-report";
import { listOperatorNeeds } from "./list-operator-needs";
import { listReports } from "./list-reports";
import { getStrategy } from "./get-strategy";
import { listReadyNeeds } from "./list-ready-needs";
import { listThemes } from "./list-themes";
import { listSuggestions } from "./list-suggestions";
import { mergeNeeds } from "./merge-needs";
import { previewSignal } from "./preview-signal";
import { publishDecision } from "./publish-decision";
import { resolveSuggestion } from "./resolve-suggestion";
import { saveReport } from "./save-report";
import { searchNeeds } from "./search-needs";
import { setCriteria } from "./set-criteria";
import { setStrategy } from "./set-strategy";
import { shareReport } from "./share-report";
import { splitNeed } from "./split-need";
import { submitSignal } from "./submit-signal";
import { sweepDuplicates } from "./sweep-duplicates";
import { undoMerge } from "./undo-merge";
import { isPlanned } from "./types";
import type { AnyOperation, PlannedOperation } from "./types";

/**
 * Every spec 001 operation, in the spec's table order, then later specs' additions (006: the
 * PM console's operator reads; 007: decision direction; 013: PM reports; 009: duplicate backstop). Built operations are exposed on REST,
 * MCP, and Eve; planned ones hold their slot until their task replaces the file. Adding an
 * operation outside spec 001: one import and one entry here, plus its file.
 */
export const allOperations: readonly (AnyOperation | PlannedOperation)[] = [
  searchNeeds,
  getNeed,
  previewSignal,
  submitSignal,
  getMySignals,
  listSuggestions,
  resolveSuggestion,
  mergeNeeds,
  undoMerge,
  splitNeed,
  getNeedDetail,
  getCriteria,
  setCriteria,
  getDemandSummary,
  draftDecisionBrief,
  publishDecision,
  getMetrics,
  // Spec 006 (lean Ledger UI).
  listOperatorNeeds,
  checkPublicText,
  // Spec 007 (decision direction).
  getStrategy,
  setStrategy,
  listReadyNeeds,
  // Spec 007 follow-up: theme choices for the strategy form.
  listThemes,
  // Spec 013 (PM reports).
  getReportDataset,
  generateReport,
  saveReport,
  listReports,
  getReport,
  shareReport,
  getSharedReport,
  // Spec 009 (post-submission duplicate backstop).
  answerSuggestedMatch,
  sweepDuplicates,
];

export const operations: readonly AnyOperation[] = allOperations.filter(
  (operation): operation is AnyOperation => !isPlanned(operation),
);

export const publicOperations = operations.filter((operation) => operation.access === "public");

export const findOperation = (name: string) =>
  operations.find((operation) => operation.name === name);
