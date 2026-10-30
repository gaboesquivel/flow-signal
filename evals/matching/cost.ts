import type { Telemetry } from "ai";

/**
 * Model spend for the eval. The AI ports do not return usage, so the runner registers an AI SDK
 * telemetry integration (`registerTelemetry(meter.telemetry())`) that sees every model call made
 * through the AI SDK, then prices each call: the Gateway's reported cost when present, else the
 * Gateway's per-token prices.
 */

export interface ModelCall {
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  /** Cost the Gateway reported for this call (providerMetadata.gateway.cost), in USD. */
  reportedCostUsd?: number;
}

/** USD per token. */
export interface ModelPrice {
  input: number;
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

export const callCostUsd = (call: ModelCall, prices: PriceTable) => {
  if (call.reportedCostUsd !== undefined) return call.reportedCostUsd;
  const price = prices[call.modelId];
  if (!price) return;
  return call.inputTokens * price.input + call.outputTokens * price.output;
};

export interface CostSummary {
  calls: number;
  totalUsd: number;
  /** Calls with neither a reported cost nor a known price; `totalUsd` leaves them out. */
  unpricedCalls: number;
}

/** Spend per model id, so each step's cost per signal can be read (spec 008). */
export const costByModel = (calls: ModelCall[], prices: PriceTable) => {
  const byModel = new Map<string, ModelCall[]>();
  for (const call of calls) byModel.set(call.modelId, [...(byModel.get(call.modelId) ?? []), call]);
  return Object.fromEntries(
    [...byModel].map(([modelId, list]) => [modelId, summarizeCost(list, prices)]),
  );
};

export const summarizeCost = (calls: ModelCall[], prices: PriceTable): CostSummary => {
  let totalUsd = 0;
  let unpricedCalls = 0;
  for (const call of calls) {
    const cost = callCostUsd(call, prices);
    if (cost === undefined) unpricedCalls += 1;
    else totalUsd += cost;
  }
  return { calls: calls.length, totalUsd, unpricedCalls };
};

const toNumber = (value: unknown) => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
};

const gatewayCost = (metadata: unknown) => {
  if (!metadata || typeof metadata !== "object") return;
  const { gateway } = metadata as Record<string, unknown>;
  if (!gateway || typeof gateway !== "object") return;
  return toNumber((gateway as Record<string, unknown>).cost);
};

export class UsageMeter {
  #calls: ModelCall[] = [];

  record(call: ModelCall) {
    this.#calls.push(call);
  }

  /** Returns the calls recorded since the last `take` and starts a new phase. */
  take() {
    const calls = this.#calls;
    this.#calls = [];
    return calls;
  }

  telemetry(): Telemetry {
    return {
      // Decision models (spec 008: Jev on the Gateway) report usage and cost the same way.
      experimental_onDecisionModelCallEnd: (event) => {
        const reportedCostUsd = gatewayCost(event.providerMetadata);
        this.record({
          inputTokens: event.usage?.inputTokens ?? 0,
          modelId: event.modelId,
          outputTokens: event.usage?.outputTokens ?? 0,
          ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
        });
      },
      onEmbedEnd: (event) => {
        this.record({
          inputTokens: event.usage?.tokens ?? 0,
          modelId: event.modelId,
          outputTokens: 0,
        });
      },
      onLanguageModelCallEnd: (event) => {
        const reportedCostUsd = gatewayCost(event.providerMetadata);
        this.record({
          inputTokens: event.usage?.inputTokens ?? 0,
          modelId: event.modelId,
          outputTokens: event.usage?.outputTokens ?? 0,
          ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
        });
      },
    };
  }
}

/** Gateway model list → per-token prices; models without pricing are left out. */
export const pricesFromModelList = (models: {
  models: { id: string; pricing?: { input: string; output: string } | null }[];
}): PriceTable =>
  Object.fromEntries(
    models.models.flatMap(({ id, pricing }) => {
      const input = toNumber(pricing?.input);
      const output = toNumber(pricing?.output);
      return input === undefined || output === undefined ? [] : [[id, { input, output }]];
    }),
  );
