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
    "Read a submitter's signals by the private token from their `trackingUrl` (the last path segment of `/my/<token>`): their own words, the need each signal is on now (status, supporters, and current decision), and every decision note published on it. Use only with a token the submitter gave you.",
  errors: ["not_found"],
  http: { method: "GET", path: "/api/my-signals/:token" },
  input: z.object({ token: trackingTokenSchema }),
  name: "get_my_signals",
  output: mySignalsOutputSchema,
  async run({ token }, { db }) {
    const result = await readMySignals(db, token);
    if (!result) throw new SignalError("not_found", "No signals for this link.");
    return result;
  },
});
