import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { signalDecisionModelId, signalFastModelId, signalReasoningModelId } from "@/lib/ai/models";
import { EXTRACT_INSTRUCTIONS, JUDGE_INSTRUCTIONS } from "@/lib/signal/ai/gateway";
import type { Embedder, MatchJudgement, SignalAi } from "@/lib/signal/ai/ports";
import { DECISION_TASKS } from "@/lib/signal/ai/reasoning-model";

/**
 * `--cached` (spec 004 → Reproducibility; task 05): dev runs replay AI responses from a local
 * cache keyed by model, prompt hash, and input, so a repeated dev run or a sweep cell whose AI
 * inputs did not change costs nothing. Tagged runs never use it (they are always live).
 *
 * The cache wraps the AI ports, not the HTTP calls:
 * - extractor: the fast model, `EXTRACT_INSTRUCTIONS`, and the submission's title and body.
 * - judge: the judge model, `JUDGE_INSTRUCTIONS`, the submission, the draft, and the candidates'
 *   statements. Database ids are random per run, so verdicts are stored by candidate position and
 *   mapped back to this run's ids on replay.
 * - reasoner: the task's model (decision tasks run on the decision model), the system prompt, the
 *   prompt, and the output schema (as JSON Schema). A replayed value is re-validated by the schema.
 * - embedder (Signal's and the PM oracle's): the model and the texts.
 * The retriever is a database query and is never cached. A call that throws is not stored.
 *
 * Entries live in one JSON-lines file (`evals/crewday/.cache/ai-responses.jsonl`, gitignored),
 * appended as misses resolve, so a crashed run keeps what it paid for.
 */

export const DEFAULT_CACHE_FILE = path.join(import.meta.dirname, ".cache", "ai-responses.jsonl");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface CacheStats {
  hits: number;
  /** Calls the cache could not answer: these went to the wrapped (live) port. */
  misses: number;
}

export class AiResponseCache {
  #entries = new Map<string, unknown>();
  #file: string | null;
  stats: CacheStats = { hits: 0, misses: 0 };

  /** `file`: JSON-lines store to load and append to; null keeps the cache in memory (tests). */
  constructor(file: string | null = DEFAULT_CACHE_FILE) {
    this.#file = file;
    if (!file) return;
    let text = "";
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const { key, value } = JSON.parse(line) as { key: string; value: unknown };
        this.#entries.set(key, value);
      } catch {
        // A torn last line from a crashed run: skip it; the call is simply made again.
      }
    }
  }

  get size() {
    return this.#entries.size;
  }

  /** Answers `parts` from the cache, or runs `call`, stores its value, and returns it. */
  async through<T>(parts: unknown[], call: () => Promise<T>): Promise<T> {
    const key = sha256(JSON.stringify(parts));
    if (this.#entries.has(key)) {
      this.stats.hits += 1;
      return this.#entries.get(key) as T;
    }
    this.stats.misses += 1;
    const value = await call();
    this.#entries.set(key, value);
    if (this.#file) {
      mkdirSync(path.dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, `${JSON.stringify({ key, value })}\n`);
    }
    return value;
  }
}

const promptHash = (...texts: string[]) => sha256(texts.join("\u0000")).slice(0, 16);

/** An embedder whose answers come from `cache` when it has them (Signal's or the oracle's). */
export const cacheEmbedder = <E extends Embedder>(embedder: E, cache: AiResponseCache): E => ({
  ...embedder,
  embed: (texts: string[]) =>
    texts.length === 0
      ? embedder.embed(texts)
      : cache.through(["embed", embedder.model, "", texts], () => embedder.embed(texts)),
  model: embedder.model,
});

/** Signal's AI ports with every model call answered from `cache` when it can be. */
export const cacheSignalAi = (ai: SignalAi, cache: AiResponseCache): SignalAi => ({
  embedder: cacheEmbedder(ai.embedder, cache),
  extractor: {
    extract: (input) =>
      cache.through(
        [
          "extract",
          signalFastModelId(),
          promptHash(EXTRACT_INSTRUCTIONS),
          { body: input.body, title: input.title },
        ],
        () => ai.extractor.extract(input),
      ),
  },
  judge: {
    judge: async (input) => {
      if (input.candidates.length === 0) return ai.judge.judge(input);
      const stored = await cache.through(
        [
          "judge",
          ai.judge.model,
          promptHash(JUDGE_INSTRUCTIONS),
          {
            candidates: input.candidates.map((candidate) => candidate.statement),
            draft: input.draft ?? null,
            submission: { body: input.submission.body, title: input.submission.title },
          },
        ],
        async () => {
          const judgements = await ai.judge.judge(input);
          return judgements.flatMap(({ needId, probability, reason }) => {
            const position = input.candidates.findIndex((c) => c.needId === needId);
            return position === -1 ? [] : [{ position, probability, reason }];
          });
        },
      );
      return stored.flatMap(({ position, probability, reason }): MatchJudgement[] => {
        const candidate = input.candidates[position];
        return candidate ? [{ needId: candidate.needId, probability, reason }] : [];
      });
    },
    model: ai.judge.model,
  },
  reasoner: {
    generate: async (input) => {
      const model = DECISION_TASKS.has(input.task)
        ? signalDecisionModelId()
        : signalReasoningModelId();
      const schema = JSON.stringify(z.toJSONSchema(input.schema, { unrepresentable: "any" }));
      const stored = await cache.through(
        [
          "reason",
          model,
          promptHash(input.system ?? "", schema),
          { prompt: input.prompt, task: input.task },
        ],
        () => ai.reasoner.generate(input),
      );
      return { model: stored.model, value: input.schema.parse(stored.value) };
    },
  },
  retriever: ai.retriever,
});
