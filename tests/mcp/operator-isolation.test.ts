import assert from "node:assert/strict";
import { test } from "vitest";

import { GET as getRest, POST as postRest } from "../../app/api/[...path]/route";
import { POST as postPublicMcp } from "../../app/api/mcp/route";
import { POST as postOperatorMcp } from "../../app/api/mcp/operator/route";
import { operatorMcpToolNames } from "../../lib/mcp/register-operator-tools";
import { signalAgentTools } from "../../lib/signal/adapters/agent";

const mcpHeaders = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

const mcpPost = (
  handler: (request: Request) => Response | Promise<Response>,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) =>
  handler(
    new Request("http://signal.localhost/api/mcp", {
      body: JSON.stringify(body),
      headers: { ...mcpHeaders, ...extraHeaders },
      method: "POST",
    }),
  );

test("public MCP tools/list excludes operator-only tools", async () => {
  const response = await mcpPost(postPublicMcp, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  assert.equal(response.status, 200);
  const json = (await response.json()) as {
    result?: { tools?: { name: string }[] };
  };
  const names = new Set((json.result?.tools ?? []).map((tool) => tool.name));
  for (const operatorTool of operatorMcpToolNames) assert.equal(names.has(operatorTool), false);
});

test("operator MCP fails closed when OPERATOR_SECRET unset", async () => {
  const previous = process.env.OPERATOR_SECRET;
  delete process.env.OPERATOR_SECRET;
  delete process.env.OPERATOR_ACCESS_TOKEN;
  try {
    const response = await mcpPost(postOperatorMcp, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    });
    assert.equal(response.status, 503);
  } finally {
    if (previous !== undefined) process.env.OPERATOR_SECRET = previous;
  }
});

test("operator MCP rejects missing bearer token when configured", async () => {
  const previous = process.env.OPERATOR_SECRET;
  process.env.OPERATOR_SECRET = "test-operator-token-16chars";
  delete process.env.OPERATOR_ACCESS_TOKEN;
  try {
    const response = await mcpPost(postOperatorMcp, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-03-26",
      },
    });
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = previous;
  }
});

/** Spec 006 → Exposure: the console's new operator operations. */
const consoleOperations = [
  { method: "GET", name: "list_operator_needs", path: "/api/operator/needs?sort=people" },
  {
    body: JSON.stringify({ text: "Thanks Maya" }),
    method: "POST",
    name: "check_public_text",
    path: "/api/operator/check-public-text",
  },
] as const;

const restCall = (
  operation: (typeof consoleOperations)[number],
  headers: Record<string, string> = {},
) => {
  const handler = operation.method === "GET" ? getRest : postRest;
  return handler(
    new Request(`http://signal.localhost${operation.path}`, {
      ...("body" in operation ? { body: operation.body } : {}),
      headers: { "content-type": "application/json", ...headers },
      method: operation.method,
    }),
  );
};

const withOperatorSecret = async (secret: string | undefined, body: () => Promise<void>) => {
  const previous = process.env.OPERATOR_SECRET;
  if (secret === undefined) delete process.env.OPERATOR_SECRET;
  else process.env.OPERATOR_SECRET = secret;
  delete process.env.OPERATOR_ACCESS_TOKEN;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = previous;
  }
};

test("console operator operations are operator-only and absent from public discovery", async () => {
  for (const { name } of consoleOperations) assert.ok(operatorMcpToolNames.includes(name));
  const response = await mcpPost(postPublicMcp, {
    id: 1,
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  const json = (await response.json()) as { result?: { tools?: { name: string }[] } };
  const names = new Set((json.result?.tools ?? []).map((tool) => tool.name));
  for (const { name } of consoleOperations) assert.equal(names.has(name), false);
  const assistant = signalAgentTools("assistant");
  for (const { name } of consoleOperations) assert.equal(assistant[name], undefined);
});

test("console operator operations are not callable on the public MCP", async () => {
  for (const { name } of consoleOperations) {
    const response = await mcpPost(postPublicMcp, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { text: "Thanks Maya" }, name },
    });
    const json = (await response.json()) as {
      error?: unknown;
      result?: { isError?: boolean; structuredContent?: unknown };
    };
    assert.ok(json.error || json.result?.isError, `${name} ran on the public MCP`);
  }
});

test("console operator operations return unauthorized over REST without the secret", async () => {
  await withOperatorSecret("test-operator-token-16chars", async () => {
    for (const operation of consoleOperations) {
      for (const headers of [{}, { authorization: "Bearer wrong-token-0123456789" }] as Record<
        string,
        string
      >[]) {
        const response = await restCall(operation, headers);
        assert.equal(response.status, 401, operation.name);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, "unauthorized");
      }
    }
  });
});

test("console operator operations fail closed when OPERATOR_SECRET is unset", async () => {
  await withOperatorSecret(undefined, async () => {
    for (const operation of consoleOperations) {
      const response = await restCall(operation, {
        authorization: "Bearer test-operator-token-16chars",
      });
      assert.equal(response.status, 401, operation.name);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "unauthorized");
    }
  });
});
