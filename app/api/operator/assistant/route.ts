import { resolveChatModel } from "@/lib/ai/resolve-chat-model";

import { handleAssistantRequest } from "./stream";

/** The assistant reads, shows data, and proposes across several steps before answering. */
export const maxDuration = 60;

/**
 * Operator assistant (spec 014 → Assistant routes): POST `{ messages: UIMessage[] }` (≤ 40,
 * ≤ 256 KB) → a UI message stream with read tools, `show_data`, `propose_*` cards, and a
 * `data-warnings` part. Operator access only; `not_found` while `OPERATOR_ASSISTANT` is off. It
 * never runs a write: the PM confirms on `POST /api/operator/assistant/actions/:id`.
 */
export const POST = (request: Request) =>
  handleAssistantRequest(request, { model: resolveChatModel() });
