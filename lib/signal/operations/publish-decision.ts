import { z } from "zod";

import {
  decisionStatusSchema,
  previewDecision,
  publishDecision as publish,
  publishedDecisionSchema,
} from "../domain/decisions";
import { defineOperation } from "./types";

export const publishDecision = defineOperation({
  access: "operator",
  description:
    "Publish a decision on a need: sets the need's status (planned, in_progress, shipped, declined) and a note every supporter sees on their My signals link and the public board. Write the note for customers: no account names, people, or revenue. The need's latest accepted brief is attached. `conflict` for a merged need.",
  effects: "write",
  errors: ["not_found", "conflict"],
  http: { method: "POST", path: "/api/operator/needs/:id/decision" },
  input: z.object({
    id: z.uuid(),
    note: z.string().trim().min(1).max(2000),
    status: decisionStatusSchema,
  }),
  name: "publish_decision",
  output: z.object({ decision: publishedDecisionSchema }),
  async preview({ id, note, status }, { db }) {
    const effect = await previewDecision(db, { needId: id, note });
    return {
      blocks:
        effect.findings.length === 0
          ? []
          : [
              {
                code: "public_text_flagged" as const,
                flags: effect.findings,
                message: `The note names a customer: ${effect.findings.map((flag) => flag.match).join(", ")}. Rewrite it before publishing.`,
              },
            ],
      editable: [
        {
          key: "status",
          kind: "select",
          label: "Status",
          options: [...decisionStatusSchema.options],
        },
        { key: "note", kind: "longtext", label: "Note" },
      ],
      lines: [
        { label: "Status", value: `${effect.need.status} → ${status}` },
        { label: "Note", value: note },
        { label: "Supporters notified", value: String(effect.supporters) },
        { label: "Brief attached", value: effect.brief ? "yes" : "no" },
      ],
      needs: [{ id, role: "subject", statement: effect.need.statement }],
      notes: [],
      title: "Publish a decision",
    };
  },
  async run({ id, note, status }, { actor, clock, db }) {
    return {
      decision: await publish({ actor, db, now: clock.now() }, { needId: id, note, status }),
    };
  },
});
