import assert from "node:assert/strict";

import { getReport } from "../../../lib/signal/operations/get-report";
import { buildReportsFixture, reportSpec, SHARE_TOKEN } from "../support/reports-fixture";
import { runParityTable, runUnauthorizedCheck } from "./harness";

interface Opened {
  data: { d1: { rows: { statement: string }[] } };
  share: { path: string; sharedAt: string; snapshotAt: string } | null;
  spec: unknown;
  title: string;
}

// Opening a report re-runs the `needs` dataset through `runReportDataset` (spec 013 task 02).
runParityTable({
  cases: [
    {
      check: (output) => {
        const opened = output as Opened;
        assert.equal(opened.title, "Weekly demand");
        assert.deepEqual(opened.spec, reportSpec);
        assert.deepEqual(opened.share, {
          path: `/r/${SHARE_TOKEN}`,
          sharedAt: "2026-10-03T09:00:00.000Z",
          snapshotAt: "2026-10-03T09:00:00.000Z",
        });
        // Live data, not the stored snapshot.
        assert.ok(!opened.data.d1.rows.some((row) => row.statement === "Snapshot need"));
      },
      input: (f) => ({ reportId: f.shared.id }),
      name: "re-runs the queries now and shows the live link",
    },
    {
      check: (output) => assert.equal((output as Opened).share, null),
      input: (f) => ({ reportId: f.revoked.id }),
      name: "a report without a live link has share null",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ reportId: "6f1c2a8e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" }),
      name: "an unknown report is not_found",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ reportId: "not-a-uuid" }),
      name: "a malformed id is validation_failed",
    },
  ],
  fixture: buildReportsFixture,
  mutates: true,
  operation: getReport,
});

runUnauthorizedCheck(getReport, { reportId: "6f1c2a8e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" });
