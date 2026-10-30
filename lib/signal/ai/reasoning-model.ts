import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";

import { gatewayAvailable, gatewayModel, signalReasoningModelId } from "@/lib/ai/models";

import { SignalError } from "../errors";
import type { Reasoner } from "./ports";

/**
 * The one production `Reasoner` (`createGatewayAi().reasoner`, also exported as
 * `gatewayReasoner`): AI SDK structured output on the reasoning model (`SIGNAL_REASONING_MODEL`)
 * for every `ReasonerTask` (task 04's suggestion generation; task 05's priority, decision_brief,
 * and demand_summary). The caller's prompt, system, and zod schema shape the call. Any failure
 * (no Gateway, network, timeout, output that fails the schema) is `ai_unavailable`.
 */

/** Off the hot path, but an operator waits on briefs and demand summaries. */
const REASONING_TIMEOUT_MS = 60_000;

export interface ReasoningModelOptions {
  /** Injected in tests (`MockLanguageModelV4`); defaults to `SIGNAL_REASONING_MODEL` on the Gateway. */
  model?: LanguageModel;
  /** Recorded as the result's `model` (a suggestion's `model`); defaults to `signalReasoningModelId()`. */
  modelId?: string;
}

export const reasoningModelReasoner = (options: ReasoningModelOptions = {}): Reasoner => ({
  async generate({ prompt, schema, system, task }) {
    const what = `Reasoning (${task})`;
    if (!options.model && !gatewayAvailable())
      throw new SignalError("ai_unavailable", `${what} is unavailable (no AI Gateway access).`);
    const modelId = options.modelId ?? signalReasoningModelId();
    try {
      const result = await generateText({
        abortSignal: AbortSignal.timeout(REASONING_TIMEOUT_MS),
        maxRetries: 2,
        model: options.model ?? gatewayModel(modelId),
        output: Output.object({ schema }),
        prompt,
        ...(system ? { instructions: system } : {}),
      });
      return { model: modelId, value: schema.parse(result.output) };
    } catch (error) {
      const unavailable = new SignalError("ai_unavailable", `${what} is unavailable.`);
      unavailable.cause = error;
      throw unavailable;
    }
  },
});
