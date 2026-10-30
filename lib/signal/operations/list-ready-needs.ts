import { z } from "zod";

import { decodeOffsetCursor, encodeOffsetCursor } from "../domain/cursor";
import { listReadyNeeds as listReadyNeedsInDb, readyNeedSchema } from "../domain/readiness";
import { defineOperation } from "./types";

export const listReadyNeeds = defineOperation({
  access: "operator",
  description:
    "List needs that crossed the strategy's readiness line and are still undecided, oldest ready first: the PM's \"ready to decide\" queue. Each item has the need's statement, when it became ready (`readyAt`), its demand now (`arrCents`: distinct supporting accounts' ARR in cents; `supporters`), and its latest decision brief (`brief`: `suggestionId`, `status`, and the model's `recommendation` with status, note, and when present confidence, strategy fit, and capacity note). `brief` is null while the brief is not drafted yet (for example the model was unavailable; it is retried on the next signal or strategy change) — call draft_decision_brief to draft one now. Resolve a pending brief with resolve_suggestion, then publish with publish_decision.",
  errors: [],
  http: { method: "GET", path: "/api/operator/needs/ready" },
  input: z.object({
    /** Opaque cursor from a previous page's `nextCursor`. */
    cursor: z
      .string()
      .max(200)
      .refine((cursor) => decodeOffsetCursor(cursor) !== undefined, "Invalid cursor.")
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }),
  name: "list_ready_needs",
  output: z.object({ needs: z.array(readyNeedSchema), nextCursor: z.string().nullable() }),
  async run({ cursor, limit }, { db }) {
    const offset = cursor ? (decodeOffsetCursor(cursor) ?? 0) : 0;
    const page = await listReadyNeedsInDb(db, { limit, offset });
    return {
      needs: page.needs,
      nextCursor: page.hasMore ? encodeOffsetCursor(offset + limit) : null,
    };
  },
});
