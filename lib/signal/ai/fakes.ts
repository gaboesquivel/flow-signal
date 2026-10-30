import { EMBEDDING_DIMENSIONS } from "@/lib/db/schema";

import { SignalError } from "../errors";
import { pgvectorRetriever } from "./gateway";
import type {
  DraftNeed,
  Embedder,
  MatchJudge,
  NeedExtractor,
  Reasoner,
  ReasonerTask,
  SignalAi,
} from "./ports";

/**
 * Deterministic AI fakes for `pnpm test` (never call live models there). They are crude on
 * purpose: tests that need a specific answer pass it in (`extractions`, `judgements`,
 * `reasoner` handlers) instead of relying on the heuristics.
 */

const stopWords = new Set(
  "a an and are as at be by for from in into is it of on or so that the their them this to we with our need needs".split(
    " ",
  ),
);

export const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2 && !stopWords.has(token));

/** Deterministic bucket for a token (polynomial string hash). */
const hash = (token: string) => {
  let value = 7;
  for (const char of token) value = (value * 31 + (char.codePointAt(0) ?? 0)) % 1_000_000_007;
  return value % EMBEDDING_DIMENSIONS;
};

/** Hashed bag of words, L2-normalized: shared words mean higher cosine similarity. */
export const fakeEmbedding = (text: string) => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  for (const token of tokens(text)) {
    const bucket = hash(token);
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
};

export const fakeEmbedder = (): Embedder => ({
  embed: (texts) => Promise.resolve(texts.map(fakeEmbedding)),
  model: "fake/embedding",
});

export const fakeExtractor = (extractions: Record<string, DraftNeed> = {}): NeedExtractor => ({
  extract: ({ body, title }) =>
    Promise.resolve(
      extractions[title] ?? {
        additionalAsks: [],
        statement: `${title.trim()}: ${body.trim()}`.slice(0, 280),
      },
    ),
});

const overlap = (left: string, right: string) => {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  const shared = [...a].filter((token) => b.has(token));
  return { score: shared.length / Math.max(1, Math.min(a.size, b.size)), shared };
};

export const fakeJudge = (
  judgements: Record<string, { probability: number; reason: string }> = {},
): MatchJudge => ({
  judge: ({ candidates, draft, submission }) =>
    Promise.resolve(
      candidates.map(({ needId, statement }) => {
        const fixed = judgements[needId];
        if (fixed) return { needId, ...fixed };
        // Preview judges before extraction finishes, so fall back to the submission's words.
        const { score, shared } = overlap(
          draft?.statement ?? `${submission.title} ${submission.body}`,
          statement,
        );
        return {
          needId,
          probability: Math.min(1, score),
          reason: shared.length ? `Both mention ${shared.slice(0, 3).join(", ")}.` : "No overlap.",
        };
      }),
    ),
  model: "fake/judge",
});

type ReasonerHandler = (input: { prompt: string; system?: string }) => unknown;

/** Returns each task's handler output, validated by the caller's schema; unknown tasks are unavailable. */
export const fakeReasoner = (
  handlers: Partial<Record<ReasonerTask, ReasonerHandler>> = {},
): Reasoner => ({
  generate({ prompt, schema, system, task }) {
    const handler = handlers[task];
    if (!handler)
      return Promise.reject(
        new SignalError("ai_unavailable", `No fake for reasoner task ${task}.`),
      );
    return Promise.resolve({
      model: "fake/reasoner",
      value: schema.parse(handler({ prompt, system })),
    });
  },
});

export const createFakeAi = (overrides: Partial<SignalAi> = {}): SignalAi => ({
  embedder: fakeEmbedder(),
  extractor: fakeExtractor(),
  judge: fakeJudge(),
  reasoner: fakeReasoner(),
  retriever: pgvectorRetriever,
  ...overrides,
});

/** Every model port fails with `ai_unavailable`, as when the Gateway is unreachable. */
const failUnavailable = () =>
  Promise.reject(new SignalError("ai_unavailable", "AI is unavailable."));

export const createUnavailableAi = (): SignalAi => {
  const fail = failUnavailable;
  return {
    embedder: { embed: fail, model: "unavailable" },
    extractor: { extract: fail },
    judge: { judge: fail, model: "unavailable" },
    reasoner: { generate: fail },
    retriever: pgvectorRetriever,
  };
};
