import { z } from "zod";

import { SignalError } from "../errors";
import {
  computeMetrics,
  DAY_MS,
  MAX_WINDOW_DAYS,
  metricsSchema,
  resolveMetricsWindow,
} from "../metrics";
import { defineOperation } from "./types";

/** An ISO date (`2026-10-26`, midnight UTC) or a date-time with an offset. */
const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

const getMetricsInput = z.object({
  /** Window start, inclusive. Defaults to 28 days before `to`. */
  from: instant.optional(),
  /** Window end, exclusive. Defaults to now. */
  to: instant.optional(),
});

export const getMetrics = defineOperation({
  access: "operator",
  description:
    "Read Signal's MVP metrics for a window [from, to) (ISO dates or date-times; default the last 28 days), each split human vs. agent: prevention rate (signals attached to an existing need ÷ those plus signals whose draft need was later merged, overall and per ISO week), decision latency (median days from a need's first signal to its first published decision; undecided needs older than 30 days are reported separately), and AI suggestion acceptance (accepted as-is ÷ accepted + edited + rejected, per suggestion kind), direction accuracy (decisions in the window whose published status matches their brief's recommended status ÷ decisions with a recommendation, by publisher), and readiness lead time (median days from a need becoming ready to its first decision; ready needs undecided after 30 days counted separately). Also returns match exposure (spec 012; submissions shown at least one match at preview: take-up = picked a shown need ÷ shown, picks by rank, filed new despite a match split by whether a PM later merged the draft into a shown need, elsewhere, or not, taken matches later split off their need, and skipped / none-shown / unknown previews; plus previews with matches that no submission followed within 24 hours), the real-user kill criterion over all time before `to` (shown submissions, their prevention rate, the all-time unmerge rate, and a verdict: insufficient_data under 200 shown submissions, fail when prevention < 30% or unmerge > 10%, else pass), report reuse (spec 013; reports first saved in the window, how many were opened, shared, or saved again within 14 days, and the rate, split by whether a human or an agent first saved them), supporting counts (context rate, time to triage, review load, unmerge rate), and lists metrics not computed yet.",
  errors: [],
  http: { method: "GET", path: "/api/operator/metrics" },
  input: getMetricsInput,
  name: "get_metrics",
  output: metricsSchema,
  run(input, { clock, db }) {
    const window = resolveMetricsWindow(input, clock.now());
    if (window.from >= window.to)
      throw new SignalError("validation_failed", "`from` must be before `to`.");
    if (window.to.getTime() - window.from.getTime() > MAX_WINDOW_DAYS * DAY_MS)
      throw new SignalError(
        "validation_failed",
        `The window can span at most ${MAX_WINDOW_DAYS} days.`,
      );
    return computeMetrics(db, window);
  },
});
