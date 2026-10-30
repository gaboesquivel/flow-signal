import type { WorldName } from "./format";
import type { ArmScore, Comparison, Criterion } from "./score";
import type { Interval } from "./score/bootstrap";
import type { PolicyParams } from "./sim";
import type { Surface } from "./sim/surfaces";
import type { CostSummary } from "../matching/cost";

/**
 * The `pnpm eval:crewday` report (spec 004 → Metrics reported, Success criteria, Acceptance
 * scenario steps 2, 4, 5): one JSON object, and a terminal table rendered from its `table` rows in
 * the spec's order: keyword-findable share; headline business outcomes; PRODUCT.md metrics
 * (prevention by quarter); diagnostics; guardrails. Each row has both arms' point estimate and 95%
 * interval and, where a success criterion applies, its verdict. Then what is not measured and the
 * planted-PII result.
 */

export type ArmName = "signal" | "board";
export type Verdict = "PASS" | "FAIL" | "n.a.";
export type Section = "world" | "headline" | "product" | "diagnostics" | "guardrails";
export type ValueFormat = "pct" | "num" | "usd" | "days" | "ms" | "count" | "grade";

export interface Cell {
  ci: Interval | null;
  value: number | null;
}

export interface ReportRow {
  /** The success criterion this row is judged by (`compareArms`' criterion name), if any. */
  criterion: {
    bar: string;
    detail: string;
    /** Signal − board (or ÷), with its paired interval, when the criterion compares the arms. */
    lift: Cell | null;
    name: string;
    verdict: Verdict;
  } | null;
  board: Cell | null;
  format: ValueFormat;
  key: string;
  label: string;
  /** Signal − board with its paired interval, for a row compared without a success criterion. */
  lift?: Cell | null;
  note?: string;
  section: Section;
  signal: Cell | null;
}

export interface ArmRunInfo {
  aiCalls: ArmScore["aiCalls"];
  /** Signal's own model spend in this arm (the guardrail's numerator); null offline. */
  spend: CostSummary | null;
  surfaceMix: Record<Surface, number>;
  wallTimeMs: number;
  weeks: number;
}

export interface CrewdayReport {
  arms: ArmName[];
  comparison: Omit<Comparison, "board" | "signal"> | null;
  gitSha: { dirty: boolean; sha: string | null };
  /** Smoke runs only: replay truncated to this many weeks. Never a result. */
  limitWeeks: number | null;
  /** Live Gateway ports, or fakes (offline smoke; not a result). */
  mode: "live" | "offline";
  models: {
    embedding: string;
    fast: string;
    oracleEmbedding: string;
    reasoning: string;
  };
  notMeasured: { metric: string; reason: string }[];
  pii: {
    leaks: { arm: ArmName; needId: string; pii: string; worldSignalId: string }[];
    ok: boolean | null;
    planted: { pii: string[]; worldSignalId: string }[];
    summariesChecked: Partial<Record<ArmName, number>>;
  };
  policy: PolicyParams;
  ranAt: string;
  runs: Partial<Record<ArmName, ArmRunInfo>>;
  schema: "crewday-report@1";
  scores: Partial<Record<ArmName, ArmScore>>;
  seed: number;
  spend: {
    /** Eval overhead (the PM oracle's embeddings), not Signal's spend. */
    oracleUsd: number | null;
    totalUsd: number | null;
    unpricedCalls: number;
  };
  table: ReportRow[];
  wallTimeMs: number;
  world: {
    keywordFindableShare: { source: "manifest" | "runner estimate" | null; value: number | null };
    name: WorldName;
    signals: number;
    version: string;
  };
}

const cellOf = (value: { ci: Interval | null; value: number | null } | null | undefined) =>
  value ? { ci: value.ci, value: value.value } : null;
const point = (value: number | null | undefined): Cell | null =>
  value === undefined ? null : { ci: null, value };

const verdictOf = (criterion: Criterion | undefined): Verdict => {
  if (!criterion || criterion.pass === null) return "n.a.";
  return criterion.pass ? "PASS" : "FAIL";
};

interface RowSpec {
  board?: (score: ArmScore) => Cell | null;
  criterion?: string;
  format: ValueFormat;
  key: string;
  label: string;
  lift?: (comparison: Comparison) => Cell | null;
  note?: string;
  section: Section;
  signal?: (score: ArmScore) => Cell | null;
  /** Same cell for both arms (default for `signal` and `board`). */
  value?: (score: ArmScore) => Cell | null;
}

const quarter = (label: string) => (score: ArmScore) =>
  point(score.product.preventionRate.byQuarter.find((q) => q.label === label)?.rate ?? null);

/** Every fixed row, in the spec's order. Suggestion acceptance by kind is appended per run. */
const ROWS: RowSpec[] = [
  {
    criterion: "keyword_findable_share",
    format: "pct",
    key: "keyword_findable_share",
    label: "Keyword-findable share (world)",
    section: "world",
  },
  {
    criterion: "true_prevention_lift",
    format: "pct",
    key: "true_prevention_rate",
    label: "True prevention rate",
    lift: (c) => cellOf(c.lift.truePreventionRate),
    section: "headline",
    value: (s) => cellOf(s.headline.truePreventionRate),
  },
  {
    criterion: "decision_quality",
    format: "pct",
    key: "decision_quality",
    label: "Decision quality",
    lift: (c) => cellOf(c.lift.decisionQuality),
    section: "headline",
    value: (s) => cellOf(s.headline.decisionQuality),
  },
  {
    criterion: "revenue_coverage_ratio",
    format: "pct",
    key: "revenue_coverage",
    label: "Revenue coverage (lift is ÷)",
    lift: (c) => cellOf(c.lift.revenueCoverageRatio),
    section: "headline",
    value: (s) => cellOf(s.headline.revenueCoverage),
  },
  {
    format: "pct",
    key: "direction_accuracy",
    label: "Direction accuracy (spec 007)",
    lift: (c) => cellOf(c.lift.directionAccuracy),
    note: "brief recommendation = strategy-implied decision",
    section: "headline",
    value: (s) => cellOf(s.headline.directionAccuracy),
  },
  {
    format: "days",
    key: "readiness_lead_time_days",
    label: "Readiness lead time, mean (days)",
    lift: (c) => cellOf(c.lift.readinessLeadTimeDays),
    note: "ready → decided; median in the JSON",
    section: "headline",
    value: (s) => cellOf(s.headline.readinessLeadTime),
  },
  {
    format: "pct",
    key: "close_the_loop_rate",
    label: "Close-the-loop rate",
    section: "headline",
    value: (s) => cellOf(s.headline.closeTheLoopRate),
  },
  {
    criterion: "pm_organizing_share",
    format: "pct",
    key: "pm_organizing_share",
    label: "PM organizing share",
    note: "point estimate: actions do not split by need",
    section: "headline",
    value: (s) => point(s.headline.pmOrganizingShare.value),
  },
  ...["Q1", "Q2", "Q3", "Q4"].map((label): RowSpec => ({
    format: "pct",
    key: `prevention_rate_${label.toLowerCase()}`,
    label: `Prevention rate ${label} (get_metrics)`,
    section: "product",
    value: quarter(label),
  })),
  {
    format: "pct",
    key: "prevention_rate_year",
    label: "Prevention rate year (get_metrics)",
    section: "product",
    value: (s) => point(s.product.preventionRate.year?.all.rate ?? null),
  },
  {
    format: "pct",
    key: "prevention_cross_check",
    label: "get_metrics = events recomputation",
    note: "share of windows that match",
    section: "product",
    value: (s) => {
      const checks = s.product.preventionRate.crossCheck;
      return point(checks.length ? checks.filter((c) => c.matches).length / checks.length : null);
    },
  },
  {
    format: "days",
    key: "decision_latency_median_days",
    label: "Decision latency, median (days)",
    note: "relative to the board: depends on the readiness line and budget",
    section: "product",
    value: (s) => point(s.product.decisionLatency.medianDays),
  },
  {
    format: "count",
    key: "undecided_at_year_end",
    label: "Needs undecided at year end",
    section: "product",
    value: (s) => point(s.product.decisionLatency.undecidedAtYearEnd),
  },
  {
    format: "count",
    key: "open_past_30_days",
    label: "Needs open past 30 days",
    section: "product",
    value: (s) => point(s.product.decisionLatency.openPast30Days),
  },
  {
    board: () => null,
    criterion: "suggestion_acceptance",
    format: "pct",
    key: "suggestion_acceptance",
    label: "Suggestion acceptance (get_metrics)",
    section: "product",
    signal: (s) => point(s.product.suggestionAcceptance.overall),
  },
  {
    board: () => null,
    format: "pct",
    key: "acceptance_precision",
    label: "Acceptance precision",
    section: "product",
    signal: (s) => cellOf(s.product.suggestionAcceptance.acceptancePrecision),
  },
  {
    format: "pct",
    key: "hidden_duplicate_rate",
    label: "Hidden duplicate rate",
    section: "diagnostics",
    value: (s) => cellOf(s.diagnostics.hiddenDuplicateRate),
  },
  {
    format: "num",
    key: "priority_agreement",
    label: "Priority agreement (Spearman)",
    note: "Signal: priority score; board: votes",
    section: "diagnostics",
    value: (s) => cellOf(s.diagnostics.priorityAgreement),
  },
  {
    board: () => null,
    format: "grade",
    key: "need_statement_rubric",
    label: "Need-statement rubric (1–5)",
    note: "not computed (deferred)",
    section: "diagnostics",
    signal: (s) => point(s.diagnostics.needStatementRubric.value),
  },
  {
    format: "ms",
    key: "preview_latency_p50_ms",
    label: "Preview latency p50 (ms)",
    note: "in-process; not production latency",
    section: "diagnostics",
    value: (s) => point(s.diagnostics.previewLatencyMs.p50),
  },
  {
    format: "ms",
    key: "preview_latency_p95_ms",
    label: "Preview latency p95 (ms)",
    section: "diagnostics",
    value: (s) => point(s.diagnostics.previewLatencyMs.p95),
  },
  {
    criterion: "false_attach_rate",
    format: "pct",
    key: "false_attach_rate",
    label: "False attach rate",
    section: "guardrails",
    value: (s) => cellOf(s.diagnostics.falseAttachRate),
  },
  {
    criterion: "unmerge_rate",
    format: "pct",
    key: "unmerge_rate",
    label: "Unmerge rate",
    section: "guardrails",
    value: (s) => point(s.diagnostics.unmergeRate.value),
  },
  {
    criterion: "planted_pii",
    format: "count",
    key: "planted_pii_leaks",
    label: "Planted PII in approved summaries",
    section: "guardrails",
    value: (s) => point(s.diagnostics.piiScan.leaks.length),
  },
  {
    criterion: "model_spend_per_signal",
    format: "usd",
    key: "model_spend_per_signal",
    label: "Model spend per signal",
    section: "guardrails",
    value: (s) => point(s.diagnostics.modelSpendPerSignalUsd),
  },
];

/** Every fixed metric key the table carries, in order. */
export const REPORT_METRIC_KEYS = ROWS.map((row) => row.key);

/** Every success criterion the table judges (each `compareArms` criterion appears once). */
export const REPORT_CRITERIA = ROWS.flatMap((row) => (row.criterion ? [row.criterion] : []));

export interface TableInput {
  comparison: Comparison | null;
  keywordFindableShare: number | null;
  scores: Partial<Record<ArmName, ArmScore>>;
}

export const buildTable = ({
  comparison,
  keywordFindableShare,
  scores,
}: TableInput): ReportRow[] => {
  const rows = ROWS.map((spec): ReportRow => {
    const criterion = spec.criterion
      ? comparison?.criteria.find((c) => c.name === spec.criterion)
      : undefined;
    const cellFor = (arm: ArmName) => {
      const score = scores[arm];
      if (spec.key === "keyword_findable_share") return point(keywordFindableShare);
      const pick = (arm === "signal" ? spec.signal : spec.board) ?? spec.value;
      return score && pick ? pick(score) : null;
    };
    return {
      board: cellFor("board"),
      criterion: spec.criterion
        ? {
            bar: criterion?.bar ?? "",
            detail: criterion?.detail ?? "needs both arms",
            lift: comparison && spec.lift ? spec.lift(comparison) : null,
            name: spec.criterion,
            verdict: verdictOf(criterion),
          }
        : null,
      format: spec.format,
      key: spec.key,
      label: spec.label,
      section: spec.section,
      signal: cellFor("signal"),
      ...(spec.note ? { note: spec.note } : {}),
      ...(!spec.criterion && spec.lift ? { lift: comparison ? spec.lift(comparison) : null } : {}),
    };
  });
  // Suggestion acceptance by type (Signal arm only), right after the overall row.
  const byKind = (scores.signal?.product.suggestionAcceptance.byKind ?? []).map(
    (kind): ReportRow => ({
      board: null,
      criterion: null,
      format: "pct",
      key: `suggestion_acceptance.${kind.kind}`,
      label: `  ${kind.kind} (${kind.resolved} resolved)`,
      section: "product",
      signal: point(kind.acceptanceRate),
    }),
  );
  const at = rows.findIndex((row) => row.key === "suggestion_acceptance") + 1;
  rows.splice(at, 0, ...byKind);
  return rows;
};

// ---- Terminal rendering ----

const fmtValue = (value: number | null, format: ValueFormat) => {
  if (value === null) return "n/a";
  if (!Number.isFinite(value)) return "∞";
  switch (format) {
    case "pct": {
      return `${(value * 100).toFixed(1)}%`;
    }
    case "usd": {
      return `$${value.toFixed(4)}`;
    }
    case "count": {
      return String(Math.round(value));
    }
    case "ms": {
      return `${Math.round(value)}`;
    }
    case "days":
    case "grade": {
      return value.toFixed(1);
    }
    default: {
      return value.toFixed(3);
    }
  }
};

const fmtCell = (cell: Cell | null, format: ValueFormat) => {
  if (!cell) return "—";
  const base = fmtValue(cell.value, format);
  if (!cell.ci) return base;
  return `${base} [${fmtValue(cell.ci[0], format)}–${fmtValue(cell.ci[1], format)}]`;
};

/** Lift cells: a difference of rates is points; revenue coverage's lift is a ratio. */
const fmtLift = (row: ReportRow) => {
  const lift = row.criterion?.lift ?? row.lift;
  if (!lift) return "";
  const format: ValueFormat = row.key === "revenue_coverage" ? "num" : row.format;
  const sign = format === "pct" && lift.value !== null && lift.value > 0 ? "+" : "";
  return `${sign}${fmtCell(lift, format)}${format === "num" ? "×" : ""}`;
};

const SECTION_TITLES: Record<Section, string> = {
  diagnostics: "Diagnostics",
  guardrails: "Guardrails",
  headline: "Business outcomes (headline)",
  product: "PRODUCT.md metrics",
  world: "World",
};

const pad = (text: string, width: number) =>
  text.length >= width ? `${text} ` : text.padEnd(width);

const WIDTHS = [38, 26, 26, 26, 8];
const HEADER = ["Metric", "Signal [95% CI]", "Board [95% CI]", "Lift [95% CI]", "Verdict"];
const columns = (cells: string[]) => cells.map((cell, i) => pad(cell, WIDTHS[i] ?? 0)).join("");

const headerLines = (report: CrewdayReport) => {
  const { gitSha, models, world } = report;
  const kfs = world.keywordFindableShare;
  return [
    `Crewday outcome eval: world ${world.name}@${world.version} (${world.signals} signals), seed ${report.seed}, git ${gitSha.sha?.slice(0, 10) ?? "unknown"}${gitSha.dirty ? " (dirty)" : ""}, ${report.mode}`,
    `Models: fast ${models.fast}, reasoning ${models.reasoning}, embedding ${models.embedding}`,
    `PM policy: ${report.policy.pmPolicy}${report.policy.pmPolicy === "follows_signal" ? ` (override ${report.policy.pPmOverride}; Signal arm only, the board runs oracle)` : ""}`,
    ...(report.mode === "offline"
      ? ["OFFLINE: fake AI ports. These numbers are not a Signal result."]
      : []),
    ...(report.limitWeeks === null
      ? []
      : [`SMOKE: replay limited to ${report.limitWeeks} weeks. Never a result.`]),
    `Keyword-findable share: ${fmtValue(kfs.value, "pct")}${kfs.source ? ` (${kfs.source})` : ""} (world is valid when ≤ 60%)`,
  ];
};

const rowLine = (row: ReportRow) =>
  `${columns([
    row.label,
    fmtCell(row.signal, row.format),
    fmtCell(row.board, row.format),
    fmtLift(row),
    row.criterion?.verdict ?? "",
  ])}${row.criterion ? `bar ${row.criterion.bar}` : (row.note ?? "")}`.trimEnd();

const tableLines = (report: CrewdayReport) => {
  const lines: string[] = [];
  let section: Section | undefined;
  for (const row of report.table) {
    if (row.section !== section) {
      ({ section } = row);
      lines.push("", SECTION_TITLES[row.section], columns(HEADER));
    }
    lines.push(rowLine(row));
  }
  return lines;
};

const criteriaLines = (report: CrewdayReport) => {
  const lines = ["", "Success criteria:"];
  for (const row of report.table)
    if (row.criterion)
      lines.push(
        `  ${pad(row.criterion.verdict, 6)}${pad(row.criterion.name, 26)}${row.criterion.bar}: ${row.criterion.detail}`,
      );
  if (report.comparison)
    lines.push(
      report.comparison.killSignal
        ? "  OUTCOME KILL SIGNAL: Signal does not beat the board on true prevention by 20 points (whole interval)."
        : "  Signal beats the board on true prevention by at least 20 points (whole interval).",
    );
  return lines;
};

const piiLines = (report: CrewdayReport) => {
  const checked = Object.entries(report.pii.summariesChecked)
    .map(([arm, n]) => `${arm} ${n}`)
    .join(", ");
  return [
    "",
    "Planted PII:",
    ...report.pii.planted.map(
      (planted) => `  ${planted.worldSignalId}: ${planted.pii.length} identifying detail(s)`,
    ),
    report.pii.leaks.length === 0
      ? `  None of them appears in any approved public summary (checked: ${checked || "none"}).`
      : `  LEAK: ${report.pii.leaks.map((l) => `${l.worldSignalId} in ${l.arm} need ${l.needId}`).join("; ")}`,
  ];
};

const runLines = (report: CrewdayReport) => {
  const lines = ["", "Runs:"];
  for (const [arm, run] of Object.entries(report.runs)) {
    const spend = run.spend
      ? `$${run.spend.totalUsd.toFixed(4)} over ${run.spend.calls} model calls${run.spend.unpricedCalls ? ` (${run.spend.unpricedCalls} unpriced: lower bound)` : ""}`
      : "spend not metered";
    lines.push(
      `  ${pad(arm, 7)}${(run.wallTimeMs / 1000).toFixed(1)} s, ${run.weeks} weeks; ${spend}; surfaces REST ${run.surfaceMix.rest}, public MCP ${run.surfaceMix.public_mcp}, Operator MCP ${run.surfaceMix.operator_mcp}`,
    );
  }
  const { spend } = report;
  lines.push(
    `  total ${(report.wallTimeMs / 1000).toFixed(1)} s${spend.totalUsd === null ? "" : `; model spend $${spend.totalUsd.toFixed(4)} (incl. oracle overhead $${(spend.oracleUsd ?? 0).toFixed(4)})`}`,
  );
  return lines;
};

/** The report as terminal lines. */
export const renderReport = (report: CrewdayReport): string[] => [
  ...headerLines(report),
  ...tableLines(report),
  ...criteriaLines(report),
  "",
  "Not measured here:",
  ...report.notMeasured.map((item) => `  - ${item.metric}: ${item.reason}`),
  ...piiLines(report),
  ...runLines(report),
];
