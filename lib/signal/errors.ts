import { z } from "zod";

export const errorCodes = [
  "validation_failed",
  "not_found",
  "conflict",
  "rate_limited",
  "ai_unavailable",
  "database_unavailable",
  "unauthorized",
  "internal",
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorStatus: Record<ErrorCode, number> = {
  ai_unavailable: 503,
  conflict: 409,
  database_unavailable: 503,
  internal: 500,
  not_found: 404,
  rate_limited: 429,
  unauthorized: 401,
  validation_failed: 400,
};

const retryableCodes = new Set<ErrorCode>([
  "rate_limited",
  "ai_unavailable",
  "database_unavailable",
  "internal",
]);

/** The one error shape on every surface: REST body, MCP `structuredContent`, agent tool result. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Throw from an operation's `run` to return a coded error; the code must be in `errors`. */
export class SignalError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SignalError";
    this.code = code;
  }
}

export const toErrorEnvelope = (code: ErrorCode, message: string): ErrorEnvelope => ({
  error: { code, message, retryable: retryableCodes.has(code) },
});

/** The `internal` envelope's only message: unexpected failures never reach a client verbatim. */
export const INTERNAL_ERROR_MESSAGE = "Something went wrong.";

const sqlStateOf = (error: unknown, depth = 0): string | undefined => {
  if (!(error instanceof Error) || depth > 5) return undefined;
  const { code } = error as { code?: unknown };
  if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
  return sqlStateOf(error.cause, depth + 1);
};

/**
 * One log line for an unexpected failure: the operation, the error class, and the SQLSTATE
 * (or driver code), never the message, SQL, or params, which can hold submitter PII.
 */
export const describeUnexpectedError = (error: unknown): string => {
  let kind: string = typeof error;
  if (error instanceof Error) kind = error.constructor.name || error.name;
  else if (error === null) kind = "null";
  const code = sqlStateOf(error);
  return code ? `${kind} (SQLSTATE ${code})` : kind;
};

export const isErrorEnvelope = (value: unknown): value is ErrorEnvelope =>
  errorEnvelopeSchema.safeParse(value).success;

const unavailableCode = /^(?:ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|08|53|57)/u;
const unavailableMessage =
  /fetch failed|websocket|connection (?:refused|terminated|timeout)|timed out/iu;

/**
 * True when the database could not be reached or refused the connection (network errors,
 * SQLSTATE 08 / 53 / 57, including 57014 statement timeout). Constraint violations and query bugs are not "unavailable".
 */
export const isDatabaseUnavailable = (error: unknown): boolean => {
  // The Neon driver's WebSocket reports a failed connection as an `error` Event, not an Error.
  if (typeof Event !== "undefined" && error instanceof Event) return error.type === "error";
  if (!(error instanceof Error)) return false;
  const { code } = error as { code?: unknown };
  if (typeof code === "string" && unavailableCode.test(code)) return true;
  if (unavailableMessage.test(error.message)) return true;
  return error.cause !== undefined && isDatabaseUnavailable(error.cause);
};
