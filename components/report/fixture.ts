import { datasetColumns } from "@/lib/signal/domain/report-datasets";
import type { DatasetName, DatasetResult } from "@/lib/signal/domain/report-datasets";
import type { ReportData, ReportSpec } from "@/lib/signal/domain/report-spec";

/**
 * A hand-built report for the dev page (`/dev/reports`): every block kind and every chart kind,
 * including a `seriesBy` pivot, stacked bars and areas, horizontal bars with long labels, a
 * donut, a scatter, and KPIs in cents, percent, days, and counts. Numbers are fictional.
 */

const result = (
  name: DatasetName,
  rows: DatasetResult["rows"],
  truncated = false,
): DatasetResult => ({
  columns: datasetColumns[name],
  rows,
  truncated,
});

const weeks = [
  "2026-08-10",
  "2026-08-17",
  "2026-08-24",
  "2026-08-31",
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
];

const themes = ["Reporting", "Integrations", "Permissions", "Billing", "Mobile"] as const;
const weeklyByTheme: Record<(typeof themes)[number], number[]> = {
  Billing: [2, 1, 3, 2, 2, 4, 3, 2, 3, 2, 4, 3],
  Integrations: [5, 6, 4, 7, 8, 6, 9, 7, 8, 10, 9, 11],
  Mobile: [1, 0, 2, 1, 1, 2, 1, 3, 2, 2, 1, 2],
  Permissions: [3, 4, 3, 2, 4, 5, 4, 6, 5, 4, 6, 5],
  Reporting: [8, 7, 9, 10, 9, 12, 11, 13, 12, 14, 13, 16],
};

const signalsWeekly = themes.flatMap((group) =>
  weeks.map((weekStart, index) => {
    const signals = weeklyByTheme[group][index] ?? 0;
    const attachedExisting = Math.round(signals * 0.6);
    return {
      attachedDraft: signals - attachedExisting,
      attachedExisting,
      group,
      signals,
      weekStart,
    };
  }),
);

const metricsWeekly = weeks.map((weekStart, index) => {
  const signals = themes.reduce((sum, theme) => sum + (weeklyByTheme[theme][index] ?? 0), 0);
  const attachedExisting = Math.round(signals * (0.42 + index * 0.017));
  const mergedLater = Math.max(1, Math.round(signals * 0.12) - (index % 3));
  return {
    attachedExisting,
    mergedLater,
    preventionRate: attachedExisting / (attachedExisting + mergedLater),
    signals,
    weekStart,
  };
});

const need = (
  needId: string,
  statement: string,
  theme: string,
  status: string,
  people: number,
  accounts: number,
  arrCents: number,
  openDealCents: number,
  score: number,
  trend: string,
  createdAt: string,
  decidedAt: string | null = null,
) => ({
  accounts,
  arrCents,
  createdAt,
  decidedAt,
  needId,
  openDealCents,
  people,
  readyAt: people >= 3 ? createdAt : null,
  score,
  statement,
  status,
  theme,
  trend,
});

const needs = [
  need(
    "n01",
    "Schedule recurring report exports to email and Slack",
    "Reporting",
    "planned",
    41,
    18,
    412_000_00,
    96_000_00,
    4.6,
    "rising",
    "2026-06-02",
    "2026-09-18",
  ),
  need(
    "n02",
    "Two-way sync with Salesforce opportunities and custom fields",
    "Integrations",
    "open",
    33,
    14,
    388_500_00,
    140_000_00,
    4.4,
    "rising",
    "2026-05-21",
  ),
  need(
    "n03",
    "Role-based permissions per workspace with an audit trail of changes",
    "Permissions",
    "in_progress",
    27,
    11,
    301_200_00,
    55_000_00,
    4.1,
    "steady",
    "2026-04-11",
    "2026-08-30",
  ),
  need(
    "n04",
    "Usage-based invoices with line items per seat",
    "Billing",
    "open",
    19,
    9,
    154_000_00,
    22_000_00,
    3.4,
    "steady",
    "2026-07-03",
  ),
  need(
    "n05",
    "Offline mode on mobile for field teams",
    "Mobile",
    "open",
    12,
    5,
    61_800_00,
    0,
    2.6,
    "falling",
    "2026-03-15",
  ),
  need(
    "n06",
    "Custom dashboards with saved filters",
    "Reporting",
    "shipped",
    24,
    10,
    210_400_00,
    18_000_00,
    3.9,
    "steady",
    "2026-02-08",
    "2026-07-22",
  ),
  need(
    "n07",
    "Webhook retries with a delivery log",
    "Integrations",
    "planned",
    15,
    8,
    132_900_00,
    40_000_00,
    3.2,
    "rising",
    "2026-06-29",
    "2026-10-02",
  ),
  need(
    "n08",
    "SCIM provisioning for Okta and Azure AD",
    "Permissions",
    "open",
    21,
    12,
    276_000_00,
    110_000_00,
    4.0,
    "rising",
    "2026-08-14",
  ),
  need(
    "n09",
    "Export needs to CSV with every column",
    "Reporting",
    "declined",
    8,
    4,
    22_300_00,
    0,
    1.8,
    "falling",
    "2026-01-19",
    "2026-06-05",
  ),
  need(
    "n10",
    "Push notifications when a need I follow changes status",
    "Mobile",
    "draft",
    4,
    2,
    9_600_00,
    0,
    1.2,
    "steady",
    "2026-10-21",
  ),
  need(
    "n11",
    "Native HubSpot integration",
    "Integrations",
    "open",
    17,
    7,
    98_700_00,
    35_000_00,
    3.0,
    "steady",
    "2026-07-30",
  ),
  need(
    "n12",
    "Annual billing with a prorated upgrade path",
    "Billing",
    "planned",
    11,
    6,
    120_500_00,
    60_000_00,
    2.9,
    "steady",
    "2026-05-02",
    "2026-09-29",
  ),
];

const enterpriseNeeds = needs.filter((row) => row.accounts >= 7);

const accounts = [
  ["a01", "Northwind Logistics", "Enterprise", 186_000_00, 60_000_00, 7, 23],
  ["a02", "Globex", "Enterprise", 154_000_00, 0, 5, 17],
  ["a03", "Initech", "Enterprise", 121_500_00, 45_000_00, 6, 14],
  ["a04", "Umbrella Health", "Enterprise", 98_000_00, 30_000_00, 4, 11],
  ["a05", "Stark Freight", "Growth", 64_200_00, 12_000_00, 4, 9],
  ["a06", "Wayne Analytics", "Growth", 52_000_00, 0, 3, 8],
  ["a07", "Acme Field Services", "Growth", 38_400_00, 8_000_00, 2, 6],
  ["a08", "Hooli", "Growth", 31_900_00, 0, 3, 5],
  ["a09", "Pied Piper", "Starter", 12_000_00, 0, 2, 4],
  ["a10", "Vandelay Imports", "Starter", 9_600_00, 2_400_00, 1, 3],
  ["a11", "Bluth Company", "Starter", 7_200_00, 0, 1, 2],
] as const;

const decisions = needs
  .filter((row) => row.decidedAt)
  .map((row) => ({
    latencyDays: Math.round(
      (Date.parse(row.decidedAt ?? "") - Date.parse(row.createdAt)) / 86_400_000,
    ),
    needId: row.needId,
    publishedAt: row.decidedAt,
    recommendedStatus: row.status === "declined" ? "declined" : "planned",
    statement: row.statement,
    status: row.status,
    theme: row.theme,
  }));

export const reportFixture: {
  asOf: string;
  data: ReportData;
  spec: ReportSpec;
  warnings: string[];
} = {
  asOf: "2026-10-30T14:05:00Z",
  data: {
    accounts: result(
      "accounts",
      accounts.map(
        ([accountId, account, plan, arrCents, openDealCents, needsSupported, signals]) => ({
          account,
          accountId,
          arrCents,
          lastSignalAt: "2026-10-2" + String(signals % 9),
          needsSupported,
          openDealCents,
          plan,
          signals,
        }),
      ),
    ),
    decisions: result("decisions", decisions),
    enterprise: result("needs", enterpriseNeeds),
    metrics: result("metrics_weekly", metricsWeekly),
    needs: result("needs", needs),
    weekly: result("signals_weekly", signalsWeekly, true),
  },
  spec: {
    blocks: [
      {
        items: [
          { aggregate: "count", column: "needId", dataset: "needs", label: "Live needs" },
          { aggregate: "sum", column: "arrCents", dataset: "needs", label: "ARR asking" },
          {
            aggregate: "latest",
            column: "preventionRate",
            dataset: "metrics",
            label: "Prevention rate",
          },
          {
            aggregate: "median",
            column: "latencyDays",
            dataset: "decisions",
            label: "Days to decide",
          },
        ],
        kind: "kpi",
      },
      {
        kind: "text",
        markdown:
          "Demand is concentrated in **Reporting** and **Integrations**.\n\n- Scheduled exports lead on ARR.\n- Salesforce sync carries the most open-deal value.",
      },
      { kind: "heading", text: "Where demand sits" },
      {
        caption: "Top needs by ARR of the accounts asking.",
        chart: "bar",
        dataset: "needs",
        horizontal: true,
        kind: "chart",
        limit: 8,
        sort: { column: "arrCents", direction: "desc" },
        title: "ARR by need",
        x: "statement",
        y: ["arrCents"],
      },
      {
        chart: "bar",
        dataset: "accounts",
        kind: "chart",
        limit: 6,
        sort: { column: "arrCents", direction: "desc" },
        title: "ARR and open deals, top accounts",
        x: "account",
        y: ["arrCents", "openDealCents"],
      },
      {
        chart: "donut",
        dataset: "accounts",
        kind: "chart",
        sort: { column: "arrCents", direction: "desc" },
        title: "Share of ARR by account",
        x: "account",
        y: ["arrCents"],
      },
      {
        caption: "People asking against priority score; each dot is a need.",
        chart: "scatter",
        dataset: "needs",
        kind: "chart",
        title: "People vs. priority",
        x: "people",
        y: ["score"],
      },
      { kind: "heading", text: "Signals over time" },
      {
        chart: "bar",
        dataset: "weekly",
        kind: "chart",
        seriesBy: "group",
        stacked: true,
        title: "Signals per week by theme",
        x: "weekStart",
        y: ["signals"],
      },
      {
        chart: "area",
        dataset: "metrics",
        kind: "chart",
        stacked: true,
        title: "Attached vs. merged later",
        x: "weekStart",
        y: ["attachedExisting", "mergedLater"],
      },
      {
        caption: "Share of signals that joined an existing need.",
        chart: "line",
        dataset: "metrics",
        kind: "chart",
        title: "Prevention rate",
        x: "weekStart",
        y: ["preventionRate"],
      },
      {
        chart: "line",
        dataset: "weekly",
        kind: "chart",
        seriesBy: "group",
        title: "Signals per week, one line per theme",
        x: "weekStart",
        y: ["signals"],
      },
      { kind: "heading", text: "Enterprise detail" },
      {
        columns: [
          "statement",
          "theme",
          "status",
          "people",
          "accounts",
          "arrCents",
          "score",
          "decidedAt",
        ],
        dataset: "enterprise",
        kind: "table",
        limit: 10,
        sort: { column: "arrCents", direction: "desc" },
        title: "Top Enterprise needs",
      },
      {
        columns: ["statement", "theme", "status", "publishedAt", "latencyDays"],
        dataset: "decisions",
        kind: "table",
        sort: { column: "latencyDays", direction: "asc" },
        title: "Decisions, fastest first",
      },
    ],
    datasets: [
      { id: "needs", name: "needs", params: {} },
      { id: "enterprise", name: "needs", params: { plan: "Enterprise", includeDecided: true } },
      { id: "accounts", name: "accounts", params: {} },
      { id: "weekly", name: "signals_weekly", params: { groupBy: "theme", since: "2026-08-10" } },
      { id: "metrics", name: "metrics_weekly", params: { actor: "all" } },
      { id: "decisions", name: "decisions", params: { since: "2026-05-01" } },
    ],
    title: "Weekly demand",
    version: 1,
  },
  warnings: ["No dataset covers NPS, so the report shows demand by theme instead."],
};
