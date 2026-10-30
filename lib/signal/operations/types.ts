import type { z } from "zod";

import type { OperationContext } from "../context";
import type { ActionPreview } from "../domain/assistant-action-contract";
import type { ErrorCode } from "../errors";

export type Access = "public" | "operator";
export type HttpMethod = "GET" | "POST" | "PUT";

/**
 * One capability, defined once and exposed by the HTTP, MCP, and Eve adapters
 * (spec 001 → Agent- and API-first). See `lib/signal/README.md`.
 */
export interface Operation<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  access: Access;
  /** Shared by the MCP tool, the agent tool, and OpenAPI; written for an agent reading it. */
  description: string;
  /**
   * Codes `run` may throw as `SignalError`. `validation_failed`, `database_unavailable`,
   * `rate_limited`, and `internal` (plus `unauthorized` for operator operations) are implicit on
   * every surface.
   */
  errors: readonly ErrorCode[];
  /**
   * `"write"` marks an operation that changes PM-owned state (merges, splits, resolutions,
   * criteria, decisions). The Operator agent asks the user to approve each such call.
   */
  effects?: "read" | "write";
  /**
   * Reads only: what `run(input)` would change right now, for the Operator assistant's action card
   * (spec 014, decision 0011). Throws the same codes as `run` for a bad input. Only operations
   * with a preview can be proposed by the assistant.
   */
  preview?: (input: z.output<I>, ctx: OperationContext) => Promise<ActionPreview>;
  /** REST mapping; `:param` segments are merged into the input. GET reads the query string. */
  http: { method: HttpMethod; path: string };
  /** zod object: REST query/body, MCP `inputSchema`, and agent tool schema. Use `z.coerce` for GET numbers. */
  input: I;
  /**
   * Per-operation limits; public operations default to 120 requests/min per IP (REST and MCP
   * share the budget) and 16 KB REST bodies.
   */
  limits?: { maxBodyBytes?: number; requestsPerMinute?: number };
  /** snake_case; the MCP and agent tool name. */
  name: string;
  /** zod; parsed before returning on every surface. Keep it JSON (ISO strings, no Dates). */
  output: O;
  run: (input: z.output<I>, ctx: OperationContext) => Promise<z.input<O>>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- the registry holds operations of every shape
export type AnyOperation = Operation<any, any>;

export const defineOperation = <I extends z.ZodObject, O extends z.ZodType>(
  operation: Operation<I, O>,
) => operation;

/**
 * An operation from the spec 001 table that a later task has not built yet. It holds its
 * place in the registry (so tasks never edit `registry.ts`) but is exposed on no surface.
 * Replace the whole file with `defineOperation(...)` when building it.
 */
export interface PlannedOperation {
  access: Access;
  http: { method: HttpMethod; path: string };
  name: string;
  planned: true;
}

export const isPlanned = (
  operation: AnyOperation | PlannedOperation,
): operation is PlannedOperation => "planned" in operation && operation.planned === true;

export const implicitErrors = (access: Access): ErrorCode[] =>
  access === "operator"
    ? ["validation_failed", "database_unavailable", "rate_limited", "internal", "unauthorized"]
    : ["validation_failed", "database_unavailable", "rate_limited", "internal"];
