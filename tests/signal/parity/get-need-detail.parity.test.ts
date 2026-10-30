import assert from "node:assert/strict";

import { getNeedDetail } from "../../../lib/signal/operations/get-need-detail";
import { buildTriageFixture } from "../support/triage-fixture";
import { runParityTable } from "./harness";

interface Detail {
  accounts: { arrCents: number; id: string; name: string; supporters: number }[];
  id: string;
  mergedIntoId: string | null;
  priorityScore: number | null;
  publicSummaryStatus: string;
  scores: { criterion: string; score: number; source: string }[];
  signals: {
    body: string;
    submitter: { email: string; name: string | null };
    account: { name: string } | null;
  }[];
  status: string;
  suggestions: { id: string }[];
  supporterCount: number;
  theme: { name: string } | null;
}

runParityTable({
  cases: [
    {
      check: (output, f) => {
        const detail = output as Detail;
        assert.equal(detail.id, f.n1.need.id);
        assert.equal(detail.status, "open");
        assert.equal(detail.theme?.name, "Reporting");
        assert.equal(detail.supporterCount, 3);
        assert.equal(detail.signals.length, 3);
        const maya = detail.signals.find((s) => s.submitter.email === "maya@acme.example");
        assert.equal(maya?.body, "Our CFO pastes dashboard screenshots into the board pack.");
        assert.equal(maya?.account?.name, "Acme Corp");
        assert.deepEqual(detail.accounts, [
          {
            arrCents: 48_000_000,
            id: f.acme.id,
            name: "Acme Corp",
            openDealCents: 1_200_000,
            plan: "Enterprise",
            supporters: 1,
          },
        ]);
        assert.deepEqual(
          detail.scores.map((s) => [s.criterion, s.score, s.source]),
          [
            ["demand", 5, "ai"],
            ["business_value", 4, "ai"],
          ],
        );
        assert.equal(detail.priorityScore, 3.2);
        assert.deepEqual(
          detail.suggestions.map((s) => s.id).toSorted(),
          [
            f.suggestions.merge.id,
            f.suggestions.split.id,
            f.suggestions.summary.id,
            f.suggestions.rejected.id,
          ].toSorted(),
        );
      },
      input: (f) => ({ id: f.n1.need.id }),
      name: "returns verbatim signals, accounts, scores, and suggestions",
    },
    {
      check: (output, f) => {
        const detail = output as Detail;
        assert.equal(detail.status, "merged");
        assert.equal(detail.mergedIntoId, f.n2.need.id);
      },
      input: (f) => ({ id: f.merged.need.id }),
      name: "shows a merged-away need and where it went",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ id: "00000000-0000-4000-8000-000000000000" }),
      name: "returns not_found for an unknown need",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ id: "n1" }),
      name: "rejects a malformed id",
    },
  ],
  fixture: buildTriageFixture,
  operation: getNeedDetail,
});
