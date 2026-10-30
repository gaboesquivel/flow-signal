import { AsyncLocalStorage } from "node:async_hooks";

import { gatewayProvider } from "@/lib/ai/models";

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
 * The bucket follows the async context (AsyncLocalStorage), not a field: background suggestion
 * generation overlaps the replay, so a call made concurrently with an oracle lookup still lands
 * in `runtime`. AI SDK telemetry fires inside the call's own async chain.
 */

type SpendBucket = "runtime" | "oracle";

export class BucketedUsage extends UsageMeter {
  #bucket = new AsyncLocalStorage<SpendBucket>();
  #calls: Record<SpendBucket, ModelCall[]> = { oracle: [], runtime: [] };

  override record(call: ModelCall) {
    this.#calls[this.#bucket.getStore() ?? "runtime"].push(call);
  }

  /** Runs `body` with every model call it makes counted in `bucket`. */
  within<T>(bucket: SpendBucket, body: () => Promise<T>): Promise<T> {
    return this.#bucket.run(bucket, body);
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
    return pricesFromModelList(await gatewayProvider().getAvailableModels());
  } catch {
    return {};
  }
};
