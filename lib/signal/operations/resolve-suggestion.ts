import { z } from "zod";

import { suggestionEditableText } from "../domain/suggestion-kinds";
import {
  MAX_REJECT_REASON_LENGTH,
  previewResolution,
  resolveSuggestion as resolveSuggestionInDb,
  resolutionSchema,
} from "../domain/suggestions";
import { defineOperation } from "./types";

const resolutionLabel = { accept: "Accept", edit: "Edit and accept", reject: "Reject" } as const;

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
  async preview({ action, edit, id, reason }, { db }) {
    const { effect, filed, rejectReason, suggestion } = await previewResolution(db, {
      action,
      edit,
      id,
      reason,
    });
    const proposal = filed?.text ?? suggestion.reason ?? "";
    const editable = action === "edit" ? suggestionEditableText[suggestion.kind] : undefined;
    const fallbackNeeds = [
      ...(suggestion.need ? [{ ...suggestion.need, role: "subject" as const }] : []),
      ...(suggestion.relatedNeed ? [{ ...suggestion.relatedNeed, role: "target" as const }] : []),
    ].map(({ id: needId, role, statement }) => ({ id: needId, role, statement }));
    return {
      blocks: [],
      editable: editable ? [editable] : [],
      lines: [
        { label: "Kind", value: suggestion.kind },
        { label: "Suggestion", value: proposal },
        { label: "Resolution", value: resolutionLabel[action] },
        ...(action === "edit" && effect ? [{ label: "Applied as", value: effect.text }] : []),
        ...(rejectReason ? [{ label: "Reason", value: rejectReason }] : []),
        ...(effect?.lines ?? []),
      ],
      needs: effect?.needs ?? filed?.needs ?? fallbackNeeds,
      notes: [],
      title: `${resolutionLabel[action]} a ${suggestion.kind.replaceAll("_", " ")} suggestion`,
    };
  },
  run({ action, edit, id, reason }, ctx) {
    return resolveSuggestionInDb(ctx, { action, edit, id, reason });
  },
});
