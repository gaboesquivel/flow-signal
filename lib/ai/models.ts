import { createGateway, gateway } from "@ai-sdk/gateway";
import type { EmbeddingModel, LanguageModel } from "ai";

/** Vercel AI Gateway ids (dotted). `models.test.ts` checks them against the installed gateway's model list. */
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-5.5";
export const DEFAULT_GENUI_MODEL = "anthropic/claude-sonnet-4.6";
/** Signal hot path (extract, judge): fast structured output. */
export const DEFAULT_SIGNAL_FAST_MODEL = "anthropic/claude-haiku-5.5";
/** Signal off the hot path (scores, themes, summaries, briefs, demand summaries). */
export const DEFAULT_SIGNAL_REASONING_MODEL = "anthropic/claude-sonnet-5.5";
/** Decision tasks (decision briefs): spec 007, decision 0008. */
export const DEFAULT_SIGNAL_DECISION_MODEL = "anthropic/claude-sonnet-5.5";
/** Closed-set classification (spec 008): a decision model answering typed questions on the Gateway. */
export const DEFAULT_SIGNAL_CLASSIFIER_MODEL = "typesafe-ai/jev";
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

export const signalClassifierModelId = (
  environment: Record<string, string | undefined> = process.env,
) => env("SIGNAL_CLASSIFIER_MODEL", environment) ?? DEFAULT_SIGNAL_CLASSIFIER_MODEL;

/** Classification calls that can move from the fast LLM to the classifier model (spec 008). */
export const SIGNAL_CLASSIFIER_CALLS = ["match_judge"] as const;
export type SignalClassifierCall = (typeof SIGNAL_CLASSIFIER_CALLS)[number];
/** Calls on the classifier by default: only where the spec 008 eval showed it wins. */
export const DEFAULT_SIGNAL_CLASSIFIER_CALLS: readonly SignalClassifierCall[] = ["match_judge"];

/**
 * `SIGNAL_CLASSIFIER_CALLS` overrides the default per deployment: a comma-separated list of
 * calls (`match_judge`), or `none`. Unknown names are ignored.
 */
export const signalClassifierCalls = (
  environment: Record<string, string | undefined> = process.env,
): ReadonlySet<SignalClassifierCall> => {
  const raw = env("SIGNAL_CLASSIFIER_CALLS", environment);
  if (raw === undefined) return new Set(DEFAULT_SIGNAL_CLASSIFIER_CALLS);
  const known = new Set<string>(SIGNAL_CLASSIFIER_CALLS);
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name): name is SignalClassifierCall => known.has(name)),
  );
};

/**
 * Gateway auth is a stored key, or Vercel OIDC: it arrives with each request on Vercel
 * deployments, and locally as `VERCEL_OIDC_TOKEN` from `vercel env pull` (expires after about
 * 12 hours; pull again). The Gateway provider reads that token itself when no key is set.
 */
export const gatewayAvailable = (environment: Record<string, string | undefined> = process.env) =>
  Boolean(environment.AI_GATEWAY_API_KEY?.trim()) ||
  Boolean(environment.VERCEL_OIDC_TOKEN?.trim()) ||
  environment.VERCEL === "1";

/** The one AI Gateway provider: every model call, runtime and evals, goes through it (spec 010). */
export const gatewayProvider = () => {
  const apiKey = env("AI_GATEWAY_API_KEY");
  return apiKey ? createGateway({ apiKey }) : gateway;
};

export const gatewayModel = (id: string): LanguageModel => gatewayProvider()(id);

export const gatewayEmbeddingModel = (id: string): EmbeddingModel =>
  gatewayProvider().embeddingModel(id);

/** A V4 decision model, as `experimental_decide` takes it (`ai` does not re-export the type). */
export type DecisionModel = ReturnType<ReturnType<typeof createGateway>["decisionModel"]>;

export const gatewayDecisionModel = (id: string): DecisionModel =>
  gatewayProvider().decisionModel(id);
