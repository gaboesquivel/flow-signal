import { defineDurableCallback, defineDurableSchema, defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";

import { executeOperation } from "../operations/execute";
import { operations } from "../operations/registry";
import type { AnyOperation } from "../operations/types";
import { signalOperationsFor } from "./mcp";
import { passthroughSchema } from "./schema";

/**
 * Eve adapter: one tool per operation. The Assistant gets public operations, the Operator all
 * of them (`agents/<agent>/agent/tools/signal.ts` resolves these with `defineDynamic`).
 * Callbacks are durable (`defineDurableCallback`) and capture only the operation name, so a
 * parked call replays in a fresh process. Errors return the envelope instead of throwing.
 */

export type SignalAgent = "assistant" | "operator";

const known = new Map<string, AnyOperation>(
  operations.map((operation) => [operation.name, operation]),
);

const lookup = (name: string) => {
  const operation = known.get(name);
  if (!operation) throw new Error(`Unknown Signal operation ${name}`);
  return operation;
};

export const signalAgentTools = (agent: SignalAgent, ops: readonly AnyOperation[] = operations) =>
  Object.fromEntries(
    signalOperationsFor(agent === "operator" ? "operator" : "public", ops).map((operation) => {
      known.set(operation.name, operation);
      return [
        operation.name,
        defineTool({
          description: operation.description,
          execute: defineDurableCallback({
            callback: async (
              { agent: agentName, name }: { agent: string; name: string },
              input: unknown,
              ctx?: Partial<ToolContext>,
            ) => {
              const result = await executeOperation(lookup(name), input, {
                client: `eve:${agentName}`,
                kind: "agent",
                ref: `eve:${agentName}:${ctx?.session?.id ?? "local"}`,
              });
              return result.ok ? result.data : { error: result.error };
            },
            closure: { agent, name: operation.name },
          }),
          inputSchema: defineDurableSchema({
            closure: { name: operation.name },
            schema: ({ name }: { name: string }) => passthroughSchema(lookup(name).input),
          }),
        }),
      ] as const;
    }),
  );
