import assert from "node:assert/strict";

import type { SignalDb } from "../../../lib/signal/db";
import { mergeNeeds, undoMerge as undoMergeInDb } from "../../../lib/signal/domain/merges";
import { undoMerge } from "../../../lib/signal/operations/undo-merge";
import { buildTriageFixture } from "../support/triage-fixture";
import { runParityTable } from "./harness";

const pm = { kind: "human", ref: "operator" } as const;

const fixture = async (db: SignalDb) => {
  const base = await buildTriageFixture(db);
  const now = new Date("2026-10-28T10:00:00Z");
  const merge = await db.transaction((tx) =>
    mergeNeeds(tx, { actor: pm, fromNeedId: base.draft.need.id, intoNeedId: base.n1.need.id, now }),
  );
  const undone = await db.transaction(async (tx) => {
    const result = await mergeNeeds(tx, {
      actor: pm,
      fromNeedId: base.n2.need.id,
      intoNeedId: base.n1.need.id,
      now,
    });
    await undoMergeInDb(tx, { actor: pm, mergeId: result.mergeId, now });
    return result;
  });
  return { ...base, merge, undone };
};

runParityTable({
  cases: [
    {
      check: (output, f) => {
        const result = output as { needId: string; restoredSignalIds: string[]; status: string };
        assert.equal(result.needId, f.draft.need.id);
        assert.equal(result.status, "draft");
        assert.deepEqual(result.restoredSignalIds, [f.draft.signals[0]!.id]);
      },
      input: (f) => ({ id: f.merge.mergeId }),
      name: "restores the signals and the previous status",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (f) => ({ id: f.undone.mergeId }),
      name: "returns conflict for a merge already undone",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ id: "00000000-0000-4000-8000-000000000000" }),
      name: "returns not_found for an unknown merge",
    },
  ],
  fixture,
  mutates: true,
  operation: undoMerge,
});
