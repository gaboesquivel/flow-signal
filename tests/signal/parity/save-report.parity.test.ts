import assert from "node:assert/strict";

import { saveReport } from "../../../lib/signal/operations/save-report";
import { buildReportsFixture, reportSpec } from "../support/reports-fixture";
import { runParityTable, runUnauthorizedCheck } from "./harness";

const input = { prompt: "ARR by theme", spec: reportSpec, title: "Weekly demand" };

// Creating and updating re-run the `needs` dataset through `runReportDataset` (spec 013 task 02).
runParityTable({
  cases: [
    {
      check: (output) => {
        const saved = output as { created: boolean; title: string };
        assert.equal(saved.created, true);
        assert.equal(saved.title, "Weekly demand");
      },
      input: () => ({ ...input, idempotencyKey: "parity-save-0001" }),
      name: "creates a report and records report.saved",
    },
    {
      check: (output, f) => {
        const saved = output as { created: boolean; reportId: string };
        assert.equal(saved.created, false);
        assert.equal(saved.reportId, f.shared.id);
      },
      input: (f) => ({ ...input, reportId: f.shared.id, title: "Weekly demand v2" }),
      name: "updates a report in place",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ ...input, reportId: "6f1c2a8e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" }),
      name: "an unknown reportId is not_found",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({
        ...input,
        spec: {
          ...reportSpec,
          blocks: [{ columns: ["nope"], dataset: "d1", kind: "table", title: "Bad column" }],
        },
      }),
      name: "a block naming a missing column is validation_failed",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ ...input, spec: { ...reportSpec, datasets: [] } }),
      name: "a spec with no datasets is validation_failed",
    },
  ],
  fixture: buildReportsFixture,
  mutates: true,
  operation: saveReport,
});

runUnauthorizedCheck(saveReport, input);
