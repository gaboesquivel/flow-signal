import { describe, expect, it } from "vitest";

import { datasetColumns, datasetQuerySchema } from "../../../lib/signal/domain/report-datasets";
import type { DatasetResult } from "../../../lib/signal/domain/report-datasets";
import {
  applyBlockData,
  computeKpi,
  formatValue,
  reportSpecSchema,
  validateReportSpec,
} from "../../../lib/signal/domain/report-spec";
import type { ChartBlock, ReportSpec } from "../../../lib/signal/domain/report-spec";

const spec = (blocks: ReportSpec["blocks"]): ReportSpec =>
  reportSpecSchema.parse({
    blocks,
    datasets: [
      { id: "d1", name: "needs", params: {} },
      { id: "d2", name: "signals_weekly", params: { groupBy: "theme" } },
    ],
    title: "Demand",
    version: 1,
  });

const weekly: DatasetResult = {
  columns: datasetColumns.signals_weekly,
  rows: [
    {
      attachedDraft: 1,
      attachedExisting: 2,
      group: "Reporting",
      signals: 3,
      weekStart: "2026-10-05",
    },
    {
      attachedDraft: 0,
      attachedExisting: 1,
      group: "Integrations",
      signals: 1,
      weekStart: "2026-10-05",
    },
    {
      attachedDraft: 2,
      attachedExisting: 2,
      group: "Reporting",
      signals: 4,
      weekStart: "2026-10-12",
    },
  ],
  truncated: false,
};

describe("report spec validation", () => {
  it("accepts references to declared datasets and existing columns", () => {
    const issues = validateReportSpec(
      spec([
        { kind: "heading", text: "Demand" },
        {
          items: [
            {
              aggregate: "sum",
              column: "arrCents",
              dataset: "d1",
              label: "ARR",
            },
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
        {
          columns: ["statement", "people"],
          dataset: "d1",
          kind: "table",
          title: "Needs",
        },
      ]),
    );
    expect(issues).toEqual([]);
  });

  it("flags an unknown dataset, a missing column, a non-numeric y, and a two-y donut", () => {
    const issues = validateReportSpec(
      spec([
        { columns: ["statement"], dataset: "d9", kind: "table", title: "x" },
        { columns: ["nps"], dataset: "d1", kind: "table", title: "x" },
        {
          chart: "bar",
          dataset: "d1",
          kind: "chart",
          title: "x",
          x: "theme",
          y: ["statement"],
        },
        {
          chart: "donut",
          dataset: "d1",
          kind: "chart",
          title: "x",
          x: "theme",
          y: ["people", "accounts"],
        },
      ]),
    );
    expect(issues.map((issue) => issue.block)).toEqual([0, 1, 2, 3]);
    expect(issues[0]?.message).toContain('Unknown dataset "d9"');
    expect(issues[1]?.message).toContain('no column "nps"');
    expect(issues[2]?.message).toContain("must be number");
    expect(issues[3]?.message).toContain("exactly one y");
  });

  it("allows count on a string column but requires numbers for other aggregates", () => {
    const issues = validateReportSpec(
      spec([
        {
          items: [
            {
              aggregate: "count",
              column: "statement",
              dataset: "d1",
              label: "Needs",
            },
            { aggregate: "sum", column: "theme", dataset: "d1", label: "Bad" },
          ],
          kind: "kpi",
        },
      ]),
    );
    expect(issues).toHaveLength(1);
  });

  it("rejects too many blocks and invalid dataset params at parse time", () => {
    const tooMany = Array.from({ length: 21 }, () => ({
      kind: "heading" as const,
      text: "x",
    }));
    expect(() => spec(tooMany)).toThrow();
    expect(
      datasetQuerySchema.safeParse({
        id: "d1",
        name: "signals_weekly",
        params: { groupBy: "region" },
      }).success,
    ).toBe(false);
    expect(
      datasetQuerySchema.safeParse({
        id: "d1",
        name: "needs",
        params: { sql: "select 1" },
      }).success,
    ).toBe(false);
  });
});

describe("applyBlockData", () => {
  it("pivots seriesBy into one row per x with a zero for missing groups", () => {
    const block: ChartBlock = {
      chart: "area",
      dataset: "d2",
      kind: "chart",
      seriesBy: "group",
      stacked: true,
      title: "Signals by theme",
      x: "weekStart",
      y: ["signals"],
    };
    const { rows, series } = applyBlockData(block, weekly);
    expect(series.map((entry) => entry.label)).toEqual(["Reporting", "Integrations"]);
    expect(rows).toEqual([
      { s_Integrations: 1, s_Reporting: 3, weekStart: "2026-10-05" },
      { s_Integrations: 0, s_Reporting: 4, weekStart: "2026-10-12" },
    ]);
  });

  it("sorts with nulls last and applies the limit", () => {
    const result: DatasetResult = {
      columns: datasetColumns.needs,
      rows: [
        { people: 2, statement: "a" },
        { people: null, statement: "b" },
        { people: 5, statement: "c" },
      ],
      truncated: false,
    };
    const { rows } = applyBlockData(
      {
        columns: ["statement", "people"],
        dataset: "d1",
        kind: "table",
        limit: 2,
        sort: { column: "people", direction: "desc" },
        title: "Top",
      },
      result,
    );
    expect(rows.map((row) => row.statement)).toEqual(["c", "a"]);
  });
});

const item = (aggregate: "sum" | "avg" | "median" | "count" | "max" | "latest") => ({
  aggregate,
  column: "arrCents",
  dataset: "d1",
  label: "ARR",
});

describe("computeKpi and formatValue", () => {
  const result: DatasetResult = {
    columns: datasetColumns.needs,
    rows: [{ arrCents: 100_000 }, { arrCents: 300_000 }, { arrCents: null }, { arrCents: 200_000 }],
    truncated: false,
  };
  it("aggregates numbers and skips nulls", () => {
    expect(computeKpi(item("sum"), result)).toBe(600_000);
    expect(computeKpi(item("avg"), result)).toBe(200_000);
    expect(computeKpi(item("median"), result)).toBe(200_000);
    expect(computeKpi(item("count"), result)).toBe(3);
    expect(computeKpi(item("max"), result)).toBe(300_000);
    expect(computeKpi(item("latest"), result)).toBe(200_000);
    expect(computeKpi(item("sum"), { ...result, rows: [] })).toBeNull();
  });

  it("formats cents, percents, and dates", () => {
    expect(formatValue(600_000, { type: "number", unit: "cents" })).toBe("$6,000");
    expect(formatValue(125_000_000, { type: "number", unit: "cents" })).toBe("$1.3M");
    expect(formatValue(0.425, { type: "number", unit: "percent" })).toBe("42.5%");
    expect(formatValue("2026-10-05T00:00:00.000Z", { type: "date" })).toBe("2026-10-05");
    expect(formatValue(null)).toBe("—");
  });
});
