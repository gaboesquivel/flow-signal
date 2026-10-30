import { z } from "zod";

import { checkReadiness, needsCrossingLine } from "../domain/readiness";
import {
  setStrategy as writeStrategy,
  strategyChanges,
  strategyInputSchema,
  strategySchema,
} from "../domain/strategy";
import { defineOperation } from "./types";

export const setStrategy = defineOperation({
  access: "operator",
  description:
    "Write a new version of the PM's strategy (the previous versions are kept). Pass every field: `focusThemeIds` (theme ids from get_need_detail or list_suggestions; unknown ids are `validation_failed`), `revenueFocus` (short text, e.g. \"mid-market retention\"), `capacityPerQuarter` (needs the team can take on per quarter, ≥ 0), the readiness line `readinessArrCents` (distinct supporting accounts' ARR in cents) and `readinessSupporters` (distinct supporters), each ≥ 0 with at least one above 0, and optional `notes`. Every live, undecided need is then checked against the new line: `newlyReady` counts the needs that crossed it now; each gets a decision brief drafted in the background (see list_ready_needs). Returns the stored strategy with its version.",
  effects: "write",
  errors: [],
  http: { method: "PUT", path: "/api/operator/strategy" },
  input: strategyInputSchema,
  name: "set_strategy",
  output: z.object({ newlyReady: z.number().int().nonnegative(), strategy: strategySchema }),
  async preview(input, { db }) {
    const { changed, current } = await strategyChanges(db, input);
    const ready = await needsCrossingLine(db, input);
    return {
      blocks: [],
      editable: [
        { key: "revenueFocus", kind: "text", label: "Revenue focus" },
        { key: "notes", kind: "longtext", label: "Notes" },
      ],
      lines: [
        ...changed.map(({ after, before, label }) => ({ label, value: `${before} → ${after}` })),
        { label: "Needs becoming ready", value: String(ready.length) },
      ],
      needs: ready.map(({ id, statement }) => ({ id, role: "subject" as const, statement })),
      notes: [
        ...(changed.length === 0 ? ["No field changes; a new version is still stored."] : []),
        ...(ready.length > 0 ? ["Each need becoming ready gets a decision brief drafted."] : []),
      ],
      title: current ? `Update strategy (version ${current.version + 1})` : "Write the strategy",
    };
  },
  async run(input, { actor, ai, clock, db }) {
    const strategy = await db.transaction((tx) => writeStrategy(tx, actor, input, clock.now()));
    const newlyReady = await checkReadiness({ ai, clock, db });
    return { newlyReady: newlyReady.length, strategy };
  },
});
