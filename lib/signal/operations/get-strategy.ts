import { z } from "zod";

import {
  DEFAULT_READINESS,
  getStrategy as readStrategy,
  readinessSchema,
  strategySchema,
} from "../domain/strategy";
import { defineOperation } from "./types";

export const getStrategy = defineOperation({
  access: "operator",
  description:
    "Read the PM's current strategy: focus themes (id and name), revenue focus, capacity per quarter, the readiness line (`readinessArrCents`: distinct supporting accounts' ARR in cents; `readinessSupporters`: distinct supporters; a need is ready when it reaches either nonzero threshold), notes, and its version. `strategy` is null when none is written; `defaults` is the readiness line used then. Priority scores and decision briefs are judged against this strategy. Change it with set_strategy.",
  errors: [],
  http: { method: "GET", path: "/api/operator/strategy" },
  input: z.object({}),
  name: "get_strategy",
  output: z.object({ defaults: readinessSchema, strategy: strategySchema.nullable() }),
  async run(_input, { db }) {
    return { defaults: DEFAULT_READINESS, strategy: await readStrategy(db) };
  },
});
