import { createFakeAi, fakeEmbedder, fakeExtractor, fakeJudge } from "../../../lib/signal/ai/fakes";
import type { MatchJudge, NeedExtractor } from "../../../lib/signal/ai/ports";
import type { SignalDb } from "../../../lib/signal/db";
import { embedMissingNeeds } from "../../../lib/signal/domain/embeddings";
import { SignalError } from "../../../lib/signal/errors";
import { configureSignalRuntime } from "../../../lib/signal/runtime";
import { buildPublicNeedsFixture } from "./public-needs-fixture";

/**
 * The acceptance scenario's submission (spec 001 → Acceptance scenario, step 1): Maya's text,
 * the draft need the extractor drafts from it, and the judge's verdicts on N1 and N2.
 */
export const maya = {
  body: "Our CEO wants the KPI dashboard in the board deck every month.",
  email: "maya@acme.example",
  title: "Export dashboards to PDF",
};

export const mayaDraft = {
  additionalAsks: [],
  proposedSolution: "PDF export",
  statement:
    "Executives need to share dashboard snapshots in the board deck so that board meetings use current numbers",
};

/** A submission with two asks: the extractor returns the second in `additionalAsks`. */
export const twoAsks = {
  body: "We need PDF export of dashboards for the board, and also SSO with Okta for our admins.",
  title: "PDF export and Okta SSO",
};

const twoAsksStatement =
  "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers";

/** The extractor fails with `ai_unavailable` for this title (the Gateway is down). */
export const AI_DOWN_TITLE = "Gateway outage submission";

const extractor = (): NeedExtractor => {
  const fake = fakeExtractor({
    [maya.title]: mayaDraft,
    [twoAsks.title]: {
      additionalAsks: ["Admins need to sign in with Okta so that access is managed centrally"],
      proposedSolution: "PDF export",
      statement: twoAsksStatement,
    },
  });
  return {
    extract: (input) =>
      input.title === AI_DOWN_TITLE
        ? Promise.reject(new SignalError("ai_unavailable", "AI is unavailable."))
        : fake.extract(input),
  };
};

const scenarioStatements = new Set([mayaDraft.statement, twoAsksStatement]);

/** Fixed verdicts for the scenario's drafts; word overlap (the default fake) for anything else. */
const scenarioJudge = (
  verdicts: Record<string, { probability: number; reason: string }>,
): MatchJudge => {
  const fixed = fakeJudge(verdicts);
  const overlap = fakeJudge();
  return {
    judge: (input) =>
      (scenarioStatements.has(input.draft.statement) ? fixed : overlap).judge(input),
    model: fixed.model,
  };
};

/**
 * The public board fixture with every need embedded (by the backfill, with the fake embedder)
 * and fake AI that answers the acceptance scenario: N1 is the match, N2 is not.
 */
export const buildSubmissionFixture = async (db: SignalDb) => {
  const fixture = await buildPublicNeedsFixture(db);
  await embedMissingNeeds(db, fakeEmbedder());
  configureSignalRuntime({
    ai: createFakeAi({
      extractor: extractor(),
      judge: scenarioJudge({
        [fixture.n1.need.id]: {
          probability: 0.92,
          reason: "Both are about sharing dashboard snapshots with executives for board meetings.",
        },
        [fixture.n2.need.id]: {
          probability: 0.2,
          reason: "Same PDF export solution, but N2 is about archiving reports for audits.",
        },
        [fixture.decided.need.id]: { probability: 0.1, reason: "Scheduling, not sharing." },
        [fixture.draft.need.id]: { probability: 0.05, reason: "Annotations, not sharing." },
        [fixture.scored.need.id]: { probability: 0, reason: "Unrelated." },
      }),
    }),
  });
  return fixture;
};

export type SubmissionFixture = Awaited<ReturnType<typeof buildSubmissionFixture>>;
