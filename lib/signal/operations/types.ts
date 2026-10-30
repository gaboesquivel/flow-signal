import type { z } from "zod";

import type { OperationContext } from "../context";
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
   * Codes `run` may throw as `SignalError`. `validation_failed`, `database_unavailable`, and
   * `rate_limited` (plus `unauthorized` for operator operations) are implicit on every surface.
   */
  errors: readonly ErrorCode[];
  /** REST mapping; `:param` segments are merged into the input. GET reads the query string. */
  http: { method: HttpMethod; path: string };
  /** zod object: REST query/body, MCP `inputSchema`, and agent tool schema. Use `z.coerce` for GET numbers. */
  input: I;
  /** Per-operation HTTP limits; public operations default to 120 requests/min per IP and 16 KB bodies. */
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

export const plannedOperation = (
  operation: Omit<PlannedOperation, "planned">,
): PlannedOperation => ({
  ...operation,
  planned: true,
});

export const isPlanned = (
  operation: AnyOperation | PlannedOperation,
): operation is PlannedOperation => "planned" in operation && operation.planned === true;

export const implicitErrors = (access: Access): ErrorCode[] =>
  access === "operator"
    ? ["validation_failed", "database_unavailable", "rate_limited", "unauthorized"]
    : ["validation_failed", "database_unavailable", "rate_limited"];
