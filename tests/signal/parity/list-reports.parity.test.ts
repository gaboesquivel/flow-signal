import { listReports } from "../../../lib/signal/operations/list-reports";
import { buildReportsFixture } from "../support/reports-fixture";
import { runParityTable, runUnauthorizedCheck } from "./harness";

runParityTable({
  cases: [
    {
      expect: (f) => ({
        output: {
          reports: [
            {
              reportId: f.shared.id,
              sharedAt: "2026-10-03T09:00:00.000Z",
              title: "Weekly demand",
              updatedAt: "2026-10-02T09:00:00.000Z",
            },
            {
              reportId: f.revoked.id,
              sharedAt: null,
              title: "Revoked report",
              updatedAt: "2026-10-01T09:00:00.000Z",
            },
          ],
        },
      }),
      input: () => ({}),
      name: "lists saved reports, most recently updated first",
    },
  ],
  fixture: buildReportsFixture,
  operation: listReports,
});

runUnauthorizedCheck(listReports, {});
