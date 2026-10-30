import {
  submitInputSchema,
  submitOutputSchema,
  submitSignal as submit,
} from "../domain/submissions";
import { defineOperation } from "./types";

export const submitSignal = defineOperation({
  access: "public",
  description:
    'Submit a signal: one person\'s request in their own words. Use `target: { needId }` to add their voice to an existing need (usually a match from `preview_signal`), or `target: { newNeed: { statement } }` when none matches, which creates a draft need shown publicly as "new". Title, body, use case, and urgency are kept verbatim; email (and optional name and company) identify the submitter to product managers only and are never shown publicly. `idempotencyKey` is required: retrying with the same key returns the same signal; reusing it for a different submission is a `conflict`. Returns the need it landed on and a private `trackingUrl` to give only to the submitter.',
  errors: ["validation_failed", "not_found", "conflict"],
  http: { method: "POST", path: "/api/signals" },
  input: submitInputSchema,
  limits: { maxBodyBytes: 16 * 1024, requestsPerMinute: 20 },
  name: "submit_signal",
  output: submitOutputSchema,
  run: (input, ctx) => submit(ctx, input),
});
