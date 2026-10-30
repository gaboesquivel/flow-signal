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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Fills a fake `decision_brief`'s spec 007 direction fields when its handler leaves them out, so
 * handlers written before spec 007 keep working: confidence 0.7, in focus unless declined, and a
 * capacity note. Deterministic; what a handler sets wins.
 */
export const withFakeDirection = (value: unknown): unknown => {
  if (!isRecord(value) || !isRecord(value.recommendation)) return value;
  const { recommendation } = value;
  const declined = recommendation.status === "declined";
  return {
    ...value,
    recommendation: {
      capacityNote: declined
        ? "Declining keeps this quarter's capacity for focus work."
        : "Takes one slot of this quarter's capacity.",
      confidence: 0.7,
      strategyFit: {
        inFocus: !declined,
        reason: declined
          ? "Outside the strategy's focus themes."
          : "Serves the strategy's focus themes.",
      },
      ...recommendation,
    },
  };
};

/**
 * Returns each task's handler output, validated by the caller's schema; unknown tasks are
 * unavailable. `decision_brief` output gets `withFakeDirection`.
 */
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
      value: schema.parse(
        task === "decision_brief"
          ? withFakeDirection(handler({ prompt, system }))
          : handler({ prompt, system }),
      ),
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
