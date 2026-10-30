import { readFile } from "node:fs/promises";
import path from "node:path";

import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";

import { citedNeeds, needsInToolOutput } from "@/app/operator/(console)/_lib/chat";
import type { ChatAnswer, CitedNeed } from "@/app/operator/(console)/_lib/chat";
import { inputJsonSchema } from "@/lib/signal/adapters/schema";
import { executeOperation } from "@/lib/signal/operations/execute";
import { operations } from "@/lib/signal/operations/registry";

/**
 * The Operator agent answering one console chat question (spec 006 task 07). It runs with the
 * Operator agent's own instructions (`agents/operator/agent/instructions.md`) and the same
 * Signal operations its Eve tools wrap, limited to reads: the console chat answers questions and
 * never resolves, merges, scores, or publishes (those stay on Triage and the need page).
 */

/** Read-only Signal operations the console chat may call. */
export const operatorChatTools = [
  "get_demand_summary",
  "list_operator_needs",
  "search_needs",
  "get_need",
  "get_need_detail",
  "get_criteria",
  "get_metrics",
  "list_suggestions",
] as const;

const CONSOLE_RULES = `## Answering in the PM console chat

You are answering a product manager in Signal's console. Answer from tool results only; never invent needs, accounts, or numbers.

- Questions about a plan or segment ("enterprise accounts", "Growth customers") call **get_demand_summary** with \`plan\` set to that plan (\`Enterprise\`, \`Growth\`, or \`Starter\`). Questions about one account use \`accountId\`.
- Link every need you mention as \`[a few words](need:<needId>)\`, using the id from the tool result. Name accounts in plain text.
- Write two short paragraphs or a short list: what they are blocked on, the biggest needs by people and value, and what is already planned or in progress. No headings, no tables.
- You can only read. If asked to change something, say where in the console to do it (Triage, a need's page, Criteria).`;

let instructions: Promise<string> | null = null;

const agentInstructions = () => {
  instructions ??= readFile(
    path.join(process.cwd(), "agents", "operator", "agent", "instructions.md"),
    "utf-8",
  ).catch(() => "");
  return instructions;
};

export const operatorChatSystem = async () => {
  const base = await agentInstructions();
  return [base.trim(), CONSOLE_RULES].filter(Boolean).join("\n\n");
};

type RunOperation = typeof executeOperation;

/** One AI SDK tool per allowed operation, run through `executeOperation` as the Operator agent. */
export const buildOperatorChatTools = (
  onResult: (call: { input: unknown; name: string; output: unknown }) => void,
  run: RunOperation = executeOperation,
): ToolSet =>
  Object.fromEntries(
    operations
      .filter((operation) => (operatorChatTools as readonly string[]).includes(operation.name))
      .map((operation) => [
        operation.name,
        tool({
          description: operation.description,
          execute: async (input: unknown) => {
            const result = await run(operation, input, {
              client: "console:operator-chat",
              kind: "agent",
              ref: "console:operator-chat",
            });
            const output = result.ok ? result.data : { error: result.error };
            onResult({ input, name: operation.name, output });
            return output;
          },
          // Advertise the real shape; executeOperation validates and returns the error envelope.
          inputSchema: jsonSchema(inputJsonSchema(operation.input)),
        }),
      ]),
  );

export const answerOperatorQuestion = async ({
  messages,
  model,
  run,
}: {
  messages: ModelMessage[];
  model: LanguageModel;
  /** Tests replace the operation runner; the route uses `executeOperation`. */
  run?: RunOperation;
}): Promise<ChatAnswer> => {
  const sources: ChatAnswer["sources"] = [];
  const seen: CitedNeed[] = [];
  const result = await generateText({
    messages,
    model,
    stopWhen: stepCountIs(8),
    system: await operatorChatSystem(),
    tools: buildOperatorChatTools(({ input, name, output }) => {
      sources.push({ input, name });
      seen.push(...needsInToolOutput(output));
    }, run),
  });
  const answer = result.text.trim();
  return { answer, cited: citedNeeds(answer, seen), sources };
};
