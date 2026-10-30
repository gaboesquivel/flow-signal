import { z } from "zod";

import { criteriaOutputSchema, criteriaWeightsSchema, writeCriteria } from "../domain/criteria";
import { previewCriteria } from "../domain/operator-needs";
import { defineOperation } from "./types";

const criterionLabel = {
  business_value: "Business value",
  demand: "Demand",
  effort: "Effort",
  strategic_fit: "Strategic fit",
} as const;

export const setCriteria = defineOperation({
  access: "operator",
  description:
    "Set the priority criteria weights. Pass `weights` with every key (demand, business_value, strategic_fit, effort), each 0–1, summing to 1; otherwise `validation_failed`. Returns the criteria as get_criteria does.",
  effects: "write",
  errors: [],
  http: { method: "PUT", path: "/api/operator/criteria" },
  input: z.object({ weights: criteriaWeightsSchema }),
  name: "set_criteria",
  output: criteriaOutputSchema,
  async preview({ weights }, { db }) {
    const effect = await previewCriteria(db, weights);
    return {
      blocks: [],
      editable: effect.weights.map(({ key }) => ({
        key: `weights.${key}`,
        kind: "number" as const,
        label: `${criterionLabel[key]} weight`,
      })),
      lines: [
        ...effect.weights.map(({ after, before, key }) => ({
          label: `${criterionLabel[key]} weight`,
          value: `${before} → ${after}`,
        })),
        ...effect.after.map((need, index) => ({
          label: `#${index + 1}`,
          value: `${need.statement} (${need.score ?? "unscored"}${need.rankBefore === index + 1 ? "" : `, was #${need.rankBefore}`})`,
        })),
      ],
      needs: effect.after.map(({ id, statement }) => ({ id, role: "subject" as const, statement })),
      notes: [],
      title: "Change priority weights",
    };
  },
  run: ({ weights }, { db }) => db.transaction((tx) => writeCriteria(tx, weights)),
});
