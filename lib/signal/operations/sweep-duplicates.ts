import { z } from "zod";

import { sweepDuplicates as sweep, sweepResultSchema } from "../domain/duplicate-backstop";
import { defineOperation } from "./types";

export const sweepDuplicates = defineOperation({
  access: "operator",
  description:
    "Run the duplicate sweep now (spec 009): look at live draft needs from the last 30 days, newest first, and re-run the merge check on those due for one (never checked, or the draft, its nearest needs, or their supporters changed since). Each check may create up to two pending `merge` suggestions for triage; nothing is merged. `checks` caps how many drafts get a model call (default 2, at most 20). Signal also sweeps after every submission and after `pnpm db:embed`. Returns the drafts checked with the merges proposed, how many drafts were looked at, and how many could not be checked because AI was unavailable.",
  effects: "write",
  errors: [],
  http: { method: "POST", path: "/api/operator/duplicates/sweep" },
  input: z.object({ checks: z.number().int().min(1).max(20).optional() }),
  name: "sweep_duplicates",
  output: sweepResultSchema,
  run: ({ checks }, { ai, clock, db }) => sweep({ ai, clock, db }, { checks }),
});
