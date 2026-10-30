import { expect } from "vitest";

import { previewSignal } from "../../../lib/signal/operations/preview-signal";
import { assertNoPrivateData } from "../support/public-needs-fixture";
import {
  AI_DOWN_TITLE,
  buildSubmissionFixture,
  maya,
  mayaDraft,
  twoAsks,
} from "../support/submission-fixture";
import type { SubmissionFixture } from "../support/submission-fixture";
import { runParityTable } from "./harness";

/** Random per call (spec 012); the harness normalizes it when comparing surfaces. */
const anyPreviewId = expect.stringMatching(/^pv_[\w-]{22}$/u) as unknown as string;

/** Every preview writes exactly one `preview.shown`; a rejected input writes none. */
const onePreview = () => ["preview.shown"];
const none = () => [];

const n1Match = (fx: SubmissionFixture) => ({
  demandBand: "high",
  needId: fx.n1.need.id,
  probability: 0.92,
  reason: "Both are about sharing dashboard snapshots with executives for board meetings.",
  statement:
    "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
  status: "open",
  supporterCount: 11,
});

runParityTable<SubmissionFixture>({
  cases: [
    {
      check: assertNoPrivateData,
      events: onePreview,
      expect: (fx) => ({
        output: {
          ai: "ok",
          draftNeed: mayaDraft,
          matches: [n1Match(fx)],
          previewId: anyPreviewId,
        },
      }),
      input: () => ({ body: maya.body, title: maya.title }),
      name: "drafts the need and returns N1 with a reason, not N2 (acceptance step 1)",
    },
    {
      events: onePreview,
      expect: (fx) => ({
        output: {
          ai: "ok",
          draftNeed: {
            additionalAsks: [
              "Admins need to sign in with Okta so that access is managed centrally",
            ],
            proposedSolution: "PDF export",
            statement:
              "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
          },
          matches: [n1Match(fx)],
          previewId: anyPreviewId,
        },
      }),
      input: () => twoAsks,
      name: "returns a second ask in additionalAsks",
    },
    {
      events: onePreview,
      expect: () => ({
        output: {
          ai: "ok",
          draftNeed: {
            additionalAsks: [],
            statement: "Dark mode for the mobile app: Night shifts strain our eyes.",
          },
          matches: [],
          previewId: anyPreviewId,
        },
      }),
      input: () => ({
        body: "Night shifts strain our eyes.",
        title: "Dark mode for the mobile app",
      }),
      name: "returns no matches when no candidate reaches the threshold",
    },
    {
      events: onePreview,
      expect: () => ({
        output: {
          ai: "unavailable",
          draftNeed: { additionalAsks: [], statement: AI_DOWN_TITLE },
          matches: [],
          previewId: anyPreviewId,
        },
      }),
      input: () => ({ body: "Anything at all.", title: AI_DOWN_TITLE }),
      name: "answers without matches when AI is unavailable",
    },
    {
      events: none,
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ body: "No title" }),
      name: "requires a title",
    },
    {
      events: none,
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ body: "x".repeat(5001), title: "Too long" }),
      name: "caps the body length",
    },
  ],
  fixture: buildSubmissionFixture,
  // Each preview writes preview.shown.
  mutates: true,
  operation: previewSignal,
});
