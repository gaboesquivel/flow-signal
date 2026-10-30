import assert from "node:assert/strict";

import { draftDecisionBrief } from "../../../lib/signal/operations/draft-decision-brief";
import { buildPrioritizationFixture } from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";
import { runParityTable } from "./harness";

interface BriefOutput {
  suggestion: {
    kind: string;
    needId: string;
    payload: { facts: { businessValueCents: number; supporters: number }; markdown: string };
    status: string;
  };
}

runParityTable<PrioritizationFixture>({
  cases: [
    {
      check: (output, fx) => {
        const { suggestion } = output as BriefOutput;
        assert.equal(suggestion.kind, "decision_brief");
        assert.equal(suggestion.status, "pending");
        assert.equal(suggestion.needId, fx.n1.need.id);
        assert.equal(suggestion.payload.facts.supporters, 6);
        assert.equal(suggestion.payload.facts.businessValueCents, 66_000_000);
        for (const part of [
          "## Demand",
          "Acme Corp (Enterprise)",
          "$660,000",
          "## Options",
          "Targeting Q1",
        ])
          assert.ok(suggestion.payload.markdown.includes(part), `brief lacks ${part}`);
      },
      input: (fx) => ({ id: fx.n1.need.id }),
      name: "files a pending decision_brief suggestion with demand, accounts, value, and options",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ id: "00000000-0000-4000-8000-000000000000" }),
      name: "returns not_found for an unknown need",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (fx) => ({ id: fx.merged.need.id }),
      name: "returns conflict for a merged need",
    },
    {
      expect: () => ({ error: "ai_unavailable" }),
      input: (fx) => ({ id: fx.outage.need.id }),
      name: "returns ai_unavailable and writes nothing when the model is unreachable",
    },
  ],
  fixture: buildPrioritizationFixture,
  mutates: true,
  operation: draftDecisionBrief,
});
