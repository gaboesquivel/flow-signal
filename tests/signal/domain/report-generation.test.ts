import { describe, expect, it } from "vitest";

import { fakeReasoner } from "../../../lib/signal/ai/fakes";
import { SignalError } from "../../../lib/signal/errors";
import {
  extractTextNumbers,
  findUntraceableNumbers,
  generateReport,
  traceableValues,
} from "../../../lib/signal/domain/report-generation";
import type { ReportGenerationDeps } from "../../../lib/signal/domain/report-generation";
import { datasetColumns } from "../../../lib/signal/domain/report-datasets";
import type { DatasetQuery, DatasetResult } from "../../../lib/signal/domain/report-datasets";
import type { ReportSpec } from "../../../lib/signal/domain/report-spec";
import { asModelCompose } from "../support/report-compose";

const NOW = new Date("2026-10-30T09:00:00Z");
const REPORTING = "11111111-1111-4111-8111-111111111111";

const needsResult: DatasetResult = {
  columns: datasetColumns.needs,
  rows: [
    {
      accounts: 2,
      arrCents: 48_000_000,
      createdAt: "2026-05-01T00:00:00.000Z",
      decidedAt: null,
      needId: "n1",
      openDealCents: 12_000_000,
      people: 6,
      readyAt: null,
      score: 4.1,
      statement: "Executives need to share dashboards",
      status: "open",
      theme: "Reporting",
      trend: "rising",
    },
    {
      accounts: 1,
      arrCents: 6_000_000,
      createdAt: "2026-08-01T00:00:00.000Z",
      decidedAt: null,
      needId: "n2",
      openDealCents: 0,
      people: 5,
      readyAt: null,
      score: 2,
      statement: "Compliance teams need archives",
      status: "open",
      theme: "Compliance",
      trend: "falling",
    },
    {
      accounts: 0,
      arrCents: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      decidedAt: null,
      needId: "n3",
      openDealCents: 0,
      people: 4,
      readyAt: null,
      score: null,
      statement: "Analysts need to annotate charts",
      status: "draft",
      theme: "Reporting",
      trend: "steady",
    },
  ],
  truncated: false,
};

const weeklyResult: DatasetResult = {
  columns: datasetColumns.signals_weekly,
  rows: [
    {
      attachedDraft: 1,
      attachedExisting: 3,
      group: "Reporting",
      signals: 4,
      weekStart: "2026-10-19",
    },
    {
      attachedDraft: 0,
      attachedExisting: 2,
      group: "Compliance",
      signals: 2,
      weekStart: "2026-10-19",
    },
  ],
  truncated: false,
};

const stubData = { needs: needsResult, signals_weekly: weeklyResult } as const;

const needsPlan = {
  datasets: [{ id: "d1", name: "needs", params: { themeId: REPORTING } }],
  gaps: [],
};

const goodBlocks = [
  { kind: "heading", text: "Demand" },
  {
    items: [
      { aggregate: "sum", column: "arrCents", dataset: "d1", label: "ARR" },
      { aggregate: "count", column: "needId", dataset: "d1", label: "Live needs" },
    ],
    kind: "kpi",
  },
  {
    chart: "bar",
    dataset: "d1",
    kind: "chart",
    title: "ARR by need",
    x: "statement",
    y: ["arrCents"],
  },
];

interface Calls {
  queries: DatasetQuery[];
  prompts: Record<string, string[]>;
}

const setup = (
  handlers: Parameters<typeof fakeReasoner>[0],
  overrides: Partial<ReportGenerationDeps> = {},
) => {
  const calls: Calls = { prompts: {}, queries: [] };
  const record =
    (task: string, handler: ((input: { prompt: string }) => unknown) | undefined) =>
    (input: { prompt: string; system?: string }) => {
      (calls.prompts[task] ??= []).push(input.prompt);
      if (!handler) throw new SignalError("ai_unavailable", "No handler.");
      return handler(input);
    };
  const deps: ReportGenerationDeps = {
    now: NOW,
    reasoner: fakeReasoner({
      report_compose: record(
        "report_compose",
        handlers?.report_compose && asModelCompose(handlers.report_compose),
      ),
      report_plan: record("report_plan", handlers?.report_plan),
    }),
    runDataset: (query) => {
      calls.queries.push(query);
      const result = stubData[query.name as keyof typeof stubData];
      if (!result) throw new Error(`no stub for ${query.name}`);
      return Promise.resolve(result);
    },
    themes: () => Promise.resolve([{ id: REPORTING, name: "Reporting" }]),
    ...overrides,
  };
  return { calls, deps };
};

describe("generateReport", () => {
  it("runs exactly the planned queries and assembles a validated version 1 spec", async () => {
    const { calls, deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Reporting demand" }),
      report_plan: () => ({
        datasets: [
          { id: "d1", name: "needs", params: { themeId: REPORTING } },
          { id: "d2", name: "signals_weekly", params: { groupBy: "theme" } },
        ],
        gaps: [],
      }),
    });
    const result = await generateReport(deps, { prompt: "Reporting demand by need" });

    expect(calls.queries).toEqual([
      { id: "d1", name: "needs", params: { themeId: REPORTING } },
      { id: "d2", name: "signals_weekly", params: { groupBy: "theme" } },
    ]);
    expect(result.report).toMatchObject({
      datasets: calls.queries,
      title: "Reporting demand",
      version: 1,
    });
    expect(result.report.blocks).toHaveLength(3);
    expect(result.data).toEqual({ d1: needsResult, d2: weeklyResult });
    expect(result.asOf).toBe(NOW.toISOString());
    expect(result.warnings).toEqual([]);
  });

  it("gives the plan the catalog, columns, themes, and prompt; compose gets columns and samples", async () => {
    const { calls, deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Demand" }),
      report_plan: () => needsPlan,
    });
    await generateReport(deps, { prompt: "ARR-weighted demand by theme" });

    const [plan] = calls.prompts.report_plan!;
    expect(plan).toContain("ARR-weighted demand by theme");
    expect(plan).toContain("signals_weekly");
    expect(plan).toContain("arrCents");
    expect(plan).toContain(REPORTING);
    expect(plan).toContain("Reporting");

    const [compose] = calls.prompts.report_compose!;
    expect(compose).toContain("ARR-weighted demand by theme");
    expect(compose).toContain('"id": "d1"');
    expect(compose).toContain("Executives need to share dashboards");
    expect(compose).toContain('"rowCount": 3');
  });

  it("sends a prior spec to both the plan and the compose prompts", async () => {
    const prior: ReportSpec = {
      blocks: [{ kind: "heading", text: "Prior heading marker" }],
      datasets: [{ id: "d1", name: "needs", params: {} }],
      title: "Weekly demand prior",
      version: 1,
    };
    const { calls, deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Weekly demand" }),
      report_plan: () => needsPlan,
    });
    await generateReport(deps, { prior, prompt: "make it weekly" });

    for (const task of ["report_plan", "report_compose"])
      for (const marker of ["Weekly demand prior", "Prior heading marker"])
        expect(calls.prompts[task]![0], `${task} lacks ${marker}`).toContain(marker);
  });

  it("turns gaps into warnings", async () => {
    const { deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Demand" }),
      report_plan: () => ({ ...needsPlan, gaps: ["NPS by region", "churn."] }),
    });
    const result = await generateReport(deps, { prompt: "Demand plus NPS by region" });
    expect(result.warnings).toEqual([
      "No dataset covers NPS by region.",
      "No dataset covers churn.",
    ]);
  });

  it("keeps a text block whose numbers are in the data, KPIs, or formatted values", async () => {
    const text = {
      kind: "text",
      markdown:
        "Reporting leads with $480,000 ARR ($540K across 3 needs). The top need has 6 people and a 4.1 score in 2026.",
    };
    const { calls, deps } = setup({
      report_compose: () => ({ blocks: [...goodBlocks, text], title: "Demand" }),
      report_plan: () => needsPlan,
    });
    const result = await generateReport(deps, { prompt: "Demand" });
    expect(result.report.blocks).toContainEqual(text);
    expect(result.warnings).toEqual([]);
    expect(calls.prompts.report_compose).toHaveLength(1);
  });

  it("repairs a text block citing a number not in the data, once", async () => {
    let round = 0;
    const { calls, deps } = setup({
      report_compose: () => {
        round += 1;
        const markdown = round === 1 ? "ARR is $999,000." : "ARR is $540,000.";
        return { blocks: [...goodBlocks, { kind: "text", markdown }], title: "Demand" };
      },
      report_plan: () => needsPlan,
    });
    const result = await generateReport(deps, { prompt: "Demand" });

    expect(calls.prompts.report_compose).toHaveLength(2);
    expect(calls.prompts.report_compose![1]).toContain("999,000");
    expect(result.report.blocks).toContainEqual({ kind: "text", markdown: "ARR is $540,000." });
    expect(result.warnings).toEqual([]);
  });

  it("drops a text block that still cites an untraceable number after repair, with a warning", async () => {
    const { calls, deps } = setup({
      report_compose: () => ({
        blocks: [...goodBlocks, { kind: "text", markdown: "NPS is 72 this quarter." }],
        title: "Demand",
      }),
      report_plan: () => needsPlan,
    });
    const result = await generateReport(deps, { prompt: "Demand" });

    expect(calls.prompts.report_compose).toHaveLength(2);
    expect(result.report.blocks).toEqual(goodBlocks);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/text block/u);
    expect(result.warnings[0]).toContain("72");
  });

  it("replaces a title that cites an untraceable number", async () => {
    const { deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Demand grew 37%" }),
      report_plan: () => needsPlan,
    });
    const result = await generateReport(deps, { prompt: "Demand" });

    expect(result.report.title).toBe("Report");
    expect(result.warnings[0]).toMatch(/^Replaced the title/u);
  });

  it("traces numbers in chart captions too", async () => {
    const chart = {
      caption: "ARR up 40% quarter over quarter",
      chart: "bar",
      dataset: "d1",
      kind: "chart",
      title: "ARR by theme",
      x: "theme",
      y: ["arrCents"],
    };
    const { deps } = setup({
      report_compose: () => ({ blocks: [...goodBlocks, chart], title: "Demand" }),
      report_plan: () => needsPlan,
    });
    const result = await generateReport(deps, { prompt: "Demand" });

    expect(result.report.blocks).toEqual(goodBlocks);
    expect(result.warnings[0]).toMatch(/chart block/u);
    expect(result.warnings[0]).toContain("40%");
  });

  it("drops a block with a bad column after repair, and fails when no block survives", async () => {
    const bad = {
      chart: "bar",
      dataset: "d1",
      kind: "chart",
      title: "NPS",
      x: "theme",
      y: ["nps"],
    };
    const { deps } = setup({
      report_compose: () => ({ blocks: [...goodBlocks, bad], title: "Demand" }),
      report_plan: () => needsPlan,
    });
    const result = await generateReport(deps, { prompt: "Demand" });
    expect(result.report.blocks).toEqual(goodBlocks);
    expect(result.warnings.join(" ")).toContain('no column "nps"');

    const { deps: onlyBad } = setup({
      report_compose: () => ({ blocks: [bad], title: "Demand" }),
      report_plan: () => needsPlan,
    });
    await expect(generateReport(onlyBad, { prompt: "Demand" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("repairs a plan that names an unknown dataset or bad params, and never runs it", async () => {
    let round = 0;
    const { calls, deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Demand" }),
      report_plan: () => {
        round += 1;
        return round === 1
          ? {
              datasets: [
                { id: "d1", name: "nps", params: {} },
                { id: "d2", name: "accounts", params: { plan: "Platinum" } },
              ],
              gaps: [],
            }
          : needsPlan;
      },
    });
    const result = await generateReport(deps, { prompt: "Demand" });

    expect(calls.prompts.report_plan).toHaveLength(2);
    expect(calls.prompts.report_plan![1]).toContain("nps");
    expect(calls.prompts.report_plan![1]).toContain("Platinum");
    expect(calls.queries.map((query) => query.name)).toEqual(["needs"]);
    expect(result.report.datasets).toEqual(needsPlan.datasets);
  });

  it("reports a plan that is still invalid after repair as validation_failed, running nothing", async () => {
    const { calls, deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Demand" }),
      report_plan: () => ({ datasets: [{ id: "d1", name: "nps", params: {} }], gaps: ["NPS"] }),
    });
    const error = await generateReport(deps, { prompt: "NPS by region" }).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(SignalError);
    expect(error).toMatchObject({ code: "validation_failed" });
    expect((error as Error).message).toContain("nps");
    expect(calls.queries).toEqual([]);
    expect(calls.prompts.report_compose).toBeUndefined();
  });

  it("skips queries still invalid after repair but runs the valid ones, with a warning", async () => {
    const { calls, deps } = setup({
      report_compose: () => ({ blocks: goodBlocks, title: "Demand" }),
      report_plan: () => ({
        datasets: [...needsPlan.datasets, { id: "d2", name: "nps", params: {} }],
        gaps: [],
      }),
    });
    const result = await generateReport(deps, { prompt: "Demand" });
    expect(calls.queries.map((query) => query.id)).toEqual(["d1"]);
    expect(result.report.datasets.map((query) => query.id)).toEqual(["d1"]);
    expect(result.warnings.join(" ")).toContain("nps");
  });

  it("fails with ai_unavailable when the model is unreachable", async () => {
    const { calls, deps } = setup({});
    await expect(generateReport(deps, { prompt: "Demand" })).rejects.toMatchObject({
      code: "ai_unavailable",
    });
    expect(calls.queries).toEqual([]);

    const { deps: composeDown } = setup({ report_plan: () => needsPlan });
    await expect(generateReport(composeDown, { prompt: "Demand" })).rejects.toMatchObject({
      code: "ai_unavailable",
    });
  });
});

const values = (text: string) => extractTextNumbers(text).map((token) => token.value);

describe("extractTextNumbers", () => {
  it("strips $, %, and commas and applies k/M/B suffixes", () => {
    expect(values("$480,000 and 45% and $1.2M and 12k and 3B")).toEqual([
      480_000, 45, 1_200_000, 12_000, 3_000_000_000,
    ]);
  });

  it("ignores years, ISO dates, month-day dates, list markers, ordinals, and words with digits", () => {
    expect(
      values("1. In 2026, since 2026-10-12 and Oct 12, Q3 and H1 saw the 2nd wave\n2) still 7"),
    ).toEqual([7]);
  });

  it("keeps the display precision as tolerance", () => {
    const [million, whole, decimal] = extractTextNumbers("$1.2M, 480, 4.15");
    expect(million?.tolerance).toBeCloseTo(50_000);
    expect(whole?.tolerance).toBeCloseTo(0.5);
    expect(decimal?.tolerance).toBeCloseTo(0.005);
  });
});

describe("findUntraceableNumbers", () => {
  it("matches values within display rounding and flags the rest", () => {
    const allowed = [1_234_567, 480_000, 0.4567, 45.67, 4.08];
    expect(findUntraceableNumbers("$1.2M and 480,000 and 45.7% and 4.1", allowed)).toEqual([]);
    expect(findUntraceableNumbers("$1.4M and 46.2% and 999", allowed)).toEqual([
      "$1.4M",
      "46.2%",
      "999",
    ]);
  });

  it("matches negatives by magnitude", () => {
    expect(findUntraceableNumbers("down −20% and -3", [-20, 3])).toEqual([]);
  });
});

describe("traceableValues", () => {
  const spec: ReportSpec = {
    blocks: [
      {
        items: [
          { aggregate: "sum", column: "arrCents", dataset: "d1", label: "ARR" },
          { aggregate: "avg", column: "people", dataset: "d1", label: "Avg people" },
        ],
        kind: "kpi",
      },
      {
        chart: "bar",
        dataset: "d2",
        kind: "chart",
        seriesBy: "group",
        stacked: true,
        title: "Signals",
        x: "weekStart",
        y: ["signals"],
      },
      { columns: ["statement"], dataset: "d1", kind: "table", limit: 10, title: "Top" },
    ],
    datasets: [
      { id: "d1", name: "needs", params: {} },
      { id: "d2", name: "signals_weekly", params: { groupBy: "theme" } },
    ],
    title: "Demand",
    version: 1,
  };
  const allowed = traceableValues(spec, { d1: needsResult, d2: weeklyResult }, "top 10 needs");
  const traceable = (text: string) => findUntraceableNumbers(text, allowed);

  it("allows cells, cents as dollars, and percent ratios as percents", () => {
    expect(traceable("$480,000 and $120K and 6 people")).toEqual([]);
  });

  it("allows KPIs the spec computes and their formatted values", () => {
    // sum arrCents = 54,000,000 cents = $540,000 ($540K); avg people = 5
    expect(traceable("$540,000 total, $540K, an average of 5 people")).toEqual([]);
  });

  it("allows chart aggregates, row counts, distinct counts, and numbers from the prompt", () => {
    // 6 signals in the week (pivot sum), 3 needs, 2 themes, top 10
    expect(traceable("4 Reporting signals that week across 3 needs in 2 themes; top 10")).toEqual(
      [],
    );
  });

  it("flags numbers not in any of them", () => {
    expect(traceable("$700,000 and 17 people")).toEqual(["$700,000", "17"]);
  });
});
