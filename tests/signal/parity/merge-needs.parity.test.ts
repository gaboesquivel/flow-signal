import assert from "node:assert/strict";

import { mergeNeeds } from "../../../lib/signal/operations/merge-needs";
import { buildTriageFixture } from "../support/triage-fixture";
import { runParityTable } from "./harness";

runParityTable({
  cases: [
    {
      check: (output, f) => {
        const result = output as {
          fromNeedId: string;
          intoNeedId: string;
          movedSignalIds: string[];
        };
        assert.equal(result.fromNeedId, f.draft.need.id);
        assert.equal(result.intoNeedId, f.n1.need.id);
        assert.deepEqual(result.movedSignalIds, [f.draft.signals[0]!.id]);
      },
      input: (f) => ({ id: f.draft.need.id, intoNeedId: f.n1.need.id }),
      name: "merges a duplicate into the live need",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (f) => ({ id: f.merged.need.id, intoNeedId: f.n1.need.id }),
      name: "returns conflict when the need is already merged",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (f) => ({ id: f.n1.need.id, intoNeedId: f.merged.need.id }),
      name: "returns conflict when the target is merged",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (f) => ({ id: f.n1.need.id, intoNeedId: f.n1.need.id }),
      name: "rejects merging a need into itself",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: (f) => ({ id: "00000000-0000-4000-8000-000000000000", intoNeedId: f.n1.need.id }),
      name: "returns not_found for an unknown need",
    },
  ],
  fixture: buildTriageFixture,
  mutates: true,
  operation: mergeNeeds,
});
