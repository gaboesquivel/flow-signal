import { z } from "zod";

import { undoMerge as undoMergeInDb, undoMergeResultSchema } from "../domain/merges";
import { defineOperation } from "./types";

export const undoMerge = defineOperation({
  access: "operator",
  description:
    "Undo a merge by `mergeId` (`id`): the signals it moved go back to the original need, which gets its previous status again. Returns `conflict` if the merge was already undone or the need it merged into has since been merged elsewhere (undo that merge first).",
  errors: ["not_found", "conflict"],
  http: { method: "POST", path: "/api/operator/merges/:id/undo" },
  input: z.object({ id: z.uuid() }),
  name: "undo_merge",
  output: undoMergeResultSchema,
  run({ id }, { actor, clock, db }) {
    return db.transaction((tx) => undoMergeInDb(tx, { actor, mergeId: id, now: clock.now() }));
  },
});
