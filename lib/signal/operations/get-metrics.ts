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

export const getMetricsInput = z.object({
  /** Window start, inclusive. Defaults to 28 days before `to`. */
  from: instant.optional(),
  /** Window end, exclusive. Defaults to now. */
  to: instant.optional(),
});

export const getMetrics = defineOperation({
  access: "operator",
  description:
    "Read Signal's MVP metrics for a window [from, to) (ISO dates or date-times; default the last 28 days), each split human vs. agent: prevention rate (signals attached to an existing need ÷ those plus signals whose draft need was later merged, overall and per ISO week), decision latency (median days from a need's first signal to its first published decision; undecided needs older than 30 days are reported separately), and AI suggestion acceptance (accepted as-is ÷ accepted + edited + rejected, per suggestion kind), direction accuracy (decisions in the window whose published status matches their brief's recommended status ÷ decisions with a recommendation, by publisher), and readiness lead time (median days from a need becoming ready to its first decision; ready needs undecided after 30 days counted separately). Also returns supporting counts (context rate, time to triage, review load, unmerge rate) and lists metrics not computed yet.",
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
