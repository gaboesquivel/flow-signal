import type { Access, AnyOperation } from "../operations/types";

/**
 * Requests for calling Signal's REST and MCP route handlers in process (no network): the parity
 * suite (`tests/signal/parity/harness.ts`) and the Crewday simulation (`evals/crewday/sim`) build
 * the same requests a real client sends and pass them to the route handlers directly. Callers add
 * their own headers (Operator bearer, `X-Signal-Agent`, `X-MCP-Client`, `X-Forwarded-For`).
 */

/** Not a real host: requests never leave the process. */
const IN_PROCESS_ORIGIN = "http://signal.localhost";

const pathParameter = /:(?<name>[a-zA-Z]+)/gu;

/**
 * The REST request for an operation: `:param` segments from the input, the rest as the query
 * string (GET) or JSON body.
 */
export const restRequestFor = (
  operation: AnyOperation,
  input: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  const pathNames = new Set(
    [...operation.http.path.matchAll(pathParameter)].map((match) => match.groups?.name),
  );
  const path = operation.http.path.replaceAll(pathParameter, (_match, name: string) =>
    encodeURIComponent(String(input[name])),
  );
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !pathNames.has(key)));
  const url = new URL(`${IN_PROCESS_ORIGIN}${path}`);
  const allHeaders = { "content-type": "application/json", ...headers };
  if (operation.http.method === "GET") {
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, String(item));
    }
    return new Request(url, { headers: allHeaders, method: "GET" });
  }
  return new Request(url, {
    body: JSON.stringify(rest),
    headers: allHeaders,
    method: operation.http.method,
  });
};

/** A stateless JSON-RPC request to the public (`/api/mcp`) or Operator MCP route. */
export const mcpRequestFor = (
  access: Access,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  new Request(`${IN_PROCESS_ORIGIN}/api/mcp${access === "operator" ? "/operator" : ""}`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

export interface McpJsonRpcResponse {
  error?: { message: string };
  result?: Record<string, unknown>;
}
