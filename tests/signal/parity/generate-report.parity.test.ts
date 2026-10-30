import assert from "node:assert/strict";

import { createFakeAi, fakeReasoner } from "../../../lib/signal/ai/fakes";
import type { SignalDb } from "../../../lib/signal/db";
import { SignalError } from "../../../lib/signal/errors";
import { generateReport } from "../../../lib/signal/operations/generate-report";
import { configureSignalRuntime } from "../../../lib/signal/runtime";
import { insertTheme } from "../support/builders";
import { runParityTable } from "./harness";
import { toModelCompose } from "../support/report-compose";

const NOW = new Date("2026-10-30T09:00:00Z");
const OUTAGE = "OUTAGE";
const NO_DATASET = "NPS by region";

/** Plans `needs` (or an unknown dataset for NO_DATASET); composes a heading, a KPI, a table. */
const reportAi = () =>
  createFakeAi({
    reasoner: fakeReasoner({
      report_compose: () =>
        toModelCompose({
          blocks: [
            { kind: "heading", text: "Demand" },
            {
              items: [{ aggregate: "count", column: "needId", dataset: "d1", label: "Live needs" }],
              kind: "kpi",
            },
            {
              columns: ["statement", "people", "arrCents"],
              dataset: "d1",
              kind: "table",
              limit: 10,
              sort: { column: "arrCents", direction: "desc" },
              title: "Top needs",
            },
          ],
          title: "Demand by need",
        }),
      report_plan: ({ prompt }) => {
        if (prompt.includes(OUTAGE)) throw new SignalError("ai_unavailable", "Model down.");
        if (prompt.includes(NO_DATASET))
          return { datasets: [{ id: "d1", name: "nps", params: {} }], gaps: ["NPS"] };
        return { datasets: [{ id: "d1", name: "needs", params: {} }], gaps: [] };
      },
    }),
  });

const fixture = async (db: SignalDb) => {
  configureSignalRuntime({ ai: reportAi(), clock: { now: () => NOW } });
  const reporting = await insertTheme(db, { name: "Reporting" });
  return { reporting };
};

interface GenerateOutput {
  asOf: string;
  data: Record<string, { rows: unknown[] }>;
  report: { blocks: { kind: string }[]; datasets: { id: string; name: string }[]; version: 1 };
  warnings: string[];
}

runParityTable({
  cases: [
    {
      // Runs `needs` on an empty workspace; needs runReportDataset (spec 013 task 02).
      check: (output) => {
        const { asOf, data, report, warnings } = output as GenerateOutput;
        assert.equal(asOf, NOW.toISOString());
        assert.equal(report.version, 1);
        assert.deepEqual(report.datasets, [{ id: "d1", name: "needs", params: {} }]);
        assert.deepEqual(
          report.blocks.map((block) => block.kind),
          ["heading", "kpi", "table"],
        );
        assert.deepEqual(data.d1?.rows, []);
        assert.deepEqual(warnings, []);
      },
      input: () => ({ prompt: "Top needs by ARR" }),
      name: "plans, runs, and composes a report from the needs dataset",
    },
    {
      expect: () => ({ error: "ai_unavailable" }),
      input: () => ({ prompt: `${OUTAGE}: demand by theme` }),
      name: "returns ai_unavailable when the model is unreachable",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ prompt: NO_DATASET }),
      name: "returns validation_failed when no planned dataset is valid",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ prompt: "" }),
      name: "returns validation_failed for an empty prompt",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({
        prior: { blocks: [], datasets: [], title: "Bad", version: 2 },
        prompt: "make it weekly",
      }),
      name: "returns validation_failed for an invalid prior spec",
    },
  ],
  fixture,
  operation: generateReport,
});
