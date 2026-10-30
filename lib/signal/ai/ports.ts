import type { z } from "zod";

import type { SignalQueryable } from "../db";

/**
 * AI ports (spec 001 → Domain module and ports). Operations call these through `ctx.ai`;
 * `gateway.ts` implements them with the AI SDK and `fakes.ts` provides deterministic fakes
 * for `pnpm test`. Any implementation throws `SignalError("ai_unavailable", ...)` when the
 * model cannot be reached, so operations can degrade (preview without matches, demand
 * numbers without a summary).
 */

/** Extract step output: "who needs to do what so that outcome", plus anything else asked. */
export interface DraftNeed {
  additionalAsks: string[];
  proposedSolution?: string;
  statement: string;
}

export interface NeedExtractor {
  extract: (input: { body: string; title: string }) => Promise<DraftNeed>;
}

export interface Embedder {
  embed: (texts: string[]) => Promise<number[][]>;
  model: string;
}

export interface NeedCandidate {
  needId: string;
  /** Cosine similarity in [−1, 1]. */
  similarity: number;
  statement: string;
}

/** Retrieve step: nearest approved or draft needs by embedding (pgvector in production). */
export interface NeedRetriever {
  retrieve: (input: {
    db: SignalQueryable;
    embedding: number[];
    limit: number;
  }) => Promise<NeedCandidate[]>;
}

export interface MatchJudgement {
  needId: string;
  /** Probability that the candidate is the same underlying need, 0–1. */
  probability: number;
  reason: string;
}

export interface MatchJudge {
  judge: (input: {
    candidates: { needId: string; statement: string }[];
    draft: DraftNeed;
    submission: { body: string; title: string };
  }) => Promise<MatchJudgement[]>;
  model: string;
}

/** Off-hot-path reasoning tasks; add a task name when an operation needs a new kind. */
export type ReasonerTask =
  | "decision_brief"
  | "demand_summary"
  | "draft_need"
  | "merge"
  | "priority"
  | "public_summary"
  | "split"
  | "theme";

/** Structured generation with the reasoning model; `schema` shapes and validates the value. */
export interface Reasoner {
  generate: <T>(input: {
    prompt: string;
    schema: z.ZodType<T>;
    system?: string;
    task: ReasonerTask;
  }) => Promise<{ model: string; value: T }>;
}

export interface SignalAi {
  embedder: Embedder;
  extractor: NeedExtractor;
  judge: MatchJudge;
  reasoner: Reasoner;
  retriever: NeedRetriever;
}
