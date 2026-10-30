import { z } from "zod";

import {
  DEFAULT_DEMAND_DAYS,
  DEFAULT_DEMAND_LIMIT,
  demandSummary,
  demandSummaryOutputSchema,
  MAX_DEMAND_LIMIT,
} from "../domain/demand";
import { DAY_MS } from "../domain/need-facts";
import { SignalError } from "../errors";
import { defineOperation } from "./types";

/** An ISO date (`2026-08-01`, midnight UTC) or a date-time with an offset. */
const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

export const getDemandSummary = defineOperation({
  access: "operator",
  description:
    'Summarize demand for open work: live needs (draft, open, planned, in progress) ordered by priority score, each with supporters, requesting accounts (name, plan), business value (ARR + open deals, cents), new supporters since `since`, and trend (new supporters in the last 30 days vs. the 30 before: rising above +20%, falling below −20%). Filter by `themeId` or by `accountId` (needs that account supports). `since` defaults to 90 days ago; `limit` 10, max 50. Includes a short AI summary; when the model is unreachable `summary` is null with `ai: "unavailable"` and the numbers are still returned. Use it for questions like "what are enterprise accounts blocked on?".',
  errors: [],
  http: { method: "GET", path: "/api/operator/demand" },
  input: z.object({
    accountId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_DEMAND_LIMIT).optional(),
    since: instant.optional(),
    themeId: z.uuid().optional(),
  }),
  name: "get_demand_summary",
  output: demandSummaryOutputSchema,
  run(input, { ai, clock, db }) {
    const until = clock.now();
    const since = input.since
      ? new Date(input.since)
      : new Date(until.getTime() - DEFAULT_DEMAND_DAYS * DAY_MS);
    if (since >= until) throw new SignalError("validation_failed", "`since` must be in the past.");
    return demandSummary(
      { ai, db },
      {
        accountId: input.accountId,
        limit: input.limit ?? DEFAULT_DEMAND_LIMIT,
        since,
        themeId: input.themeId,
        until,
      },
    );
  },
});
