import { z } from "zod";

import { embedNeedsQuietly } from "../domain/embeddings";
import { previewSplit, splitNeed as splitNeedInDb, splitResultSchema } from "../domain/splits";
import { defineOperation } from "./types";

export const splitNeed = defineOperation({
  access: "operator",
  description:
    "Split signals out of a need (`id`) into a new need with the given `statement` (\"who needs to do what so that outcome\"). The listed `signalIds` (at least one, and not all of the need's signals) move to the new need with their verbatim text and the proposed solutions they named; nothing is deleted. Returns the new need's id.",
  effects: "write",
  errors: ["not_found", "conflict"],
  http: { method: "POST", path: "/api/operator/needs/:id/split" },
  input: z.object({
    id: z.uuid(),
    signalIds: z.array(z.uuid()).min(1).max(500),
    statement: z.string().trim().min(10).max(500),
  }),
  name: "split_need",
  output: splitResultSchema,
  async preview({ id, signalIds, statement }, { db }) {
    const effect = await previewSplit(db, { needId: id, signalIds, statement });
    return {
      blocks: [],
      editable: [{ key: "statement", kind: "text", label: "New need statement" }],
      lines: [
        { label: "Signals leaving", value: String(effect.leaving) },
        { label: "Signals staying", value: String(effect.staying) },
        { label: "New statement", value: effect.statement },
        { label: "New need status", value: effect.status },
      ],
      needs: [{ id: effect.source.id, role: "subject", statement: effect.source.statement }],
      notes: [],
      title: "Split a need",
    };
  },
  async run({ id, signalIds, statement }, { actor, ai, clock, db }) {
    const result = await db.transaction((tx) =>
      splitNeedInDb(tx, { actor, needId: id, now: clock.now(), signalIds, statement }),
    );
    await embedNeedsQuietly(db, ai.embedder, [result.needId]);
    return result;
  },
});
