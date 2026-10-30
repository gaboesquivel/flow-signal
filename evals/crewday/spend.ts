import { createGateway, gateway } from "ai";

import { pricesFromModelList, UsageMeter } from "../matching/cost";
import type { ModelCall, PriceTable } from "../matching/cost";

/**
 * Model spend for `pnpm eval:crewday` (spec 004 → Model spend per signal), on `evals/matching`'s
 * meter and price table. Every AI SDK call lands in one of two buckets, so the guardrail counts
 * only what Signal itself spends:
 *
 * - `runtime`: Signal's AI ports during a replay (the guardrail's numerator).
 * - `oracle`: the PM policy's "nearest need in the world" embedding lookup (eval overhead).
 *
 * The replay is sequential, so the bucket in force while a call is awaited is the bucket of every
 * model call it makes.
 */

export type SpendBucket = "runtime" | "oracle";

export class BucketedUsage extends UsageMeter {
  #bucket: SpendBucket = "runtime";
  #calls: Record<SpendBucket, ModelCall[]> = { oracle: [], runtime: [] };

  override record(call: ModelCall) {
    this.#calls[this.#bucket].push(call);
  }

  /** Runs `body` with every model call it makes counted in `bucket`. */
  async within<T>(bucket: SpendBucket, body: () => Promise<T>): Promise<T> {
    const previous = this.#bucket;
    this.#bucket = bucket;
    try {
      return await body();
    } finally {
      this.#bucket = previous;
    }
  }

  /** Calls recorded in `bucket` so far (a copy). */
  calls(bucket: SpendBucket) {
    return [...this.#calls[bucket]];
  }

  /** Empties `bucket` and returns what it held. */
  drain(bucket: SpendBucket) {
    const calls = this.#calls[bucket];
    this.#calls[bucket] = [];
    return calls;
  }
}

/** The Gateway's per-token prices, or an empty table (calls are then priced by reported cost only). */
export const loadGatewayPrices = async (): Promise<PriceTable> => {
  try {
    const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
    const provider = apiKey ? createGateway({ apiKey }) : gateway;
    return pricesFromModelList(await provider.getAvailableModels());
  } catch {
    return {};
  }
};
