import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as getServerCard } from "../../app/.well-known/mcp/server-card.json/route";
import { buildOpenApiDocument } from "../../lib/openapi/build-openapi-document";
import { handleMcpRequest } from "../../lib/mcp/handle-mcp-request";
import { signalAgentTools } from "../../lib/signal/adapters/agent";
import { createSignalHttpHandler, matchOperationPath } from "../../lib/signal/adapters/http";
import { registerSignalMcpTools } from "../../lib/signal/adapters/mcp";
import { signalOpenApiPaths } from "../../lib/signal/adapters/openapi";
import { inputJsonSchema } from "../../lib/signal/adapters/schema";
import { errorCodes } from "../../lib/signal/errors";
import { allOperations, operations } from "../../lib/signal/operations/registry";
import { defineOperation, isPlanned } from "../../lib/signal/operations/types";
import type { AnyOperation } from "../../lib/signal/operations/types";
import { mcpCall, OPERATOR_SECRET } from "./parity/harness";

/** Spec 001 → Agent- and API-first: the operation table every surface must implement. */
const specTable = [
  ["search_needs", "public", "GET", "/api/needs"],
  ["get_need", "public", "GET", "/api/needs/:id"],
  ["preview_signal", "public", "POST", "/api/signals/preview"],
  ["submit_signal", "public", "POST", "/api/signals"],
  ["get_my_signals", "public", "GET", "/api/my-signals/:token"],
  ["list_suggestions", "operator", "GET", "/api/operator/suggestions"],
  ["resolve_suggestion", "operator", "POST", "/api/operator/suggestions/:id/resolve"],
  ["merge_needs", "operator", "POST", "/api/operator/needs/:id/merge"],
  ["undo_merge", "operator", "POST", "/api/operator/merges/:id/undo"],
  ["split_need", "operator", "POST", "/api/operator/needs/:id/split"],
  ["get_need_detail", "operator", "GET", "/api/operator/needs/:id"],
  ["get_criteria", "operator", "GET", "/api/operator/criteria"],
  ["set_criteria", "operator", "PUT", "/api/operator/criteria"],
  ["get_demand_summary", "operator", "GET", "/api/operator/demand"],
  ["draft_decision_brief", "operator", "POST", "/api/operator/needs/:id/decision-brief"],
  ["publish_decision", "operator", "POST", "/api/operator/needs/:id/decision"],
  ["get_metrics", "operator", "GET", "/api/operator/metrics"],
  // Spec 006 → Contract changes.
  ["list_operator_needs", "operator", "GET", "/api/operator/needs"],
  ["check_public_text", "operator", "POST", "/api/operator/check-public-text"],
  // Spec 007 → Typed API contract.
  ["get_strategy", "operator", "GET", "/api/operator/strategy"],
  ["set_strategy", "operator", "PUT", "/api/operator/strategy"],
  ["list_ready_needs", "operator", "GET", "/api/operator/needs/ready"],
] as const;

const withoutDialect = (schema: Record<string, unknown>) => {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
};

const jsonSchemaOf = (schema: unknown) =>
  withoutDialect(
    (
      schema as {
        "~standard": { jsonSchema: { input: (o: { target: string }) => Record<string, unknown> } };
      }
    )["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  );

interface ListedTool {
  inputSchema: Record<string, unknown>;
  name: string;
}

const listTools = async (access: "public" | "operator") => {
  const json = await mcpCall(access, "tools/list", {});
  return (json.result?.tools ?? []) as ListedTool[];
};

const withSecret = (secret: string | undefined) => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.OPERATOR_SECRET;
    if (secret === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = secret;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = prior;
  });
};

describe("operation registry", () => {
  it("holds every spec 001 operation with its access and REST mapping", () => {
    expect(
      allOperations.map(({ access, http, name }) => [name, access, http.method, http.path]),
    ).toEqual(specTable);
  });

  it("uses unique snake_case names and unique routes", () => {
    const names = allOperations.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
    const routes = allOperations.map(({ http }) => `${http.method} ${http.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("exposes only built operations, each with a contract and a parity table", () => {
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => !isPlanned(operation))).toBe(true);
    for (const operation of operations) {
      expect(operation.description.length, operation.name).toBeGreaterThan(20);
      expect(operation.input).toBeInstanceOf(z.ZodObject);
      for (const code of operation.errors) expect(errorCodes).toContain(code);
      const parityFile = path.join(
        import.meta.dirname,
        "parity",
        `${operation.name.replaceAll("_", "-")}.parity.test.ts`,
      );
      expect(existsSync(parityFile), `missing ${parityFile}`).toBe(true);
    }
  });
});

describe("surfaces generated from the registry", () => {
  withSecret(OPERATOR_SECRET);

  it("lists public operations on the public MCP with the registry's input schema", async () => {
    const tools = await listTools("public");
    for (const operation of operations) {
      const tool = tools.find((candidate) => candidate.name === operation.name);
      if (operation.access === "operator") {
        expect(tool, operation.name).toBeUndefined();
        continue;
      }
      assert.ok(tool, `${operation.name} missing from public MCP`);
      expect(withoutDialect(tool.inputSchema)).toEqual(
        withoutDialect(inputJsonSchema(operation.input)),
      );
    }
  });

  it("lists every operation on the Operator MCP with the registry's input schema", async () => {
    const tools = await listTools("operator");
    for (const operation of operations) {
      const tool = tools.find((candidate) => candidate.name === operation.name);
      assert.ok(tool, `${operation.name} missing from Operator MCP`);
      expect(withoutDialect(tool.inputSchema)).toEqual(
        withoutDialect(inputJsonSchema(operation.input)),
      );
    }
  });

  it("gives the Assistant public tools and the Operator agent all tools, same schemas", () => {
    const assistant = signalAgentTools("assistant");
    const operator = signalAgentTools("operator");
    for (const operation of operations) {
      const expected = withoutDialect(inputJsonSchema(operation.input));
      assert.ok(operator[operation.name], `${operation.name} missing from Operator agent`);
      expect(jsonSchemaOf(operator[operation.name]!.inputSchema)).toEqual(expected);
      if (operation.access === "public") {
        assert.ok(assistant[operation.name], `${operation.name} missing from Assistant`);
        expect(jsonSchemaOf(assistant[operation.name]!.inputSchema)).toEqual(expected);
      } else expect(assistant[operation.name]).toBeUndefined();
    }
  });

  it("gates the Operator agent's write tools on user approval, and only those", () => {
    const writes = [
      "merge_needs",
      "publish_decision",
      "resolve_suggestion",
      "set_criteria",
      "set_strategy",
      "split_need",
      "undo_merge",
    ];
    expect(
      operations
        .filter((operation) => operation.effects === "write" && operation.access === "operator")
        .map((operation) => operation.name)
        .toSorted(),
    ).toEqual(writes);
    const operator = signalAgentTools("operator");
    const assistant = signalAgentTools("assistant");
    for (const operation of operations) {
      const tool = operator[operation.name] as { approval?: unknown };
      if (writes.includes(operation.name)) expect(tool.approval, operation.name).toBeDefined();
      else expect(tool.approval, operation.name).toBeUndefined();
      const publicTool = assistant[operation.name] as { approval?: unknown } | undefined;
      expect(publicTool?.approval, operation.name).toBeUndefined();
    }
  });

  it("routes every operation over REST", () => {
    for (const operation of operations) {
      const samplePath = operation.http.path.replaceAll(/:[a-zA-Z]+/gu, "x");
      const match = matchOperationPath(operations, operation.http.method, samplePath);
      assert.ok(match && match !== "method_not_allowed", `${operation.name} has no route`);
      expect(match.operation.name).toBe(operation.name);
    }
  });

  it("publishes public operations only in OpenAPI and the MCP server card", async () => {
    const doc = buildOpenApiDocument("https://signal.example");
    const card = (await getServerCard(
      new Request("https://signal.example/.well-known/mcp/server-card.json"),
    ).json()) as {
      tools: { name: string }[];
    };
    const cardNames = card.tools.map((tool) => tool.name);
    for (const operation of operations) {
      const docPath = operation.http.path.replaceAll(/:(?<name>[a-zA-Z]+)/gu, "{$<name>}");
      const listed = (doc.paths as Record<string, Record<string, unknown>>)[docPath]?.[
        operation.http.method.toLowerCase()
      ];
      if (operation.access === "public") {
        assert.ok(listed, `${operation.name} missing from OpenAPI`);
        expect(cardNames).toContain(operation.name);
      } else {
        expect(listed).toBeUndefined();
        expect(cardNames).not.toContain(operation.name);
      }
    }
  });
});

/** A throwaway Operator operation proves the access rules before tasks 04–06 add real ones. */
const operatorProbe = defineOperation({
  access: "operator",
  description: "Test-only Operator operation used to prove access isolation on every surface.",
  errors: [],
  http: { method: "GET", path: "/api/operator/probe" },
  input: z.object({}),
  name: "operator_probe",
  output: z.object({ ok: z.boolean() }),
  run: () => Promise.resolve({ ok: true }),
});
const probeOps: readonly AnyOperation[] = [...operations, operatorProbe];

const probeTools = async (access: "public" | "operator") => {
  const response = await handleMcpRequest({
    createServer: (request) => {
      const server = new McpServer({ name: "probe", version: "1.0.0" });
      registerSignalMcpTools(server, { access, ops: probeOps, request });
      return server;
    },
    request: new Request("http://signal.localhost/api/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    }),
  });
  const json = (await response.json()) as { result: { tools: { name: string }[] } };
  return json.result.tools.map((tool) => tool.name);
};

describe("Operator operations", () => {
  const http = createSignalHttpHandler(probeOps);
  const probe = (headers: Record<string, string> = {}) =>
    http(new Request("http://signal.localhost/api/operator/probe", { headers }));

  describe("with OPERATOR_SECRET set", () => {
    withSecret(OPERATOR_SECRET);

    it("return unauthorized over REST without the secret", async () => {
      const response = await probe();
      assert.ok(response);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "unauthorized", message: expect.any(String), retryable: false },
      });
    });

    it("return unauthorized over REST with a wrong secret", async () => {
      const response = await probe({ authorization: "Bearer wrong-secret-0123456789" });
      expect(response?.status).toBe(401);
    });

    it("are absent from the public MCP and the Assistant, present for the Operator", async () => {
      expect(await probeTools("public")).not.toContain("operator_probe");
      expect(await probeTools("operator")).toContain("operator_probe");
      expect(signalAgentTools("assistant", probeOps).operator_probe).toBeUndefined();
      expect(signalAgentTools("operator", probeOps).operator_probe).toBeDefined();
      expect(Object.keys(signalOpenApiPaths())).not.toContain("/api/operator/probe");
    });
  });

  describe("without OPERATOR_SECRET", () => {
    withSecret(undefined);

    it("fail closed over REST even with a bearer token", async () => {
      const response = await probe({ authorization: `Bearer ${OPERATOR_SECRET}` });
      assert.ok(response);
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "unauthorized",
      );
    });
  });
});

describe("REST adapter", () => {
  const http = createSignalHttpHandler(operations);

  it("ignores paths that are not operations", async () => {
    expect(await http(new Request("http://signal.localhost/api/unknown"))).toBeUndefined();
  });

  it("rejects an unsupported method on an operation path", async () => {
    const response = await http(
      new Request("http://signal.localhost/api/needs", { method: "PUT" }),
    );
    expect(response?.status).toBe(405);
  });

  it("returns database_unavailable (503) without a database", async () => {
    const prior = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const response = await http(new Request("http://signal.localhost/api/needs?q=pdf"));
      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({
        error: { code: "database_unavailable", message: expect.any(String), retryable: true },
      });
    } finally {
      if (prior !== undefined) process.env.DATABASE_URL = prior;
    }
  });

  it("returns validation_failed (400) before touching the database", async () => {
    const response = await http(new Request("http://signal.localhost/api/needs?limit=500"));
    assert.ok(response);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    );
  });
});

describe("spec 007 operations (get_strategy, set_strategy, list_ready_needs)", () => {
  const spec007 = [
    ["get_strategy", "GET", "/api/operator/strategy"],
    ["set_strategy", "PUT", "/api/operator/strategy"],
    ["list_ready_needs", "GET", "/api/operator/needs/ready"],
  ] as const;
  const http = createSignalHttpHandler(operations);
  withSecret(OPERATOR_SECRET);

  it("route /needs/ready to list_ready_needs, not get_need_detail's /needs/:id", () => {
    const match = matchOperationPath(operations, "GET", "/api/operator/needs/ready");
    assert.ok(match && match !== "method_not_allowed");
    expect(match.operation.name).toBe("list_ready_needs");
    const detail = matchOperationPath(
      operations,
      "GET",
      "/api/operator/needs/6f1c2a8e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    );
    assert.ok(detail && detail !== "method_not_allowed");
    expect(detail.operation.name).toBe("get_need_detail");
  });

  it("return unauthorized over REST without the Operator secret", async () => {
    for (const [, method, route] of spec007) {
      const response = await http(
        new Request(`http://signal.localhost${route}`, {
          ...(method === "PUT"
            ? { body: "{}", headers: { "content-type": "application/json" } }
            : {}),
          method,
        }),
      );
      expect(response?.status, `${method} ${route}`).toBe(401);
    }
  });

  it("are absent from the public MCP and the Assistant, present for the Operator", async () => {
    const publicTools = (await listTools("public")).map((tool) => tool.name);
    const operatorTools = (await listTools("operator")).map((tool) => tool.name);
    for (const [name] of spec007) {
      expect(publicTools).not.toContain(name);
      expect(operatorTools).toContain(name);
      expect(signalAgentTools("assistant")[name]).toBeUndefined();
      expect(signalAgentTools("operator")[name]).toBeDefined();
    }
  });
});
