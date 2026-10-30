import { MockLanguageModelV4 } from "ai/test";

/**
 * A scripted stand-in for the agent model (`pnpm eval:agents --fake`): proves the harness
 * wiring (instructions, tool catalogue, real Signal tools on the seeded database, checks)
 * offline. It is not an agent result. `turns[t][s]` is what the model says at step `s` of user
 * turn `t`: tool calls to make, or a final text. Past the end of a turn's script it replies
 * "Done.".
 */

interface ScriptCall {
  input: unknown;
  name: string;
}

export interface ScriptStep {
  calls?: ScriptCall[];
  text?: string;
}

export type ScriptTurns = ScriptStep[][];

interface PromptMessage {
  role: string;
}

/** Turn = user messages so far − 1; step = assistant messages since the last user message. */
export const scriptPosition = (prompt: readonly PromptMessage[]) => {
  const lastUser = prompt.findLastIndex((message) => message.role === "user");
  const turn = prompt.filter((message) => message.role === "user").length - 1;
  const step = prompt.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
  return { step, turn };
};

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 100, total: 100 },
  outputTokens: { reasoning: 0, text: 20, total: 20 },
};

export const scriptedModel = (turns: ScriptTurns) => {
  let callId = 0;
  return new MockLanguageModelV4({
    doGenerate: ({ prompt }) => {
      const { step, turn } = scriptPosition(prompt);
      const scripted = turns[turn]?.[step] ?? { text: "Done." };
      const content = [
        ...(scripted.text ? [{ text: scripted.text, type: "text" as const }] : []),
        ...(scripted.calls ?? []).map((call) => ({
          input: JSON.stringify(call.input),
          toolCallId: `call_${(callId += 1)}`,
          toolName: call.name,
          type: "tool-call" as const,
        })),
      ];
      const toolCalls = Boolean(scripted.calls?.length);
      return Promise.resolve({
        content,
        finishReason: toolCalls
          ? { raw: "tool_use", unified: "tool-calls" as const }
          : { raw: "stop", unified: "stop" as const },
        usage,
        warnings: [],
      });
    },
    modelId: "scripted",
    provider: "fake",
  });
};
