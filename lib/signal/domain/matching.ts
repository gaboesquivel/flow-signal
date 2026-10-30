import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { DraftNeed, MatchJudgement, NeedCandidate, SignalAi } from "../ai/ports";
import type { Actor, Clock } from "../context";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { demandBandSchema, getPublicNeed, publicNeedStatusSchema } from "./public-needs";

/**
 * The submission hot path (spec 001 → Architecture and AI choices; decision 0002): a fixed
 * extract → retrieve → judge workflow, with extraction running concurrently with the rest. Any AI step that fails degrades the preview to
 * `ai: "unavailable"` with no matches; database errors still propagate. Every preview records
 * `preview.shown` (spec 012): the needs shown and their ranks, never the submitted text.
 */

/**
 * Judge probability a candidate needs to be shown as a match, for a judge without its own
 * `threshold`; confirmed by the task 03 live eval (spec 001). Jev's is `JEV_MATCH_THRESHOLD` (spec 008).
 */
export const MATCH_THRESHOLD = 0.6;
/** Nearest needs passed to the judge. */
export const CANDIDATE_LIMIT = 8;
/** Matches returned to the submitter. */
const MAX_MATCHES = 3;

const draftNeedSchema = z.object({
  /** Further, separate asks found in the submission: offer to split them. */
  additionalAsks: z.array(z.string()),
  proposedSolution: z.string().optional(),
  /** "who needs to do what so that outcome" */
  statement: z.string(),
});

const matchSchema = z.object({
  demandBand: demandBandSchema,
  needId: z.uuid(),
  probability: z.number().min(0).max(1),
  reason: z.string(),
  statement: z.string(),
  status: publicNeedStatusSchema,
  supporterCount: z.number().int().nonnegative(),
});

export const previewOutputSchema = z.object({
  ai: z.enum(["ok", "unavailable"]),
  draftNeed: draftNeedSchema,
  matches: z.array(matchSchema),
  /** Pass to `submit_signal` so the submission is linked to what was shown. */
  previewId: z.string(),
});
type PreviewOutput = z.infer<typeof previewOutputSchema>;

/** Random id per preview call; `preview.shown` records it so `submit_signal` can find what was shown. */
export const newPreviewId = () => `pv_${randomBytes(17).toString("base64url").slice(0, 22)}`;

/** Records what this preview showed (spec 012): need ids, probabilities, and ranks only, no text. */
const recordShown = async (
  { actor, clock, db }: { actor: Actor; clock: Clock; db: SignalQueryable },
  output: PreviewOutput,
) => {
  await recordEvent(db, {
    actor,
    dedupeKey: `preview.shown:${output.previewId}`,
    occurredAt: clock.now(),
    payload: {
      additionalAsks: output.draftNeed.additionalAsks.length,
      ai: output.ai,
      matches: output.matches.map(({ needId, probability }, index) => ({
        needId,
        probability,
        rank: index + 1,
      })),
      previewId: output.previewId,
    },
    type: "preview.shown",
  });
  return output;
};

/** Draft need shown when the extractor is down: the title, which the submitter can edit. */
const fallbackDraft = (title: string): DraftNeed => ({
  additionalAsks: [],
  statement: title.trim(),
});

const isAiUnavailable = (error: unknown) =>
  error instanceof SignalError && error.code === "ai_unavailable";

const cleanDraft = (draft: DraftNeed, title: string): DraftNeed => {
  const statement = draft.statement.trim() || title.trim();
  const proposedSolution = draft.proposedSolution?.trim();
  return {
    additionalAsks: draft.additionalAsks.map((ask) => ask.trim()).filter(Boolean),
    ...(proposedSolution ? { proposedSolution } : {}),
    statement,
  };
};

/**
 * Which judged candidates are shown: probability at or above the threshold, highest first (ties
 * by retrieval similarity), one per need, at most `MAX_MATCHES`. The matching eval
 * (`evals/matching`) scores this same rule across a threshold sweep.
 */
export const chooseMatches = <J extends MatchJudgement>({
  candidates,
  judgements,
  threshold = MATCH_THRESHOLD,
}: {
  candidates: Pick<NeedCandidate, "needId" | "similarity">[];
  judgements: J[];
  threshold?: number;
}): J[] => {
  const candidateIds = new Set(candidates.map((candidate) => candidate.needId));
  const similarity = new Map(candidates.map((c) => [c.needId, c.similarity]));
  return judgements
    .filter((j) => candidateIds.has(j.needId) && j.probability >= threshold)
    .toSorted(
      (a, b) =>
        b.probability - a.probability ||
        (similarity.get(b.needId) ?? 0) - (similarity.get(a.needId) ?? 0),
    )
    .filter((j, index, all) => all.findIndex((other) => other.needId === j.needId) === index)
    .slice(0, MAX_MATCHES);
};

const matchSubmission = async (
  { ai, db }: { ai: SignalAi; db: SignalQueryable },
  submission: { body: string; title: string },
  options: { threshold?: number },
): Promise<PreviewOutput> => {
  const threshold = options.threshold ?? ai.judge.threshold ?? MATCH_THRESHOLD;
  const previewId = newPreviewId();
  const unavailable = (draftNeed: DraftNeed): PreviewOutput => ({
    ai: "unavailable",
    draftNeed,
    matches: [],
    previewId,
  });

  // Extraction runs alongside embed → retrieve → judge, so preview costs one fast-model call of
  // latency instead of two. Retrieval and judging use the submission text; the drafted
  // statement only feeds the response. Settled here so a failure never goes unhandled.
  const settleExtraction = async () => {
    try {
      return {
        draft: cleanDraft(await ai.extractor.extract(submission), submission.title),
        ok: true as const,
      };
    } catch (error) {
      return { error, ok: false as const };
    }
  };
  const extraction = settleExtraction();
  const draftOrFallback = async (): Promise<DraftNeed> => {
    const settled = await extraction;
    if (settled.ok) return settled.draft;
    if (isAiUnavailable(settled.error)) return fallbackDraft(submission.title);
    throw settled.error;
  };
  const extractedDraft = async (): Promise<DraftNeed | undefined> => {
    const settled = await extraction;
    if (settled.ok) return settled.draft;
    if (isAiUnavailable(settled.error)) return undefined;
    throw settled.error;
  };

  let embedding: number[] | undefined;
  try {
    [embedding] = await ai.embedder.embed([`${submission.title}\n\n${submission.body}`]);
  } catch (error) {
    if (isAiUnavailable(error)) return unavailable(await draftOrFallback());
    throw error;
  }
  if (!embedding) return unavailable(await draftOrFallback());

  const candidates = await ai.retriever.retrieve({ db, embedding, limit: CANDIDATE_LIMIT });

  let judgements: MatchJudgement[] = [];
  if (candidates.length > 0) {
    try {
      judgements = await ai.judge.judge({
        candidates: candidates.map(({ needId, statement }) => ({ needId, statement })),
        submission,
      });
    } catch (error) {
      if (isAiUnavailable(error)) return unavailable(await draftOrFallback());
      throw error;
    }
  }

  const draftNeed = await extractedDraft();
  if (!draftNeed) return unavailable(fallbackDraft(submission.title));
  if (candidates.length === 0) return { ai: "ok", draftNeed, matches: [], previewId };

  const chosen = chooseMatches({ candidates, judgements, threshold });

  const views = await Promise.all(chosen.map((judgement) => getPublicNeed(db, judgement.needId)));
  const matches = chosen.flatMap((judgement, index) => {
    const need = views[index];
    if (!need || need.status === "merged") return [];
    return [
      {
        demandBand: need.demandBand,
        needId: need.id,
        probability: Math.round(judgement.probability * 1000) / 1000,
        reason: judgement.reason.trim(),
        statement: need.statement,
        status: need.status,
        supporterCount: need.supporterCount,
      },
    ];
  });
  return { ai: "ok", draftNeed, matches, previewId };
};

export const previewSubmission = async (
  context: { actor: Actor; ai: SignalAi; clock: Clock; db: SignalQueryable },
  submission: { body: string; title: string },
  options: { threshold?: number } = {},
): Promise<PreviewOutput> =>
  recordShown(context, await matchSubmission(context, submission, options));
