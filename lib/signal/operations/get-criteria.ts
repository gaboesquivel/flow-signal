import { z } from "zod";

import { criteriaOutputSchema, readCriteria } from "../domain/criteria";
import { defineOperation } from "./types";

export const getCriteria = defineOperation({
  access: "operator",
  description:
    "Read the priority criteria (demand, business_value, strategic_fit, effort) with their weights and descriptions. Weights sum to 1; a need's priority score is the weighted sum of its 0–5 criterion scores.",
  errors: [],
  http: { method: "GET", path: "/api/operator/criteria" },
  input: z.object({}),
  name: "get_criteria",
  output: criteriaOutputSchema,
  run: (_input, { db }) => readCriteria(db),
});
