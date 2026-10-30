import { z } from "zod";

import {
  listOperatorNeeds as listOperatorNeedsInDb,
  operatorNeedSchema,
  operatorNeedSorts,
  operatorNeedStatuses,
} from "../domain/operator-needs";
import { defineOperation } from "./types";

export const listOperatorNeeds = defineOperation({
  access: "operator",
  description:
    "List every live need (any status but merged) for the PM console in one call: statement, theme, status, people (distinct submitters), accounts (distinct requesting accounts), their combined ARR and open deals (`arrCents`, `openDealCents`), the weighted priority score (0–5, null when unscored) with the score per criterion (`criterionScores`, for re-ranking with other weights), and how many pending suggestions concern it. Filter by `themeId`, `status`, or `query` (words in the statement, theme, or a proposed solution). `sort`: `priority` (default; unscored last, then people), `people`, `accounts`, or `arr`. Operator only: contains revenue.",
  errors: [],
  http: { method: "GET", path: "/api/operator/needs" },
  input: z.object({
    query: z.string().trim().max(200).optional(),
    sort: z.enum(operatorNeedSorts).default("priority"),
    status: z.enum(operatorNeedStatuses).optional(),
    themeId: z.uuid().optional(),
  }),
  name: "list_operator_needs",
  output: z.object({ needs: z.array(operatorNeedSchema) }),
  async run(input, { db }) {
    return { needs: await listOperatorNeedsInDb(db, input) };
  },
});
