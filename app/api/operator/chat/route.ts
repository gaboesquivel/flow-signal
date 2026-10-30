import type { ModelMessage } from "ai";

import { chatUnavailableResolution, resolveChatModel } from "@/lib/ai/resolve-chat-model";
import { operatorAccessDeniedResponse, verifyOperatorRequest } from "@/lib/auth/operator-access";
import { jsonError } from "@/lib/api/json-error";

import { answerOperatorQuestion } from "./answer";

/** The agent reads several operations before answering. */
export const maxDuration = 60;

const MAX_MESSAGES = 20;
const MAX_CONTENT = 4000;

interface ChatMessage {
  content: string;
  role: "assistant" | "user";
}

const isMessage = (value: unknown): value is ChatMessage =>
  Boolean(value) &&
  typeof value === "object" &&
  ((value as ChatMessage).role === "user" || (value as ChatMessage).role === "assistant") &&
  typeof (value as ChatMessage).content === "string" &&
  (value as ChatMessage).content.length <= MAX_CONTENT;

/**
 * Operator chat (PM console → Chat): the Operator agent answers demand questions with Signal's
 * read operations. POST `{ messages: [{ role, content }] }` (the last one the PM's question);
 * returns `{ answer, cited, sources }` as JSON. Operator access only (secret or session cookie).
 */
export const POST = async (request: Request) => {
  const access = verifyOperatorRequest(request);
  if (!access.ok) return operatorAccessDeniedResponse({ reason: access.reason });

  const model = resolveChatModel();
  if (!model)
    return jsonError({
      code: "chat_unavailable",
      message: "Chat model credentials are not configured.",
      resolution: chatUnavailableResolution(),
      status: 503,
    });

  let messages: ChatMessage[];
  try {
    const body = (await request.json()) as { messages?: unknown };
    const parsed: unknown[] = Array.isArray(body.messages) ? body.messages : [];
    if (
      parsed.length === 0 ||
      parsed.length > MAX_MESSAGES ||
      !parsed.every(isMessage) ||
      parsed.at(-1)?.role !== "user"
    )
      return jsonError({
        code: "invalid_request",
        message: `Send 1–${MAX_MESSAGES} messages, each { role: "user" | "assistant", content } (at most ${MAX_CONTENT} characters), ending with the user's question.`,
        resolution: "POST JSON with a messages array.",
        status: 400,
      });
    messages = parsed;
  } catch {
    return jsonError({
      code: "invalid_json",
      message: "Request body must be valid JSON.",
      resolution: "Send Content-Type application/json.",
      status: 400,
    });
  }

  try {
    const answer = await answerOperatorQuestion({
      messages: messages as ModelMessage[],
      model,
    });
    return Response.json(answer);
  } catch (error) {
    console.error(
      "[operator-chat] answer failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return jsonError({
      code: "chat_unavailable",
      message: "The Operator agent could not answer right now.",
      resolution: "Try again in a moment.",
      status: 503,
    });
  }
};
