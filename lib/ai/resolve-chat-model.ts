import type { LanguageModel } from "ai";

import { chatModelId, gatewayAvailable, gatewayModel } from "./models";

/** Chat runs only on the AI Gateway; there is no direct provider path (spec 010). */
export const resolveChatModel = (): LanguageModel | null =>
  gatewayAvailable() ? gatewayModel(chatModelId()) : null;

export const chatUnavailableResolution = () =>
  "Deploy on Vercel (AI Gateway authenticates through OIDC) or set AI_GATEWAY_API_KEY.";
