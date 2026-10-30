import { GET, POST, PUT } from "@/app/api/[...path]/route";
import { POST as postOperatorMcp } from "@/app/api/mcp/operator/route";
import { POST as postPublicMcp } from "@/app/api/mcp/route";
import { mcpRequestFor, restRequestFor } from "@/lib/signal/adapters/in-process";
import type { McpJsonRpcResponse } from "@/lib/signal/adapters/in-process";
import type { ErrorCode } from "@/lib/signal/errors";
import { findOperation } from "@/lib/signal/operations/registry";

import type { AiMeter } from "./meter";

/**
 * The surface router (spec 004 → Surfaces): every policy action is a real request to Signal's
 * route handlers, in process. Web personas use REST as humans; personas filing through the support
 * copilot use the public MCP route (actor kind `agent`, client `crewday-copilot`); the PM uses
 * REST (human) or the Operator MCP route (agent, client `crewday-pm`), alternating by week.
 *
 * Each request carries its own `X-Forwarded-For`: the adapters' rate limiters count wall-clock
 * minutes, and a replay compresses a year into seconds, so without this they would throttle a
 * workload that is ordinary in world time.
 */

export type Surface = "rest" | "public_mcp" | "operator_mcp";

export const COPILOT_CLIENT = "crewday-copilot";
export const PM_CLIENT = "crewday-pm";

export type CallResult =
  | { data: unknown; ok: true }
  | { code: ErrorCode | "transport"; message: string; ok: false };

export interface SurfaceRouter {
  call: (
    surface: Surface,
    operation: string,
    input: Record<string, unknown>,
  ) => Promise<CallResult>;
  /** Requests sent per surface. */
  mix: Record<Surface, number>;
}

const restHandlers = { GET, POST, PUT } as const;

const fromEnvelope = (body: unknown): CallResult => {
  if (body && typeof body === "object" && "error" in body) {
    const { error } = body as { error: { code: ErrorCode; message: string } };
    return { code: error.code, message: error.message, ok: false };
  }
  return { data: body, ok: true };
};

export const createSurfaceRouter = ({
  meter,
  operatorSecret,
}: {
  meter: AiMeter;
  operatorSecret: string;
}): SurfaceRouter => {
  const mix: Record<Surface, number> = { operator_mcp: 0, public_mcp: 0, rest: 0 };
  let requestNumber = 0;
  const nextAddress = () => {
    requestNumber += 1;
    const octet = (shift: number) => Math.floor(requestNumber / 256 ** shift) % 256;
    return `10.${octet(2)}.${octet(1)}.${octet(0)}`;
  };

  const send = async (
    surface: Surface,
    operationName: string,
    input: Record<string, unknown>,
  ): Promise<CallResult> => {
    const operation = findOperation(operationName);
    if (!operation) throw new Error(`Unknown operation ${operationName}`);
    const headers: Record<string, string> = { "x-forwarded-for": nextAddress() };
    if (surface === "rest") {
      if (operation.access === "operator") headers.authorization = `Bearer ${operatorSecret}`;
      const response = await restHandlers[operation.http.method](
        restRequestFor(operation, input, headers),
      );
      return fromEnvelope(await response.json());
    }
    const access = surface === "operator_mcp" ? "operator" : "public";
    if (access === "public" && operation.access !== "public")
      throw new Error(`${operationName} is not on the public MCP server`);
    headers["x-mcp-client"] = access === "operator" ? PM_CLIENT : COPILOT_CLIENT;
    if (access === "operator") headers.authorization = `Bearer ${operatorSecret}`;
    const handler = access === "operator" ? postOperatorMcp : postPublicMcp;
    const response = await handler(
      mcpRequestFor(access, "tools/call", { arguments: input, name: operationName }, headers),
    );
    const json = (await response.json()) as McpJsonRpcResponse & {
      error?: { message: string };
    };
    if (!json.result)
      return {
        code: "transport",
        message: json.error?.message ?? `MCP status ${response.status}`,
        ok: false,
      };
    return fromEnvelope((json.result as { structuredContent?: unknown }).structuredContent);
  };

  return {
    call: (surface, operation, input) => {
      mix[surface] += 1;
      return meter.withOperation(operation, () => send(surface, operation, input));
    },
    mix,
  };
};
