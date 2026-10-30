import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { handleMcpRequest } from "../../lib/mcp/handle-mcp-request";
import { signalAgentTools } from "../../lib/signal/adapters/agent";
import { createSignalHttpHandler, resetHttpRateLimits } from "../../lib/signal/adapters/http";
import { registerSignalMcpTools } from "../../lib/signal/adapters/mcp";
import {
  consumeRateLimit,
  rateLimitBucketCount,
  resetRateLimits,
} from "../../lib/signal/adapters/rate-limit";
import { defineOperation } from "../../lib/signal/operations/types";
import type { AnyOperation } from "../../lib/signal/operations/types";

/** Spec 001 → Exposure: every surface returns the same envelope for failures and limits. */

const leaky = defineOperation({
  access: "public",
  description: "Test-only operation that fails with a driver error carrying SQL and params.",
  errors: [],
  http: { method: "POST", path: "/api/leaky" },
  input: z.object({}),
  name: "leaky_probe",
  output: z.object({ ok: z.boolean() }),
  run: () =>
    Promise.reject(
      new Error(
        "Failed query: select * from submitters where email = $1\nparams: maya@acme.example",
      ),
    ),
});

const limited = defineOperation({
  access: "public",
  description: "Test-only operation with a tight per-operation rate limit.",
  errors: [],
  http: { method: "POST", path: "/api/limited" },
  input: z.object({}),
  limits: { requestsPerMinute: 2 },
  name: "limited_probe",
  output: z.object({ ok: z.boolean() }),
  run: () => Promise.resolve({ ok: true }),
});

const ops: readonly AnyOperation[] = [leaky, limited];

const callMcpTool = async (name: string, ip = "203.0.113.7") => {
  const response = await handleMcpRequest({
    createServer: (request) => {
      const server = new McpServer({ name: "probe", version: "1.0.0" });
      registerSignalMcpTools(server, { access: "public", ops, request });
      return server;
    },
    request: new Request("http://signal.localhost/api/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-forwarded-for": ip,
      },
      method: "POST",
    }),
  });
  const json = (await response.json()) as {
    result: { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };
  };
  return json.result;
};

const internalEnvelope = {
  error: { code: "internal", message: "Something went wrong.", retryable: true },
};

// A configured (unreachable) database, so the context builds; the probes never query it.
const priorDatabaseUrl = process.env.DATABASE_URL;
beforeEach(() => {
  process.env.DATABASE_URL = "postgres://user:pass@db.invalid/signal";
});
afterEach(() => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
});

describe("unexpected errors on every surface", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetHttpRateLimits();
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("REST returns 500 with the internal envelope", async () => {
    const response = await createSignalHttpHandler(ops)(
      new Request("http://signal.localhost/api/leaky", { body: "{}", method: "POST" }),
    );
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual(internalEnvelope);
  });

  it("MCP returns a tool error with the internal envelope and no driver text", async () => {
    const result = await callMcpTool("leaky_probe");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(internalEnvelope);
    expect(JSON.stringify(result)).not.toMatch(/maya|Failed query/u);
  });

  it("the Eve tool returns the internal envelope", async () => {
    const tool = signalAgentTools("assistant", ops).leaky_probe!;
    const output: unknown = await tool.execute({}, {
      session: { id: "t" },
    } as unknown as ToolContext);
    expect(output).toEqual(internalEnvelope);
  });

  it("logs without the message or params", async () => {
    await callMcpTool("leaky_probe");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().map(String).join(" ")).not.toMatch(/maya|Failed query/u);
  });
});

describe("per-operation rate limits on the public MCP", () => {
  beforeEach(() => resetHttpRateLimits());

  it("returns rate_limited once a client exceeds the operation's limit", async () => {
    expect((await callMcpTool("limited_probe")).isError).toBeFalsy();
    expect((await callMcpTool("limited_probe")).isError).toBeFalsy();
    const third = await callMcpTool("limited_probe");
    expect(third.isError).toBe(true);
    expect(third.structuredContent).toEqual({
      error: { code: "rate_limited", message: expect.any(String), retryable: true },
    });
    // Another client is not affected.
    expect((await callMcpTool("limited_probe", "198.51.100.1")).isError).toBeFalsy();
  });

  it("shares the budget with REST for the same client and operation", async () => {
    const http = createSignalHttpHandler(ops);
    const post = () =>
      http(
        new Request("http://signal.localhost/api/limited", {
          body: "{}",
          headers: { "x-forwarded-for": "203.0.113.9" },
          method: "POST",
        }),
      );
    expect((await post())?.status).toBe(200);
    expect((await callMcpTool("limited_probe", "203.0.113.9")).isError).toBeFalsy();
    expect((await post())?.status).toBe(429);
  });
});

describe("shared rate limiter", () => {
  beforeEach(() => resetRateLimits());

  it("prunes expired buckets so the map does not grow forever", () => {
    const start = 1_000_000;
    for (let index = 0; index < 50; index += 1) consumeRateLimit(`op:10.0.0.${index}`, 5, start);
    expect(rateLimitBucketCount()).toBe(50);
    consumeRateLimit("op:10.0.1.1", 5, start + 61_000);
    expect(rateLimitBucketCount()).toBe(1);
  });

  it("returns seconds to wait once the limit is exceeded", () => {
    expect(consumeRateLimit("k", 1, 0)).toBeUndefined();
    expect(consumeRateLimit("k", 1, 10_000)).toBe(50);
  });
});
