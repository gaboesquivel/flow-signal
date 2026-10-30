import { z } from "zod";

import { mergeNeeds as mergeNeedsInDb, mergeResultSchema } from "../domain/merges";
import { scheduleReadinessCheck } from "../domain/readiness";
import { defineOperation } from "./types";

export const mergeNeeds = defineOperation({
  access: "operator",
  description:
    "Merge one need (`id`) into another (`intoNeedId`): every signal on `id` moves to `intoNeedId` with its verbatim text, `id` becomes `status: merged`, and its proposed solutions follow their signals. Nothing is deleted and the merge can be reverted with `undo_merge` using the returned `mergeId`. Returns `conflict` if either need is already merged.",
  effects: "write",
  errors: ["not_found", "conflict"],
  http: { method: "POST", path: "/api/operator/needs/:id/merge" },
  input: z.object({
    /** The need merged away (the duplicate). */
    id: z.uuid(),
    /** The need that keeps the signals. */
    intoNeedId: z.uuid(),
  }),
  name: "merge_needs",
  output: mergeResultSchema,
  async run({ id, intoNeedId }, { actor, ai, clock, db }) {
    const result = await db.transaction((tx) =>
      mergeNeedsInDb(tx, { actor, fromNeedId: id, intoNeedId, now: clock.now() }),
    );
    // Spec 007: readiness moves to the surviving need if it now meets the line (after the response).
    scheduleReadinessCheck({ ai, clock, db }, [result.intoNeedId]);
    return result;
  },
});
