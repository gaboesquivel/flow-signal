import { z } from "zod";

import { mergeNeeds as mergeNeedsInDb, mergeResultSchema } from "../domain/merges";
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
  run({ id, intoNeedId }, { actor, clock, db }) {
    return db.transaction((tx) =>
      mergeNeedsInDb(tx, { actor, fromNeedId: id, intoNeedId, now: clock.now() }),
    );
  },
});
