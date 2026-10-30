import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { eveModelId, gatewayAvailable } from "@/lib/ai/models";
import { getOperatorAccessToken, isOperatorAccessConfigured } from "@/lib/auth/operator-access";
import { operations } from "@/lib/signal/operations/registry";

import { starterMcpToolCatalog } from "./tool-catalog";
import { asToolResult } from "./tool-result";

const plainToolMeta = { _meta: {} };

/** Tools only the Operator MCP lists: diagnostics plus Signal's `access: "operator"` operations. */
export const operatorMcpToolNames: readonly string[] = [
  "operator_health",
  "config_status",
  "public_tool_catalog",
  ...operations.filter((operation) => operation.access === "operator").map(({ name }) => name),
];

export const registerOperatorMcpTools = (server: McpServer) => {
  registerAppTool(
    server,
    "operator_health",
    {
      ...plainToolMeta,
      description: "Protected liveness check for the Operator MCP server (owner only).",
      inputSchema: { ping: z.boolean().optional() },
    },
    () =>
      asToolResult({
        ok: true,
        role: "operator",
        service: "signal-operator-mcp",
      }),
  );

  registerAppTool(
    server,
    "config_status",
    {
      ...plainToolMeta,
      description: "Report non-secret configuration status for diagnostics (owner only).",
      inputSchema: { verbose: z.boolean().optional() },
    },
    ({ verbose }) =>
      asToolResult({
        aiGateway: gatewayAvailable(),
        eveModel: eveModelId(),
        operatorConfigured: isOperatorAccessConfigured(),
        operatorTokenLength: getOperatorAccessToken().length,
        verbose: verbose ?? false,
      }),
  );

  registerAppTool(
    server,
    "public_tool_catalog",
    {
      ...plainToolMeta,
      description: "List public Assistant MCP tools (diagnostic; does not expose operator tools).",
      inputSchema: { detail: z.boolean().optional() },
    },
    () =>
      asToolResult({
        publicTools: starterMcpToolCatalog.map((tool) => tool.name),
      }),
  );
};
