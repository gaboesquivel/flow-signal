import assert from "node:assert/strict";

import { getSharedReport } from "../../../lib/signal/operations/get-shared-report";
import {
  buildReportsFixture,
  reportSpec,
  SHARE_TOKEN,
  snapshotData,
} from "../support/reports-fixture";
import { runParityTable } from "./harness";

runParityTable({
  cases: [
    {
      expect: () => ({
        output: {
          data: snapshotData,
          snapshotAt: "2026-10-03T09:00:00.000Z",
          spec: reportSpec,
          title: "Weekly demand",
        },
      }),
      input: () => ({ token: SHARE_TOKEN }),
      name: "returns the stored snapshot, not live data",
    },
    {
      check: (output) => {
        assert.deepEqual(Object.keys(output as object).toSorted(), [
          "data",
          "snapshotAt",
          "spec",
          "title",
        ]);
        assert.ok(!JSON.stringify(output).includes(SHARE_TOKEN), "no token echoed");
      },
      input: () => ({ token: SHARE_TOKEN }),
      name: "shows only the snapshot fields",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ token: "unknown-report-token-0000000000000000000001" }),
      name: "an unknown token is not_found",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ token: "short" }),
      name: "a malformed token is not_found",
    },
  ],
  fixture: buildReportsFixture,
  operation: getSharedReport,
});
