import { createGateway, gateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";

/** Vercel AI Gateway ids (dotted). `models.test.ts` checks them against the installed gateway's model list. */
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-5.5";
export const DEFAULT_GENUI_MODEL = "anthropic/claude-sonnet-4.6";

const env = (name: string) => process.env[name]?.trim() || undefined;

export const chatModelId = () => env("CHAT_MODEL") ?? DEFAULT_CHAT_MODEL;
export const genuiModelId = () => env("GENUI_MODEL") ?? DEFAULT_GENUI_MODEL;
export const eveModelId = ({ operator = false } = {}) =>
  (operator ? env("EVE_OPERATOR_MODEL") : undefined) ??
  env("EVE_AGENT_MODEL") ??
  DEFAULT_CHAT_MODEL;

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
