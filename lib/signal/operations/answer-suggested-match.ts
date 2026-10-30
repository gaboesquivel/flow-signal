import { z } from "zod";

import { answerOutputSchema, answerSuggestedMatch as answer } from "../domain/duplicate-backstop";
import { trackingTokenSchema } from "../domain/tracking-links";
import { defineOperation } from "./types";

export const answerSuggestedMatch = defineOperation({
  access: "public",
  description:
    "Answer a suggested match on a submitter's My signals link (spec 009). `get_my_signals` lists, per signal, `suggestedMatches`: existing needs Signal thinks the request duplicates, offered only while the request is a draft need that the link's holder alone supports. Ask the submitter first, then pass the link `token` (last path segment of their `trackingUrl`), the match's `suggestionId`, and `answer`: `join` adds their voice to the suggested need (their draft is merged into it; a product manager can undo it), `decline` keeps their request separate and tells the product manager they said no. Returns the need the request is on now. `not_found` when the link or the suggestion isn't offered on it; `conflict` when it was already resolved, someone else now supports the draft, or a need was merged meanwhile. Use only with a token the submitter gave you.",
  errors: ["not_found", "conflict"],
  http: { method: "POST", path: "/api/my-signals/:token/matches/:suggestionId" },
  input: z.object({
    answer: z.enum(["join", "decline"]),
    suggestionId: z.uuid(),
    token: trackingTokenSchema,
  }),
  limits: { requestsPerMinute: 20 },
  name: "answer_suggested_match",
  output: answerOutputSchema,
  run: (input, ctx) => answer(ctx, input),
});
