import assert from "node:assert/strict";

import { publishDecision } from "../../../lib/signal/operations/publish-decision";
import { buildPrioritizationFixture } from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";
import { runParityTable } from "./harness";

runParityTable<PrioritizationFixture>({
  cases: [
    {
      check: (output, fx) => {
        const { decision } = output as { decision: Record<string, unknown> };
        assert.deepEqual(
          { ...decision, id: "<id>" },
          {
            briefMarkdown: null,
            id: "<id>",
            needId: fx.n1.need.id,
            note: "Targeting Q1",
            publishedAt: "2026-10-30T09:00:00.000Z",
            publishedByKind: "agent",
            status: "planned",
          },
        );
      },
      input: (fx) => ({ id: fx.n1.need.id, note: "Targeting Q1", status: "planned" }),
      name: "publishes a decision attributed to the publisher",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ id: "00000000-0000-4000-8000-000000000000", note: "x", status: "planned" }),
      name: "returns not_found for an unknown need",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (fx) => ({ id: fx.merged.need.id, note: "x", status: "planned" }),
      name: "returns conflict for a merged need",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (fx) => ({ id: fx.n1.need.id, note: "x", status: "merged" }),
      name: "rejects a status that is not a decision",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (fx) => ({ id: fx.n1.need.id, note: "   ", status: "planned" }),
      name: "rejects an empty note",
    },
  ],
  fixture: buildPrioritizationFixture,
  mutates: true,
  operation: publishDecision,
});
