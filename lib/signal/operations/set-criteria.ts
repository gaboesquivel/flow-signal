import { z } from "zod";

import { criteriaOutputSchema, criteriaWeightsSchema, writeCriteria } from "../domain/criteria";
import { defineOperation } from "./types";

export const setCriteria = defineOperation({
  access: "operator",
  description:
    "Set the priority criteria weights. Pass `weights` with every key (demand, business_value, strategic_fit, effort), each 0–1, summing to 1; otherwise `validation_failed`. Returns the criteria as get_criteria does.",
  errors: [],
  http: { method: "PUT", path: "/api/operator/criteria" },
  input: z.object({ weights: criteriaWeightsSchema }),
  name: "set_criteria",
  output: criteriaOutputSchema,
  run: ({ weights }, { db }) => db.transaction((tx) => writeCriteria(tx, weights)),
});
