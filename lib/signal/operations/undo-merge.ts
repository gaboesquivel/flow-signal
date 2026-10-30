import { z } from "zod";

import {
  previewUndoMerge,
  undoMerge as undoMergeInDb,
  undoMergeResultSchema,
} from "../domain/merges";
import { scheduleReadinessCheck } from "../domain/readiness";
import { defineOperation } from "./types";

export const undoMerge = defineOperation({
  access: "operator",
  description:
    "Undo a merge by `mergeId` (`id`): the signals it moved go back to the original need, which gets its previous status again. Returns `conflict` if the merge was already undone or the need it merged into has since been merged elsewhere (undo that merge first).",
  effects: "write",
  errors: ["not_found", "conflict"],
  http: { method: "POST", path: "/api/operator/merges/:id/undo" },
  input: z.object({ id: z.uuid() }),
  name: "undo_merge",
  output: undoMergeResultSchema,
  async preview({ id }, { db }) {
    const effect = await previewUndoMerge(db, id);
    return {
      blocks: [],
      editable: [],
      lines: [
        { label: "Merged on", value: effect.merge.createdAt.toISOString().slice(0, 10) },
        { label: "Signals returning", value: String(effect.signalsReturning) },
        { label: "Status restored", value: effect.status },
      ],
      needs: [
        { id: effect.from.id, role: "source", statement: effect.from.statement },
        { id: effect.into.id, role: "target", statement: effect.into.statement },
      ],
      notes: [],
      title: "Undo a merge",
    };
  },
  async run({ id }, { actor, ai, clock, db }) {
    const result = await db.transaction((tx) =>
      undoMergeInDb(tx, { actor, mergeId: id, now: clock.now() }),
    );
    // Spec 007: either need may now meet the readiness line (checked after the response).
    scheduleReadinessCheck({ ai, clock, db }, [result.needId, result.intoNeedId]);
    return result;
  },
});
