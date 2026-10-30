import { generateText } from "ai";

import { gatewayAvailable, genuiModelId } from "../../ai/models";

export const synthesizeOpenEndedAnswer = async ({
  query,
  signal,
}: {
  query: string;
  signal?: AbortSignal;
}) => {
  if (!gatewayAvailable()) return null;

  const model = genuiModelId();

  const result = await generateText({
    abortSignal: signal,
    maxOutputTokens: 600,
    model,
    prompt: `Answer briefly using only general product knowledge. Do not invent URLs, code, or credentials.\n\nQuestion: ${query}`,
  });

  const text = result.text.trim();
  return text.length > 0 ? text : null;
};
