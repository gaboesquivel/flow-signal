import assert from "node:assert/strict";

import { shareReport } from "../../../lib/signal/operations/share-report";
import { buildReportsFixture } from "../support/reports-fixture";
import { runParityTable, runUnauthorizedCheck } from "./harness";

// Share and refresh re-run the `needs` dataset through `runReportDataset` (spec 013 task 02);
// revoke and the error cases do not.
runParityTable({
  cases: [
    {
      expect: () => ({ output: { status: "revoked" } }),
      input: (f) => ({ action: "revoke", reportId: f.shared.id }),
      name: "revokes a live link",
    },
    {
      check: (output, f) => {
        const shared = output as { path: string; status: string };
        assert.equal(shared.status, "shared");
        assert.equal(shared.path, `/r/${f.shared.shareToken}`);
      },
      input: (f) => ({ acknowledgeFlags: true, action: "refresh", reportId: f.shared.id }),
      name: "refresh keeps the token and stores a new snapshot",
    },
    {
      check: (output) => {
        const shared = output as { path: string; status: string };
        assert.equal(shared.status, "shared");
        assert.match(shared.path, /^\/r\/[\w-]{43}$/u);
      },
      input: (f) => ({ acknowledgeFlags: true, action: "share", reportId: f.revoked.id }),
      name: "shares a report with a new token",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ action: "share", reportId: "6f1c2a8e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" }),
      name: "an unknown report is not_found",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (f) => ({ action: "publish", reportId: f.shared.id }),
      name: "an unknown action is validation_failed",
    },
  ],
  fixture: buildReportsFixture,
  mutates: true,
  operation: shareReport,
});

runUnauthorizedCheck(shareReport, {
  action: "revoke",
  reportId: "6f1c2a8e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
});
