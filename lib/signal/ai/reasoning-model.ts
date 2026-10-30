import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";

import { gatewayAvailable, gatewayModel, signalReasoningModelId } from "@/lib/ai/models";

import { SignalError } from "../errors";
import type { Reasoner } from "./ports";

/**
 * A task-agnostic `Reasoner` on the reasoning model (`SIGNAL_REASONING_MODEL`) with AI SDK
 * structured output: the caller's zod schema shapes and validates the value. Task 05 uses it for
 * `priority`, `decision_brief`, and `demand_summary`; it works for any `ReasonerTask` because the
 * prompt, system, and schema come from the caller. Any failure (no Gateway, network, timeout,
 * output that fails the schema) is `ai_unavailable`.
 *
 * Integration: `gatewayReasoner()` in `gateway.ts` can delegate to this for tasks it does not
 * handle itself (it is a stub until tasks 04/05 merge).
 */

/** Off the hot path, but an operator waits on briefs and demand summaries. */
const REASONING_TIMEOUT_MS = 60_000;

export const reasoningModelReasoner = ({ model }: { model?: LanguageModel } = {}): Reasoner => ({
  async generate({ prompt, schema, system, task }) {
    if (!model && !gatewayAvailable())
      throw new SignalError(
        "ai_unavailable",
        `Reasoning (${task}) is unavailable (no AI Gateway access).`,
      );
    const modelId = signalReasoningModelId();
    try {
      const result = await generateText({
        abortSignal: AbortSignal.timeout(REASONING_TIMEOUT_MS),
        maxRetries: 1,
        model: model ?? gatewayModel(modelId),
        output: Output.object({ schema }),
        prompt,
        system,
      });
      return { model: modelId, value: schema.parse(result.output) };
    } catch (error) {
      const unavailable = new SignalError("ai_unavailable", `Reasoning (${task}) is unavailable.`);
      unavailable.cause = error;
      throw unavailable;
    }
  },
});
