// oxlint-disable eslint/no-await-in-loop -- tool files load and conversation turns run in order
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { dynamicTool, generateText, jsonSchema, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { ToolContext } from "eve/tools";

/**
 * Loads an Eve agent from `agents/<name>/agent` the way eve compiles it, for in-process
 * behaviour evals: the system prompt is `instructions.md` (plus `instructions/*.md`, sorted),
 * the tools are every file under `tools/` (named by filename, as eve does), and a dynamic tool
 * file (`defineDynamic`) contributes the tools its `session.started` resolver returns. Each eve
 * tool becomes an AI SDK tool with the JSON Schema eve would advertise and the same `execute`,
 * so Signal tools run through `lib/signal/adapters/agent.ts` → `executeOperation` unchanged.
 *
 * Not reproduced: eve's own runtime (durable workflow, built-in `eve__*` tools, compaction).
 * The model sees the same instructions and tool catalogue, which is what tool selection
 * depends on.
 */

export type AgentName = "assistant" | "operator";

export interface EveToolLike {
  description?: string;
  execute: (input: unknown, ctx: ToolContext) => unknown;
  inputSchema: unknown;
}

export interface LoadedAgent {
  instructions: string;
  modelId: string;
  name: AgentName;
  tools: Record<string, EveToolLike>;
}

const agentsRoot = path.resolve(import.meta.dirname, "..", "..", "agents");

const isEveTool = (value: unknown): value is EveToolLike =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as EveToolLike).execute === "function" &&
  "inputSchema" in (value as object);

interface DynamicLike {
  events: Record<string, () => unknown>;
  kind: "eve:dynamic";
}

const isDynamic = (value: unknown): value is DynamicLike =>
  Boolean(value) && typeof value === "object" && (value as DynamicLike).kind === "eve:dynamic";

const readInstructions = async (agentDir: string) => {
  const parts = [await readFile(path.join(agentDir, "instructions.md"), "utf-8")];
  const directory = path.join(agentDir, "instructions");
  const entries = await readdir(directory).catch(() => [] as string[]);
  for (const entry of entries.filter((name) => name.endsWith(".md")).toSorted())
    parts.push(await readFile(path.join(directory, entry), "utf-8"));
  return parts.map((part) => part.trim()).join("\n\n");
};

export const loadAgent = async (name: AgentName): Promise<LoadedAgent> => {
  const agentDir = path.join(agentsRoot, name, "agent");
  const agentModule = await import(path.join(agentDir, "agent.ts"));
  const definition = agentModule.default as { model?: unknown };
  if (typeof definition.model !== "string")
    throw new Error(`agents/${name}/agent/agent.ts must set a model id string`);

  const tools: Record<string, EveToolLike> = {};
  const toolDir = path.join(agentDir, "tools");
  const toolFiles = await readdir(toolDir);
  for (const file of toolFiles.filter((entry) => entry.endsWith(".ts")).toSorted()) {
    const toolModule = await import(path.join(toolDir, file));
    const exported = toolModule.default as unknown;
    if (isEveTool(exported)) tools[path.basename(file, ".ts")] = exported;
    else if (isDynamic(exported)) {
      const resolved = (exported.events["session.started"]?.() ?? {}) as Record<string, unknown>;
      for (const [toolName, value] of Object.entries(resolved))
        if (isEveTool(value)) tools[toolName] = value;
    }
  }
  return {
    instructions: await readInstructions(agentDir),
    modelId: definition.model,
    name,
    tools,
  };
};

/** The JSON Schema eve advertises for a tool (Standard Schema with JSON Schema, or plain). */
export const toolJsonSchema = (schema: unknown): Record<string, unknown> => {
  const standard = (
    schema as {
      "~standard"?: { jsonSchema?: { input?: (options: { target: string }) => unknown } };
    }
  )?.["~standard"];
  const json = standard?.jsonSchema?.input
    ? (standard.jsonSchema.input({ target: "draft-2020-12" }) as Record<string, unknown>)
    : (schema as Record<string, unknown>);
  const { $schema: _ignored, ...rest } = json;
  return rest;
};

// ---- Conversation runner ----

export interface ToolCallRecord {
  /** The tool exists for this agent; false means the model asked for a tool it does not have. */
  available: boolean;
  /** Set when the call failed or returned an error envelope (`{ error: { code } }`). */
  errorCode?: string;
  input: unknown;
  ms: number;
  name: string;
  output?: unknown;
  turn: number;
}

export interface TurnRecord {
  ms: number;
  steps: number;
  text: string;
  user: string;
}

export interface Transcript {
  agent: AgentName;
  availableTools: string[];
  modelId: string;
  toolCalls: ToolCallRecord[];
  turns: TurnRecord[];
}

const errorCodeOf = (output: unknown) => {
  if (!output || typeof output !== "object" || !("error" in output)) return;
  const { error } = output as { error: unknown };
  if (error && typeof error === "object" && "code" in error)
    return String((error as { code: unknown }).code);
  return typeof error === "string" ? error : "error";
};

export interface ConversationOptions {
  agent: LoadedAgent;
  /** Sent in order after the first message while `until` is not yet satisfied. */
  followUps?: string[];
  maxStepsPerTurn?: number;
  model: LanguageModel;
  prompt: string;
  /** Session id the tools see in `ctx.session.id` (the actor ref of written events). */
  sessionId: string;
  until?: (transcript: Transcript) => boolean;
}

/** Runs a multi-turn conversation with the agent's instructions and tools; records every call. */
export const runConversation = async ({
  agent,
  followUps = [],
  maxStepsPerTurn = 12,
  model,
  prompt,
  sessionId,
  until,
}: ConversationOptions): Promise<Transcript> => {
  const transcript: Transcript = {
    agent: agent.name,
    availableTools: Object.keys(agent.tools).toSorted(),
    modelId: agent.modelId,
    toolCalls: [],
    turns: [],
  };
  const ctx = { session: { id: sessionId } } as unknown as ToolContext;
  let turn = 0;
  const tools: ToolSet = Object.fromEntries(
    Object.entries(agent.tools).map(([name, eveTool]) => [
      name,
      dynamicTool({
        description: eveTool.description ?? "",
        execute: async (input: unknown) => {
          const started = performance.now();
          const record: ToolCallRecord = { available: true, input, ms: 0, name, turn };
          transcript.toolCalls.push(record);
          try {
            const output = await eveTool.execute(input, ctx);
            record.output = output;
            record.errorCode = errorCodeOf(output);
            return output;
          } catch (error) {
            record.errorCode = "thrown";
            record.output = { error: error instanceof Error ? error.message : String(error) };
            throw error;
          } finally {
            record.ms = Math.round(performance.now() - started);
          }
        },
        inputSchema: jsonSchema(toolJsonSchema(eveTool.inputSchema)),
      }),
    ]),
  );

  const messages: ModelMessage[] = [];
  const queue = [prompt, ...followUps];
  for (const [index, user] of queue.entries()) {
    if (index > 0 && until?.(transcript)) break;
    turn = index;
    messages.push({ content: user, role: "user" });
    const started = performance.now();
    const result = await generateText({
      messages,
      model,
      stopWhen: stepCountIs(maxStepsPerTurn),
      system: agent.instructions,
      tools,
    });
    messages.push(...result.response.messages);
    // Calls to tools the agent does not have never reach `execute`; record them from the steps.
    for (const step of result.steps)
      for (const call of step.toolCalls)
        if (!(call.toolName in tools))
          transcript.toolCalls.push({
            available: false,
            errorCode: "no_such_tool",
            input: call.input,
            ms: 0,
            name: call.toolName,
            turn,
          });
    transcript.turns.push({
      ms: Math.round(performance.now() - started),
      steps: result.steps.length,
      text: result.text,
      user,
    });
  }
  return transcript;
};
