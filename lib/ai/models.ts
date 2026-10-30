import { createGateway, gateway } from "@ai-sdk/gateway";
import type { EmbeddingModel, LanguageModel } from "ai";

/** Vercel AI Gateway ids (dotted). `models.test.ts` checks them against the installed gateway's model list. */
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-5.5";
export const DEFAULT_GENUI_MODEL = "anthropic/claude-sonnet-4.6";
/** Signal hot path (extract, judge): fast structured output. */
export const DEFAULT_SIGNAL_FAST_MODEL = "anthropic/claude-haiku-5.5";
/** Signal off the hot path (scores, themes, summaries, briefs, demand summaries). */
export const DEFAULT_SIGNAL_REASONING_MODEL = "anthropic/claude-sonnet-5.5";
/** Decision tasks (decision briefs): spec 007, decision 0006. */
export const DEFAULT_SIGNAL_DECISION_MODEL = "anthropic/claude-fable-5.1";
/** Need embeddings; 1536 dimensions to match `needs.embedding`. */
export const DEFAULT_SIGNAL_EMBEDDING_MODEL = "openai/text-embedding-3-small";

const env = (name: string, environment: Record<string, string | undefined> = process.env) =>
  environment[name]?.trim() || undefined;

export const chatModelId = () => env("CHAT_MODEL") ?? DEFAULT_CHAT_MODEL;
export const genuiModelId = () => env("GENUI_MODEL") ?? DEFAULT_GENUI_MODEL;
export const eveModelId = ({ operator = false } = {}) =>
  (operator ? env("EVE_OPERATOR_MODEL") : undefined) ??
  env("EVE_AGENT_MODEL") ??
  DEFAULT_CHAT_MODEL;

export const signalFastModelId = (environment: Record<string, string | undefined> = process.env) =>
  env("SIGNAL_FAST_MODEL", environment) ?? DEFAULT_SIGNAL_FAST_MODEL;
export const signalReasoningModelId = (
  environment: Record<string, string | undefined> = process.env,
) => env("SIGNAL_REASONING_MODEL", environment) ?? DEFAULT_SIGNAL_REASONING_MODEL;
export const signalDecisionModelId = (
  environment: Record<string, string | undefined> = process.env,
) => env("SIGNAL_DECISION_MODEL", environment) ?? DEFAULT_SIGNAL_DECISION_MODEL;
export const signalEmbeddingModelId = (
  environment: Record<string, string | undefined> = process.env,
) => env("SIGNAL_EMBEDDING_MODEL", environment) ?? DEFAULT_SIGNAL_EMBEDDING_MODEL;

/**
 * Request-scoped Gateway BYOK (decision 0006): with `ANTHROPIC_API_KEY` set, the Gateway bills the
 * call to our Anthropic account; without it, the Gateway's own credentials are used. Spread into
 * `providerOptions`. The key never leaves the server except inside the Gateway request.
 *
 * A key that is not scoped to one Anthropic workspace needs `ANTHROPIC_WORKSPACE_ID`: it is sent
 * as the `anthropic-workspace-id` header on the BYOK credential only. Without it, Anthropic
 * rejects the BYOK attempt and the Gateway silently answers on its own credentials.
 */
export const anthropicByokOptions = (
  environment: Record<string, string | undefined> = process.env,
): {
  gateway?: {
    byok: { anthropic: { apiKey: string; headers?: Record<string, string> }[] };
  };
} => {
  const apiKey = env("ANTHROPIC_API_KEY", environment);
  if (!apiKey) return {};
  const workspaceId = env("ANTHROPIC_WORKSPACE_ID", environment);
  const headers = workspaceId ? { headers: { "anthropic-workspace-id": workspaceId } } : {};
  return { gateway: { byok: { anthropic: [{ apiKey, ...headers }] } } };
};

/** Direct Anthropic API ids are dashed: `anthropic/claude-sonnet-5.5` → `claude-sonnet-5-5`. */
export const directModelId = (gatewayId: string) =>
  gatewayId.replace(/^anthropic\//u, "").replaceAll(".", "-");

/** Gateway auth is a stored key, or Vercel OIDC, which arrives with each request on Vercel deployments. */
export const gatewayAvailable = (environment: Record<string, string | undefined> = process.env) =>
  Boolean(environment.AI_GATEWAY_API_KEY?.trim()) || environment.VERCEL === "1";

export const gatewayModel = (id: string): LanguageModel => {
  const apiKey = env("AI_GATEWAY_API_KEY");
  return apiKey ? createGateway({ apiKey })(id) : gateway(id);
};

export const gatewayEmbeddingModel = (id: string): EmbeddingModel => {
  const apiKey = env("AI_GATEWAY_API_KEY");
  return apiKey ? createGateway({ apiKey }).embeddingModel(id) : gateway.embeddingModel(id);
};
