import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

import { chatModelId, directModelId, gatewayAvailable, gatewayModel } from "./models";

export const resolveChatModel = (): LanguageModel | null => {
  if (gatewayAvailable()) return gatewayModel(chatModelId());

  const allowDirect = process.env.FLOW_ALLOW_DIRECT_ANTHROPIC?.trim() === "1";
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (allowDirect && anthropicKey)
    return createAnthropic({ apiKey: anthropicKey })(directModelId(chatModelId()));

  return null;
};

export const chatUnavailableResolution = () =>
  "Deploy on Vercel (AI Gateway authenticates through OIDC) or set AI_GATEWAY_API_KEY; for a local override, FLOW_ALLOW_DIRECT_ANTHROPIC=1 with ANTHROPIC_API_KEY.";
