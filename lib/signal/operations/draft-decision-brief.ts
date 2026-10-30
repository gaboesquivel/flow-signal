import { z } from "zod";

import {
  decisionBriefSuggestionSchema,
  draftDecisionBrief as draftBrief,
} from "../domain/decisions";
import { defineOperation } from "./types";

export const draftDecisionBrief = defineOperation({
  access: "operator",
  description:
    "Ask AI to draft a decision brief for a need: demand (supporters, trend, priority score), requesting accounts and their value, two to four decision options with rationale and tradeoffs, and a recommended status and note. It is filed as a pending `decision_brief` suggestion (returned here) for the PM to accept, edit, or reject with resolve_suggestion; nothing is published. A need holds one pending brief: if it already has one (readiness drafts one automatically), that brief is returned instead of a new draft. Then publish with publish_decision. `conflict` for a merged need; `ai_unavailable` when the model is unreachable.",
  errors: ["not_found", "conflict", "ai_unavailable"],
  http: { method: "POST", path: "/api/operator/needs/:id/decision-brief" },
  input: z.object({ id: z.uuid() }),
  name: "draft_decision_brief",
  output: z.object({ suggestion: decisionBriefSuggestionSchema }),
  async run({ id }, { ai, clock, db }) {
    return { suggestion: await draftBrief({ ai, db, now: clock.now() }, id) };
  },
});
