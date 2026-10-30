import { createHash } from "node:crypto";

import { z } from "zod";

import type { DraftNeed, SignalAi } from "../ai/ports";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { demandBandSchema, getPublicNeed, publicNeedStatusSchema } from "./public-needs";

/**
 * The submission hot path (spec 001 → Architecture and AI choices; decision 0002): a fixed
 * extract → retrieve → judge workflow. Any AI step that fails degrades the preview to
 * `ai: "unavailable"` with no matches; database errors still propagate.
 */

/** Judge probability a candidate needs to be shown as a match. Task 03 tunes it on the eval set. */
export const MATCH_THRESHOLD = 0.6;
/** Nearest needs passed to the judge. */
export const CANDIDATE_LIMIT = 8;
/** Matches returned to the submitter. */
export const MAX_MATCHES = 3;

export const draftNeedSchema = z.object({
  /** Further, separate asks found in the submission: offer to split them. */
  additionalAsks: z.array(z.string()),
  proposedSolution: z.string().optional(),
  /** "who needs to do what so that outcome" */
  statement: z.string(),
});

export const matchSchema = z.object({
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
export type PreviewOutput = z.infer<typeof previewOutputSchema>;

/** Deterministic id for a preview of this text (no state is stored for a preview). */
export const previewIdFor = ({ body, title }: { body: string; title: string }) =>
  `pv_${createHash("sha256").update(`${title.trim()}\n${body.trim()}`).digest("base64url").slice(0, 22)}`;

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

export const previewSubmission = async (
  { ai, db }: { ai: SignalAi; db: SignalQueryable },
  submission: { body: string; title: string },
  { threshold = MATCH_THRESHOLD }: { threshold?: number } = {},
): Promise<PreviewOutput> => {
  const previewId = previewIdFor(submission);
  const unavailable = (draftNeed: DraftNeed): PreviewOutput => ({
    ai: "unavailable",
    draftNeed,
    matches: [],
    previewId,
  });

  let draftNeed: DraftNeed;
  try {
    draftNeed = cleanDraft(await ai.extractor.extract(submission), submission.title);
  } catch (error) {
    if (isAiUnavailable(error)) return unavailable(fallbackDraft(submission.title));
    throw error;
  }

  let embedding: number[] | undefined;
  try {
    [embedding] = await ai.embedder.embed([draftNeed.statement]);
  } catch (error) {
    if (isAiUnavailable(error)) return unavailable(draftNeed);
    throw error;
  }
  if (!embedding) return unavailable(draftNeed);

  const candidates = await ai.retriever.retrieve({ db, embedding, limit: CANDIDATE_LIMIT });
  if (candidates.length === 0) return { ai: "ok", draftNeed, matches: [], previewId };

  let judgements;
  try {
    judgements = await ai.judge.judge({
      candidates: candidates.map(({ needId, statement }) => ({ needId, statement })),
      draft: draftNeed,
      submission,
    });
  } catch (error) {
    if (isAiUnavailable(error)) return unavailable(draftNeed);
    throw error;
  }

  const candidateIds = new Set(candidates.map((candidate) => candidate.needId));
  const similarity = new Map(candidates.map((c) => [c.needId, c.similarity]));
  const chosen = judgements
    .filter((j) => candidateIds.has(j.needId) && j.probability >= threshold)
    .toSorted(
      (a, b) =>
        b.probability - a.probability ||
        (similarity.get(b.needId) ?? 0) - (similarity.get(a.needId) ?? 0),
    )
    .filter((j, index, all) => all.findIndex((other) => other.needId === j.needId) === index)
    .slice(0, MAX_MATCHES);

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
