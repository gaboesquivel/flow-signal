import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";

import {
  anthropicByokOptions,
  gatewayAvailable,
  gatewayModel,
  signalDecisionModelId,
  signalReasoningModelId,
} from "@/lib/ai/models";

import { SignalError } from "../errors";
import type { Reasoner, ReasonerTask } from "./ports";

/**
 * The one production `Reasoner` (`createGatewayAi().reasoner`, also exported as
 * `gatewayReasoner`): AI SDK structured output for every `ReasonerTask`. Decision tasks
 * (`DECISION_TASKS`) run on the decision model (`SIGNAL_DECISION_MODEL`, Claude Fable 5.1, decision
 * 0006) with Gateway BYOK on `ANTHROPIC_API_KEY`, `effort: "medium"`, Anthropic's server-side
 * refusal fallback, and a longer timeout; they never send disabled thinking (Fable rejects it).
 * Every other task runs on the reasoning model (`SIGNAL_REASONING_MODEL`). The caller's prompt,
 * system, and zod schema shape the call. Any failure (no Gateway, network, timeout, output that
 * fails the schema) is `ai_unavailable`.
 */

/** Tasks that recommend a product decision and run on the decision model. */
export const DECISION_TASKS: ReadonlySet<ReasonerTask> = new Set<ReasonerTask>(["decision_brief"]);

/** Off the hot path, but an operator waits on briefs and demand summaries. */
const REASONING_TIMEOUT_MS = 60_000;
/** Fable always thinks; briefs stay off the hot path, so this is a ceiling. */
const DECISION_TIMEOUT_MS = 180_000;

export interface ReasoningModelOptions {
  /** Injected in tests (`MockLanguageModelV4`); defaults to the task's model on the Gateway. */
  model?: LanguageModel;
  /**
   * Recorded as the result's `model` (a suggestion's `model`); defaults to
   * `signalDecisionModelId()` for decision tasks and `signalReasoningModelId()` otherwise.
   */
  modelId?: string;
}

/** Provider options for a decision task: BYOK (when the key is set) plus Anthropic effort and fallback. */
export const decisionProviderOptions = () => ({
  ...anthropicByokOptions(),
  anthropic: { effort: "medium" as const, fallbacks: "default" as const },
});

interface GatewayRouting {
  routing?: {
    modelAttempts?: {
      providerAttempts?: { credentialType?: string; error?: string; success?: boolean }[];
    }[];
  };
}

/**
 * The error of a failed BYOK attempt in the Gateway's routing metadata, if any. The Gateway then
 * answers on its own credentials without telling the caller, so the call succeeds but is not
 * billed to our Anthropic account (for example a key that needs `ANTHROPIC_WORKSPACE_ID`).
 */
export const byokFailure = (providerMetadata: unknown): string | undefined => {
  const gateway = (providerMetadata as { gateway?: GatewayRouting } | undefined)?.gateway;
  for (const model of gateway?.routing?.modelAttempts ?? [])
    for (const attempt of model.providerAttempts ?? [])
      if (attempt.credentialType === "byok" && attempt.success === false)
        return attempt.error ?? "unknown error";
  return undefined;
};

export const reasoningModelReasoner = (options: ReasoningModelOptions = {}): Reasoner => ({
  async generate({ prompt, schema, system, task }) {
    const what = `Reasoning (${task})`;
    if (!options.model && !gatewayAvailable())
      throw new SignalError("ai_unavailable", `${what} is unavailable (no AI Gateway access).`);
    const decision = DECISION_TASKS.has(task);
    const modelId =
      options.modelId ?? (decision ? signalDecisionModelId() : signalReasoningModelId());
    try {
      const result = await generateText({
        abortSignal: AbortSignal.timeout(decision ? DECISION_TIMEOUT_MS : REASONING_TIMEOUT_MS),
        maxRetries: 2,
        model: options.model ?? gatewayModel(modelId),
        output: Output.object({ schema }),
        prompt,
        ...(decision ? { providerOptions: decisionProviderOptions() } : {}),
        ...(system ? { instructions: system } : {}),
      });
      const byokError = decision ? byokFailure(result.providerMetadata) : undefined;
      if (byokError)
        console.warn(`${what}: Gateway BYOK failed, answered on Gateway credentials: ${byokError}`);
      // A server-side refusal fallback answers on another model; record which one did.
      const model = decision ? result.response.modelId || modelId : modelId;
      return { model, value: schema.parse(result.output) };
    } catch (error) {
      const unavailable = new SignalError("ai_unavailable", `${what} is unavailable.`);
      unavailable.cause = error;
      throw unavailable;
    }
  },
});
