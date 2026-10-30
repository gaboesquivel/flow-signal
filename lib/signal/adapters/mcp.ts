import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";

import { asToolResult } from "@/lib/mcp/tool-result";

import { toErrorEnvelope } from "../errors";
import { executeOperation } from "../operations/execute";
import { operations } from "../operations/registry";
import type { Access, AnyOperation } from "../operations/types";
import { consumeOperationRateLimit, RATE_LIMITED_MESSAGE } from "./rate-limit";
import { passthroughSchema } from "./schema";

/**
 * MCP adapter: registers operations as tools. The public server (`/api/mcp`) gets
 * `access: "public"` operations; the Operator server (`/api/mcp/operator`, already behind
 * `verifyOperatorRequest`) gets all of them. Calls run as actor kind `agent` with the MCP
 * client's name. Errors return `isError` with the envelope in `structuredContent`. Public
 * operations share the REST adapter's per-operation, per-IP limits (`operation.limits`).
 */

const clientName = (server: McpServer, request?: Request) =>
  server.server.getClientVersion()?.name ??
  request?.headers.get("x-mcp-client")?.trim().slice(0, 100) ??
  "mcp";

export const signalOperationsFor = (access: Access, ops: readonly AnyOperation[] = operations) =>
  access === "operator" ? ops : ops.filter((operation) => operation.access === "public");

export const registerSignalMcpTools = (
  server: McpServer,
  {
    access,
    ops = operations,
    request,
  }: { access: Access; ops?: readonly AnyOperation[]; request?: Request },
) => {
  for (const operation of signalOperationsFor(access, ops)) {
    registerAppTool(
      server,
      operation.name,
      {
        _meta: {},
        description: operation.description,
        inputSchema: passthroughSchema(operation.input),
      },
      async (args: unknown) => {
        if (consumeOperationRateLimit(operation, request) !== undefined)
          return {
            ...asToolResult(toErrorEnvelope("rate_limited", RATE_LIMITED_MESSAGE)),
            isError: true,
          };
        const client = clientName(server, request);
        const result = await executeOperation(operation, args, {
          client,
          kind: "agent",
          ref: `mcp:${client}`,
        });
        if (result.ok) return asToolResult(result.data);
        return { ...asToolResult({ error: result.error }), isError: true };
      },
    );
  }
};
