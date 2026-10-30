import assert from "node:assert/strict";

import { splitNeed } from "../../../lib/signal/operations/split-need";
import { buildTriageFixture } from "../support/triage-fixture";
import { runParityTable } from "./harness";

const statement = "Admins need single sign-on so that access is managed centrally";

runParityTable({
  cases: [
    {
      check: (output, f) => {
        const result = output as {
          fromNeedId: string;
          movedSignalIds: string[];
          needId: string;
          status: string;
        };
        assert.equal(result.fromNeedId, f.n1.need.id);
        assert.notEqual(result.needId, f.n1.need.id);
        assert.equal(result.status, "open");
        assert.deepEqual(result.movedSignalIds, [f.n1.signals[2]!.id]);
      },
      input: (f) => ({ id: f.n1.need.id, signalIds: [f.n1.signals[2]!.id], statement }),
      name: "moves signals into a new need",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (f) => ({ id: f.n1.need.id, signalIds: f.n1.signals.map((s) => s.id), statement }),
      name: "refuses to move every signal",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (f) => ({ id: f.n1.need.id, signalIds: [f.n2.signals[0]!.id], statement }),
      name: "refuses signals that are not on the need",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (f) => ({ id: f.merged.need.id, signalIds: [f.n1.signals[0]!.id], statement }),
      name: "returns conflict for a merged need",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: (f) => ({
        id: "00000000-0000-4000-8000-000000000000",
        signalIds: [f.n1.signals[0]!.id],
        statement,
      }),
      name: "returns not_found for an unknown need",
    },
  ],
  fixture: buildTriageFixture,
  mutates: true,
  operation: splitNeed,
});
