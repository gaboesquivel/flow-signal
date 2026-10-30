import { z } from "zod";

import {
  listSuggestions as listSuggestionsInDb,
  suggestionKinds,
  suggestionStatuses,
  suggestionViewSchema,
} from "../domain/suggestions";
import { decodeOffsetCursor, encodeOffsetCursor } from "../domain/cursor";
import { defineOperation } from "./types";

export const listSuggestionsInput = z.object({
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor: z
    .string()
    .max(200)
    .refine((cursor) => decodeOffsetCursor(cursor) !== undefined, "Invalid cursor.")
    .optional(),
  kind: z.enum(suggestionKinds).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Only suggestions about this need (as subject or merge target). */
  needId: z.uuid().optional(),
  /** Defaults to `pending`: the triage queue. */
  status: z.enum(suggestionStatuses).default("pending"),
});

export const listSuggestions = defineOperation({
  access: "operator",
  description:
    "List AI suggestions for PM triage, newest first: draft-need approvals, merges, themes, priority scores, public summaries, splits, and decision briefs. Defaults to `status: pending` (the triage queue); filter by `kind` or `needId`. Each item has the proposal (`payload`), the model's `reason`, and the needs it concerns. Resolve one with `resolve_suggestion`.",
  errors: [],
  http: { method: "GET", path: "/api/operator/suggestions" },
  input: listSuggestionsInput,
  name: "list_suggestions",
  output: z.object({
    nextCursor: z.string().nullable(),
    suggestions: z.array(suggestionViewSchema),
  }),
  async run({ cursor, kind, limit, needId, status }, { db }) {
    const offset = cursor ? (decodeOffsetCursor(cursor) ?? 0) : 0;
    const page = await listSuggestionsInDb(db, { kind, limit, needId, offset, status });
    return {
      nextCursor: page.hasMore ? encodeOffsetCursor(offset + limit) : null,
      suggestions: page.suggestions,
    };
  },
});
