import { z } from "zod";

import {
  getMySignals as readMySignals,
  mySignalsOutputSchema,
  trackingTokenSchema,
} from "../domain/my-signals";
import { SignalError } from "../errors";
import { defineOperation } from "./types";

export const getMySignals = defineOperation({
  access: "public",
  description:
    "Read a submitter's My signals link by the private token from their `trackingUrl` (the last path segment of `/my/<token>`): every signal filed onto that link, newest first, with their own words, the need each signal is on now (status, supporters, and current decision), and every decision note published on it. Use only with a token the submitter gave you; a read counts as the submitter seeing each decision shown (close-the-loop rate).",
  errors: ["not_found"],
  http: { method: "GET", path: "/api/my-signals/:token" },
  input: z.object({ token: trackingTokenSchema }),
  name: "get_my_signals",
  output: mySignalsOutputSchema,
  async run({ token }, { actor, clock, db }) {
    // Records which published decisions the holder now sees (close-the-loop rate).
    const result = await readMySignals(db, token, { actor, now: clock.now() });
    if (!result) throw new SignalError("not_found", "No signals for this link.");
    return result;
  },
});
