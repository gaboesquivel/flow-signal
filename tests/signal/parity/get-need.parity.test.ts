import assert from "node:assert/strict";

import { getNeed } from "../../../lib/signal/operations/get-need";
import { assertNoPrivateData, buildPublicNeedsFixture } from "../support/public-needs-fixture";
import type { PublicNeedsFixture } from "../support/public-needs-fixture";
import { runParityTable } from "./harness";

runParityTable<PublicNeedsFixture>({
  cases: [
    {
      check: assertNoPrivateData,
      expect: (fx) => ({
        output: {
          createdAt: "2026-08-01T10:00:00.000Z",
          decision: null,
          demandBand: "high",
          id: fx.n1.need.id,
          mergedIntoId: null,
          proposedSolutions: ["PDF export", "Scheduled email digest"],
          publicSummary: "Leaders bring current KPI snapshots into recurring board meetings.",
          statement:
            "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
          status: "open",
          supporterCount: 11,
          theme: { id: fx.reporting.id, name: "Reporting" },
        },
      }),
      input: (fx) => ({ id: fx.n1.need.id }),
      name: "returns the public view of a need",
    },
    {
      check: (output, fx) => {
        assertNoPrivateData(output, fx);
        assert.equal((output as { publicSummary: unknown }).publicSummary, null);
      },
      input: (fx) => ({ id: fx.n2.need.id }),
      name: "hides a use-case summary until a PM approves it",
    },
    {
      check: (output, fx) => {
        const need = output as { mergedIntoId: string; status: string; supporterCount: number };
        assert.equal(need.status, "merged");
        assert.equal(need.mergedIntoId, fx.n1.need.id);
        assert.equal(need.supporterCount, 0);
      },
      input: (fx) => ({ id: fx.merged.need.id }),
      name: "reports a merged need and where it went",
    },
    {
      check: (output) => assert.equal((output as { status: string }).status, "new"),
      input: (fx) => ({ id: fx.draft.need.id }),
      name: "shows a draft need as new",
    },
    {
      check: (output) =>
        assert.deepEqual((output as { decision: unknown }).decision, {
          note: "Shipping in the October release.",
          publishedAt: "2026-09-15T12:00:00.000Z",
          status: "planned",
        }),
      input: (fx) => ({ id: fx.decided.need.id }),
      name: "includes the published decision note",
    },
    {
      check: (output) => {
        const need = output as { demandBand: string; supporterCount: number };
        assert.equal(need.supporterCount, 12);
        assert.equal(need.demandBand, "low");
      },
      input: (fx) => ({ id: fx.scored.need.id }),
      name: "derives the demand band from the priority score when scored",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ id: "4b0e6c1e-8a7d-4f3e-9c2b-1d5a6e7f8a9b" }),
      name: "returns not_found for an unknown id",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ id: "not-a-uuid" }),
      name: "rejects a malformed id",
    },
  ],
  fixture: buildPublicNeedsFixture,
  operation: getNeed,
});
