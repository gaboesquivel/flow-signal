import assert from "node:assert/strict";

import { datasetColumns } from "../../../lib/signal/domain/report-datasets";
import type { DatasetResult } from "../../../lib/signal/domain/report-datasets";
import { getReportDataset } from "../../../lib/signal/operations/get-report-dataset";
import { buildPrioritizationFixture } from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";
import { runParityTable } from "./harness";

const rows = (output: unknown) => (output as DatasetResult).rows;
const column = (output: unknown, key: string) => rows(output).map((row) => row[key]);

runParityTable<PrioritizationFixture>({
  cases: [
    {
      check: (output, fx) => {
        assert.deepEqual((output as DatasetResult).columns, datasetColumns.needs);
        assert.equal((output as DatasetResult).truncated, false);
        assert.deepEqual(column(output, "needId").slice(0, 3), [
          fx.n1.need.id,
          fx.n2.need.id,
          fx.n3.need.id,
        ]);
        assert.ok(!column(output, "needId").includes(fx.merged.need.id));
        assert.deepEqual(rows(output)[0], {
          accounts: 2,
          arrCents: 54_000_000,
          createdAt: fx.n1.need.createdAt.toISOString(),
          decidedAt: null,
          needId: fx.n1.need.id,
          openDealCents: 12_000_000,
          people: 6,
          readyAt: null,
          score: 4.1,
          statement: fx.n1.need.statement,
          status: "open",
          theme: "Reporting",
          trend: "rising",
        });
        assert.ok(!JSON.stringify(output).includes("maya@acme.example"));
        assert.ok(!JSON.stringify(output).includes("Maya Lindqvist"));
      },
      input: () => ({ name: "needs" }),
      name: "lists live needs by priority, merged-away excluded",
    },
    {
      check: (output, fx) =>
        assert.deepEqual(column(output, "needId"), [fx.n1.need.id, fx.n2.need.id]),
      input: () => ({ includeDecided: false, name: "needs", plan: "Enterprise" }),
      name: "filters needs by plan and includeDecided",
    },
    {
      check: (output, fx) =>
        assert.deepEqual(
          column(output, "needId").toSorted(),
          [fx.declined.need.id, fx.outage.need.id].toSorted(),
        ),
      input: () => ({ name: "needs", status: "declined,shipped" }),
      name: "filters needs by comma-separated status",
    },
    {
      check: (output) => {
        assert.deepEqual(new Set(column(output, "group")), new Set(["Reporting"]));
        assert.deepEqual([...new Set(column(output, "weekStart"))], ["2026-10-05", "2026-10-12"]);
      },
      input: () => ({
        groupBy: "theme",
        name: "signals_weekly",
        since: "2026-10-05",
        until: "2026-10-19",
      }),
      name: "groups signals per week by theme",
    },
    {
      check: (output, fx) => assert.deepEqual(column(output, "accountId"), [fx.globex.id]),
      input: () => ({ name: "accounts", plan: "Growth" }),
      name: "filters accounts by plan",
    },
    {
      check: (output) => assert.deepEqual(rows(output), []),
      input: (fx) => ({ name: "decisions", themeId: fx.reporting.id }),
      name: "lists decisions (none here)",
    },
    {
      check: (output) => {
        assert.equal(rows(output).length, 13);
        assert.deepEqual(rows(output).at(-1), {
          attachedExisting: 0,
          mergedLater: 0,
          preventionRate: null,
          signals: 0,
          weekStart: "2026-10-26",
        });
      },
      input: () => ({ actor: "human", name: "metrics_weekly" }),
      name: "returns the weekly metrics series",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ groupBy: "theme", name: "needs" }),
      name: "rejects a param that does not apply to the dataset",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ name: "nps" }),
      name: "rejects an unknown dataset",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ name: "needs", status: "merged" }),
      name: "rejects merged as a status",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ name: "decisions", since: "2026-10-30", until: "2026-10-01" }),
      name: "rejects an empty window",
    },
  ],
  fixture: buildPrioritizationFixture,
  operation: getReportDataset,
});
