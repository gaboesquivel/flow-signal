import { z } from "zod";

import { previewOutputSchema, previewSubmission } from "../domain/matching";
import { defineOperation } from "./types";

const previewSignalInput = z.object({
  body: z.string().trim().max(5000).default(""),
  title: z.string().trim().min(3).max(200),
});

export const previewSignal = defineOperation({
  access: "public",
  description:
    'Check a request for duplicates before submitting it. Give the submitter\'s title and body; returns the drafted underlying need (`draftNeed.statement`, a named `proposedSolution`, and any `additionalAsks`, which should be offered as separate submissions), up to 3 existing needs that are the same need (`matches`, each with a probability and a one-line reason), and a `previewId` to pass to `submit_signal`. Show the matches and let the submitter choose one (submit with `target.needId`) or none (submit with `target.newNeed.statement`). With `ai: "unavailable"` there are no matches and submitting still works. Read-only.',
  errors: ["validation_failed"],
  http: { method: "POST", path: "/api/signals/preview" },
  input: previewSignalInput,
  // Called as the submitter types (debounced), so it allows more calls than a write.
  limits: { maxBodyBytes: 16 * 1024, requestsPerMinute: 60 },
  name: "preview_signal",
  output: previewOutputSchema,
  run: (input, { ai, db }) => previewSubmission({ ai, db }, input),
});
