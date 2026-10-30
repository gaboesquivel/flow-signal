import assert from "node:assert/strict";

import { createFakeAi, fakeReasoner } from "../../../lib/signal/ai/fakes";
import type { SignalDb } from "../../../lib/signal/db";
import { embedNeeds } from "../../../lib/signal/domain/embeddings";
import { sweepDuplicates } from "../../../lib/signal/operations/sweep-duplicates";
import { configureSignalRuntime } from "../../../lib/signal/runtime";
import { insertNeed } from "../support/builders";
import { runParityTable } from "./harness";

const NOW = new Date("2026-10-30T09:00:00Z");

/** Spec 009: one recent draft that duplicates N1, and the merge judge picks the first candidate. */
const fixture = async (db: SignalDb) => {
  const ai = createFakeAi({
    reasoner: fakeReasoner({
      merge: ({ prompt }) => ({
        candidate: prompt.includes("Executives need to share") ? 1 : null,
        reason: "Same board-meeting outcome.",
      }),
    }),
  });
  configureSignalRuntime({ ai, clock: { now: () => NOW } });
  const n1 = await insertNeed(db, {
    signals: [{}],
    statement:
      "Executives need to share dashboard snapshots so that board meetings use current numbers",
  });
  const draft = await insertNeed(db, {
    approvedAt: null,
    createdAt: new Date("2026-10-29T09:00:00Z"),
    signals: [{ attachedTo: "draft" }],
    statement: "Executives need dashboard snapshots so that board meetings use current numbers",
    status: "draft",
  });
  await embedNeeds(db, ai.embedder, [n1.need.id, draft.need.id]);
  return { draft, n1 };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

runParityTable<Fixture>({
  cases: [
    {
      check: (output, f) => {
        const result = output as {
          checked: { needId: string; proposed: { intoNeedId: string }[] }[];
          examined: number;
          unavailable: number;
        };
        assert.equal(result.examined, 1);
        assert.equal(result.unavailable, 0);
        assert.equal(result.checked[0]!.needId, f.draft.need.id);
        assert.deepEqual(
          result.checked[0]!.proposed.map((p) => p.intoNeedId),
          [f.n1.need.id],
        );
      },
      events: () => ["suggestion.created"],
      input: () => ({}),
      name: "checks the due draft and proposes its merge",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ checks: 0 }),
      name: "rejects a check budget below 1",
    },
  ],
  fixture,
  mutates: true,
  operation: sweepDuplicates,
});
