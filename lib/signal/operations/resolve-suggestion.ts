import { z } from "zod";

import {
  MAX_REJECT_REASON_LENGTH,
  resolveSuggestion as resolveSuggestionInDb,
  resolutionSchema,
} from "../domain/suggestions";
import { defineOperation } from "./types";

export const resolveSuggestion = defineOperation({
  access: "operator",
  description:
    "Resolve a pending AI suggestion by id: `accept` applies it as proposed, `edit` applies it with your changes in `edit`, `reject` discards it, optionally with a short `reason` (up to 500 characters; kept for review, never shown publicly). Edits by kind: draft_need `{ statement }`, merge `{ intoNeedId }`, theme `{ themeId }` or `{ themeName, themeDescription? }`, public_summary `{ summary }`, split `{ statement, signalIds? }`; priority and decision_brief kinds define their own. Accepting a merge or split performs it; accepting a public summary makes it public. Returns `conflict` if the suggestion was already resolved or its need changed (for example, merged).",
  effects: "write",
  errors: ["not_found", "conflict"],
  http: { method: "POST", path: "/api/operator/suggestions/:id/resolve" },
  input: z.object({
    action: z.enum(["accept", "edit", "reject"]),
    /** Required with `action: edit`; the fields to change, by suggestion kind. */
    edit: z.record(z.string(), z.unknown()).optional(),
    id: z.uuid(),
    /** Only with `action: reject`: why, in a few words. Recorded on the rejection event. */
    reason: z.string().max(MAX_REJECT_REASON_LENGTH).optional(),
  }),
  name: "resolve_suggestion",
  output: resolutionSchema,
  run({ action, edit, id, reason }, ctx) {
    return resolveSuggestionInDb(ctx, { action, edit, id, reason });
  },
});
