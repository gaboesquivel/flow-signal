import type { Metadata } from "next";

import { ChatView } from "./chat-view";

export const metadata: Metadata = { title: "Chat · Signal" };

/** Demand questions answered by the Operator agent (POST /api/operator/chat). */
export default function ChatPage() {
  return <ChatView />;
}
