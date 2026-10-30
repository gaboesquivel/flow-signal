import assert from "node:assert/strict";

import { asc } from "drizzle-orm";
import type { ToolContext } from "eve/tools";
import { afterAll, beforeAll, expect, it } from "vitest";

import { GET, POST, PUT } from "../../../app/api/[...path]/route";
import { POST as postOperatorMcp } from "../../../app/api/mcp/operator/route";
import { POST as postPublicMcp } from "../../../app/api/mcp/route";
import { events } from "../../../lib/db/schema";
import { signalAgentTools } from "../../../lib/signal/adapters/agent";
import { resetHttpRateLimits } from "../../../lib/signal/adapters/http";
import { mcpRequestFor, restRequestFor } from "../../../lib/signal/adapters/in-process";
import type { McpJsonRpcResponse } from "../../../lib/signal/adapters/in-process";
import type { ErrorCode } from "../../../lib/signal/errors";
import type { AnyOperation } from "../../../lib/signal/operations/types";
import type { SignalDb } from "../../../lib/signal/db";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

/**
 * Parity suite harness (spec 001 → Testing Decisions). A table of cases per operation runs
 * through REST (the real route handler), MCP (public or Operator server, by access), and the
 * Eve agent tool (Assistant or Operator), and every case must give the same output or error
 * code and write the same events on each surface. See lib/signal/README.md → Parity.
 */

export const OPERATOR_SECRET = "parity-operator-secret-0123456789";

export type Surface = "rest" | "mcp" | "agent";
export const surfaces: readonly Surface[] = ["rest", "mcp", "agent"];

/** A surface result with its envelope removed. */
export type Outcome = { error: ErrorCode } | { output: unknown };

export interface ParityCase<F> {
  /** Extra assertions on the (shared) output, e.g. that no PII leaks. */
  check?: (output: unknown, fixture: F) => void;
  /** `{ output }` to compare exactly, `{ error }` for an error code, or omit and use `check`. */
  expect?: (fixture: F) => Outcome;
  /** The operation input; REST splits it into path params, query (GET), or JSON body. */
  input: (fixture: F) => Record<string, unknown>;
  name: string;
}

export interface ParityTable<F> {
  cases: ParityCase<F>[];
  /** Builds the data the cases read; runs on an empty database. */
  fixture: (db: SignalDb) => Promise<F>;
  /**
   * Writes data: the database is reset and the fixture rebuilt before every surface call so
   * each surface starts from the same state. Read-only tables build the fixture once.
   */
  mutates?: boolean;
  operation: AnyOperation;
}

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu;
/** `preview_signal` mints a random `previewId` per call (spec 012). */
const previewIdPattern = /\bpv_[\w-]{22}\b/gu;
/** `submit_signal` tracking links carry a random token. */
const trackingTokenPattern = /\/my\/[\w-]{16,128}/gu;

/**
 * For writing tables each surface starts from a rebuilt fixture, so ids and timestamps differ;
 * replace each distinct UUID with its order of first appearance and timestamps with a marker.
 * Extend this (not the comparison) if a new operation returns other per-run values.
 */
export const normalizeRun = (value: unknown) => {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value)
    .replaceAll(uuidPattern, (id) => {
      if (!ids.has(id)) ids.set(id, `<id:${ids.size}>`);
      return ids.get(id)!;
    })
    .replaceAll(isoPattern, "<time>")
    .replaceAll(trackingTokenPattern, "/my/<token>")
    .replaceAll(previewIdPattern, "pv_<id>");
  return JSON.parse(text) as unknown;
};

export interface SurfaceResult {
  events: Record<string, unknown>[];
  outcome: Outcome;
}

const toOutcome = (value: unknown): Outcome => {
  if (value && typeof value === "object" && "error" in value) {
    const { error } = value as { error: { code: ErrorCode } };
    return { error: error.code };
  }
  return { output: value };
};

const restRequest = (operation: AnyOperation, input: Record<string, unknown>, asAgent: boolean) => {
  const headers: Record<string, string> = {};
  if (operation.access === "operator") headers.authorization = `Bearer ${OPERATOR_SECRET}`;
  if (asAgent) headers["x-signal-agent"] = "parity";
  return restRequestFor(operation, input, headers);
};

const restHandlers = { GET, POST, PUT } as const;

/** Raw REST call as a human (no agent header), for status-code and envelope assertions. */
export const callRest = async (operation: AnyOperation, input: Record<string, unknown>) => {
  const response = await restHandlers[operation.http.method](restRequest(operation, input, false));
  const body: unknown = await response.json();
  if (response.ok) assert.ok(!(body && typeof body === "object" && "error" in body));
  return { body, status: response.status };
};

export const mcpCall = async (
  access: "public" | "operator",
  method: string,
  params: Record<string, unknown>,
) => {
  const handler = access === "public" ? postPublicMcp : postOperatorMcp;
  const headers: Record<string, string> = { "x-mcp-client": "parity" };
  if (access === "operator") headers.authorization = `Bearer ${OPERATOR_SECRET}`;
  const response = await handler(mcpRequestFor(access, method, params, headers));
  assert.equal(response.status, 200);
  return (await response.json()) as McpJsonRpcResponse;
};

export const callMcp = async (operation: AnyOperation, input: Record<string, unknown>) => {
  const json = await mcpCall(operation.access, "tools/call", {
    arguments: input,
    name: operation.name,
  });
  assert.ok(json.result, `MCP error: ${json.error?.message}`);
  const result = json.result as { isError?: boolean; structuredContent?: unknown };
  return result.structuredContent;
};

export const callAgent = (operation: AnyOperation, input: Record<string, unknown>) => {
  const tools = signalAgentTools(operation.access === "public" ? "assistant" : "operator");
  const tool = tools[operation.name];
  assert.ok(tool, `agent tool ${operation.name} is missing`);
  return Promise.resolve(
    tool.execute(input, { session: { id: "parity" } } as unknown as ToolContext),
  );
};

const readEvents = (db: SignalDb) =>
  db
    .select()
    .from(events)
    .orderBy(asc(events.occurredAt), asc(events.type))
    .then((rows) =>
      rows.map(({ actorKind, needId, payload, signalId, suggestionId, type }) => ({
        actorKind,
        needId,
        // The agent client names its surface (`parity`, `eve:assistant`); actor kind is compared.
        payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "client")),
        signalId,
        suggestionId,
        type,
      })),
    );

export const callSurface = async (
  surface: Surface,
  operation: AnyOperation,
  input: Record<string, unknown>,
) => {
  if (surface === "rest") {
    const response = await restHandlers[operation.http.method](restRequest(operation, input, true));
    return toOutcome(await response.json());
  }
  if (surface === "mcp") return toOutcome(await callMcp(operation, input));
  return toOutcome(await callAgent(operation, input));
};

const runCase = async <F>(
  table: ParityTable<F>,
  parityCase: ParityCase<F>,
  db: SignalDb,
  sharedFixture: () => F,
) => {
  const results = new Map<Surface, SurfaceResult & { fixture: F }>();
  for (const surface of surfaces) {
    resetHttpRateLimits();
    let fixture = sharedFixture();
    if (table.mutates) {
      await resetDatabase(db);
      fixture = await table.fixture(db);
    }
    const before = table.mutates ? 0 : (await readEvents(db)).length;
    const outcome = await callSurface(surface, table.operation, parityCase.input(fixture));
    const written = (await readEvents(db)).slice(before);
    results.set(surface, { events: written, fixture, outcome });
  }

  const rest = results.get("rest")!;
  const comparable = (result: SurfaceResult) =>
    table.mutates
      ? normalizeRun({ events: result.events, outcome: result.outcome })
      : { events: result.events, outcome: result.outcome };
  for (const [surface, result] of results)
    expect(comparable(result), `${surface} matches rest`).toEqual(comparable(rest));
  if (parityCase.expect) expect(rest.outcome).toEqual(parityCase.expect(rest.fixture));
  if (parityCase.check) {
    assert.ok("output" in rest.outcome, `expected output, got ${JSON.stringify(rest.outcome)}`);
    parityCase.check(rest.outcome.output, rest.fixture);
  }
};

/**
 * Registers one `it` per case. Every surface runs as actor kind `agent` (REST sends
 * `X-Signal-Agent`), so events must match exactly, actor kind included.
 */
export const runParityTable = <F>(table: ParityTable<F>) => {
  const { operation } = table;
  describeWithDatabase(`parity: ${operation.name}`, () => {
    const harness = useTestDatabase();
    const state: { shared?: F } = {};
    let priorSecret: string | undefined;

    beforeAll(async () => {
      priorSecret = process.env.OPERATOR_SECRET;
      process.env.OPERATOR_SECRET = OPERATOR_SECRET;
      if (!table.mutates) state.shared = await table.fixture(harness.db);
    });
    afterAll(() => {
      if (priorSecret === undefined) delete process.env.OPERATOR_SECRET;
      else process.env.OPERATOR_SECRET = priorSecret;
    });

    for (const parityCase of table.cases)
      it(parityCase.name, () => runCase(table, parityCase, harness.db, () => state.shared as F));
  });
};
