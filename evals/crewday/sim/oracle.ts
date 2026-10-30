import { embedMany } from "ai";

import { gatewayEmbeddingModel } from "@/lib/ai/models";
import { fakeEmbedder } from "@/lib/signal/ai/fakes";
import { defaultCriteria } from "@/lib/signal/domain/criteria";
import type { Embedder } from "@/lib/signal/ai/ports";

import type { Need, World, WorldSignal } from "../format";

/**
 * Ground truth the scripted policies and the scorer read (spec 004 → Simulation). Signal never
 * sees any of it. A database need's **identity** is the true need it stands for: the backlog
 * row's `trueNeedKey`, or the main need of the signal that created it. Merging moves signals but
 * never changes the target's identity.
 */

export interface WorldIndex {
  accountArr: Map<string, number>;
  needs: Map<string, Need>;
  /** Split children's parent (a signal for a child "already existed" through its parent). */
  parentOf: Map<string, string>;
  signals: Map<string, WorldSignal>;
  themeNames: Map<string, string>;
  world: World;
}

export const indexWorld = (world: World): WorldIndex => ({
  accountArr: new Map(world.accounts.map((account) => [account.key, account.arrCents])),
  needs: new Map(world.needs.map((need) => [need.key, need])),
  parentOf: new Map(
    world.needs.flatMap((need) => (need.splitInto ?? []).map((child) => [child, need.key])),
  ),
  signals: new Map(world.signals.map((signal) => [signal.id, signal])),
  themeNames: new Map(world.themes.map((theme) => [theme.key, theme.name])),
  world,
});

/** The need keys a signal may be attached to and count as correct (multi-ask: either). */
export const trueKeys = (signal: WorldSignal) => signal.labels.needKeys;

/**
 * A priority rank (1 = highest) on Signal's 0–5 score scale: rank 1 is 5, the lowest rank 0,
 * linear between, so "within one point" is comparable with a weighted priority score.
 */
export const trueScore = (index: WorldIndex, needKey: string) => {
  const need = index.needs.get(needKey);
  if (!need) return null;
  const ranks = index.world.needs.map((n) => n.truePriority);
  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  if (worst === best) return 5;
  return (5 * (worst - need.truePriority)) / (worst - best);
};

/** Σ score × default weight, as Signal computes a need's priority score (0–5). */
export const weightedScore = (scores: Partial<Record<string, number>>) => {
  let total = 0;
  let weight = 0;
  for (const { key, weight: w } of defaultCriteria) {
    const score = scores[key];
    if (typeof score !== "number") continue;
    total += score * w;
    weight += w;
  }
  return weight === 0 ? null : total / weight;
};

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * "Nearest need in the world recipe": an embedding lookup of a statement against the world's
 * hand-written need statements, with the run's embedder. Not a model judgment, and not one of the
 * arm's AI ports, so it never counts as a PM model call.
 */
export interface NearestNeed {
  nearest: (statement: string) => Promise<string | null>;
}

export const createNearestNeed = (world: World, embedder: Embedder): NearestNeed => {
  let vectors: Promise<number[][]> | undefined;
  return {
    async nearest(statement) {
      vectors ??= embedder.embed(world.needs.map((need) => need.statement));
      const [all, [query]] = await Promise.all([vectors, embedder.embed([statement])]);
      if (!query) return null;
      let best: { key: string; score: number } | null = null;
      for (const [i, need] of world.needs.entries()) {
        const score = cosine(query, all[i] ?? []);
        if (!best || score > best.score) best = { key: need.key, score };
      }
      return best?.key ?? null;
    },
  };
};

/** The oracle's embedding model when live: deliberately not Signal's (`SIGNAL_EMBEDDING_MODEL`). */
export const ORACLE_EMBEDDING_MODEL = "openai/text-embedding-3-large";
/** List price of `ORACLE_EMBEDDING_MODEL`, USD per token ($0.13 per million). */
const ORACLE_USD_PER_TOKEN = 0.13 / 1_000_000;

/** An embedder that also reports its own spend, so the runner can keep it out of Signal's. */
export interface OracleEmbedder extends Embedder {
  spendUsd: () => number;
}

/**
 * The oracle's embedder, independent of Signal's: `ORACLE_EMBEDDING_MODEL` through the AI
 * Gateway when live, the offline fake otherwise. Its spend is tracked separately.
 */
export const createOracleEmbedder = ({ live }: { live: boolean }): OracleEmbedder => {
  if (!live) return { ...fakeEmbedder(), spendUsd: () => 0 };
  let tokens = 0;
  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const { embeddings, usage } = await embedMany({
        model: gatewayEmbeddingModel(ORACLE_EMBEDDING_MODEL),
        values: texts,
      });
      tokens += usage.tokens;
      return embeddings;
    },
    model: ORACLE_EMBEDDING_MODEL,
    spendUsd: () => tokens * ORACLE_USD_PER_TOKEN,
  };
};

export type Verdict = "accept" | "edit" | "reject";

/** Two needs share a listed solution (a "same solution, different need" case). */
export const shareSolution = (left: Need | undefined, right: Need | undefined) =>
  Boolean(
    left &&
    right &&
    left.solutions.some((solution) =>
      right.solutions.some((other) => other.toLowerCase() === solution.toLowerCase()),
    ),
  );
