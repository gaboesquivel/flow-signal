import { embedMany } from "ai";
import { and, cosineDistance, isNotNull, ne, sql } from "drizzle-orm";

import {
  gatewayAvailable,
  gatewayEmbeddingModel,
  signalEmbeddingModelId,
  signalFastModelId,
} from "@/lib/ai/models";
import { needs } from "@/lib/db/schema";

import { SignalError } from "../errors";
import type {
  Embedder,
  MatchJudge,
  NeedExtractor,
  NeedRetriever,
  Reasoner,
  SignalAi,
} from "./ports";

const unavailable = (what: string, cause?: unknown) => {
  const error = new SignalError("ai_unavailable", `${what} is unavailable.`);
  if (cause !== undefined) error.cause = cause;
  return error;
};

const requireGateway = (what: string) => {
  if (!gatewayAvailable()) throw unavailable(`${what} (no AI Gateway access)`);
};

const notImplemented = (what: string) =>
  Promise.reject(
    gatewayAvailable()
      ? unavailable(`${what} (not implemented yet)`)
      : unavailable(`${what} (no AI Gateway access)`),
  );

export const gatewayEmbedder = (): Embedder => ({
  async embed(texts) {
    requireGateway("Embedding");
    if (texts.length === 0) return [];
    try {
      const { embeddings } = await embedMany({
        model: gatewayEmbeddingModel(signalEmbeddingModelId()),
        values: texts,
      });
      return embeddings;
    } catch (error) {
      throw unavailable("Embedding", error);
    }
  },
  get model() {
    return signalEmbeddingModelId();
  },
});

/** pgvector cosine search over every need that is not merged away and has an embedding. */
export const pgvectorRetriever: NeedRetriever = {
  async retrieve({ db, embedding, limit }) {
    const distance = cosineDistance(needs.embedding, embedding);
    const rows = await db
      .select({
        needId: needs.id,
        similarity: sql<number>`1 - (${distance})`,
        statement: needs.statement,
      })
      .from(needs)
      .where(and(ne(needs.status, "merged"), isNotNull(needs.embedding)))
      .orderBy(distance)
      .limit(limit);
    return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
  },
};

// Task 02 implements extract and judge (fast model, structured output); task 04/05 the reasoner.
export const gatewayExtractor = (): NeedExtractor => ({
  extract: () => notImplemented("Need extraction"),
});

export const gatewayJudge = (): MatchJudge => ({
  judge: () => notImplemented("Match judging"),
  get model() {
    return signalFastModelId();
  },
});

export const gatewayReasoner = (): Reasoner => ({
  generate: () => notImplemented("Reasoning"),
});

export const createGatewayAi = (): SignalAi => ({
  embedder: gatewayEmbedder(),
  extractor: gatewayExtractor(),
  judge: gatewayJudge(),
  reasoner: gatewayReasoner(),
  retriever: pgvectorRetriever,
});
