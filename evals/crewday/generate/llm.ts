import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createGateway, generateText, Output } from "ai";
import type { z } from "zod";

/**
 * Cached structured calls to the AI Gateway for world generation. Every response is stored under
 * `generate/.cache/` (gitignored), keyed by model, instructions, prompt, and a salt, so a crashed
 * or repeated run replays from disk at no cost. Each entry keeps what the call cost when it was
 * made, so the total spend of a world is the sum over the entries it used.
 */

export const cacheDir = path.join(import.meta.dirname, ".cache");

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface CacheEntry {
  costUsd: number;
  inputTokens: number;
  modelId: string;
  output: unknown;
  outputTokens: number;
}

export interface Spend {
  calls: number;
  /** Calls answered from the cache in this run (their cost was paid in an earlier run). */
  cachedCalls: number;
  /** USD, every call this run used, cached or not. */
  totalUsd: number;
  /** USD actually spent by this run. */
  newUsd: number;
}

export const spendByModel = new Map<string, Spend>();

/** Records one call's cost; a paid call counts even when its output is then rejected. */
export const recordSpend = (modelId: string, costUsd: number, cached: boolean) => {
  const spend = spendByModel.get(modelId) ?? { cachedCalls: 0, calls: 0, newUsd: 0, totalUsd: 0 };
  spend.calls += 1;
  spend.totalUsd += costUsd;
  if (cached) spend.cachedCalls += 1;
  else spend.newUsd += costUsd;
  spendByModel.set(modelId, spend);
};

class UnpricedCallError extends Error {
  override name = "UnpricedCallError";
}

// An empty key falls back to the Gateway's own resolution (VERCEL_OIDC_TOKEN).
const provider = () =>
  createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY?.trim() || undefined });

let prices: Record<string, { input: number; output: number }> | undefined;
const priceOf = async (modelId: string) => {
  if (!prices) {
    const { models } = await provider().getAvailableModels();
    prices = Object.fromEntries(
      models.flatMap((model) =>
        model.pricing
          ? [
              [
                model.id,
                { input: Number(model.pricing.input), output: Number(model.pricing.output) },
              ],
            ]
          : [],
      ),
    );
  }
  return prices[modelId];
};

const gatewayCost = (metadata: unknown) => {
  const cost = (metadata as { gateway?: { cost?: unknown } } | undefined)?.gateway?.cost;
  const value = typeof cost === "string" ? Number(cost) : cost;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export interface CallOptions<Schema extends z.ZodType> {
  instructions: string;
  modelId: string;
  prompt: string;
  /** Changes the cache key without changing the prompt (a fresh sample of the same request). */
  salt?: string;
  schema: Schema;
  temperature?: number;
}

export const callStructured = async <Schema extends z.ZodType>(
  options: CallOptions<Schema>,
): Promise<z.infer<Schema>> => {
  const { instructions, modelId, prompt, salt = "", schema, temperature } = options;
  const key = sha256(JSON.stringify([modelId, instructions, prompt, salt, temperature ?? null]));
  const file = path.join(cacheDir, `${key}.json`);
  try {
    const entry = JSON.parse(await readFile(file, "utf-8")) as CacheEntry;
    const parsed = schema.safeParse(entry.output);
    if (parsed.success) {
      recordSpend(modelId, entry.costUsd, true);
      return parsed.data;
    }
  } catch {
    // Not cached yet.
  }
  // Priced before any call, so a failed price lookup never discards a paid response.
  const price = await priceOf(modelId);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Retries are sequential by design.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const result = await generateText({
        instructions,
        maxRetries: 2,
        model: provider()(modelId),
        output: Output.object({ schema }),
        prompt,
        ...(temperature === undefined ? {} : { temperature }),
      });
      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      const costUsd =
        gatewayCost(result.providerMetadata) ??
        (price ? inputTokens * price.input + outputTokens * price.output : undefined);
      // An unpriceable call would make the spend cap meaningless: stop rather than count it as 0.
      if (costUsd === undefined)
        throw new UnpricedCallError(`no reported cost and no listed price for ${modelId}`);
      // Paid whether or not the output parses: record it before parsing.
      recordSpend(modelId, costUsd, false);
      const output = schema.parse(result.output);
      const entry: CacheEntry = { costUsd, inputTokens, modelId, output, outputTokens };
      // oxlint-disable-next-line eslint/no-await-in-loop
      await mkdir(cacheDir, { recursive: true });
      // oxlint-disable-next-line eslint/no-await-in-loop
      await writeFile(file, JSON.stringify(entry));
      return output;
    } catch (error) {
      if (error instanceof UnpricedCallError) throw error;
      lastError = error;
    }
  }
  throw lastError;
};

/** Runs `task` over `items` with at most `limit` in flight, keeping input order. */
export const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // oxlint-disable-next-line eslint/no-await-in-loop
      results[index] = await task(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
