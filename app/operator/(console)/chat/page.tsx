import type { Metadata } from "next";
import { connection } from "next/server";

import { isOperatorAssistantEnabled } from "@/lib/flags/operator-assistant";

import { AssistantView } from "./assistant-view";
import { ChatView } from "./chat-view";

export const metadata: Metadata = { title: "Chat · Signal" };

/**
 * Demand questions answered by the Operator agent. With `OPERATOR_ASSISTANT=on` the page is the
 * experimental assistant (spec 014: POST /api/operator/assistant); otherwise the spec 006 chat
 * (POST /api/operator/chat).
 */
export default async function ChatPage() {
  // The flag is read per request, never baked in at build time.
  await connection();
  return isOperatorAssistantEnabled() ? <AssistantView /> : <ChatView />;
}
