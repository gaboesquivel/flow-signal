import type { ErrorCode } from "./errors";

/**
 * Transport for the generated Signal client (`client.ts`). Safe for the browser: no server
 * imports. It turns an operation's route plus input into the same request any REST caller
 * sends, and the `{ error: { code, message, retryable } }` envelope into a typed result.
 */

export interface SignalRoute {
  access: "public" | "operator";
  method: "GET" | "POST" | "PUT";
  name: string;
  path: string;
}

/** Codes from the server, plus `network_error` when no response arrived. */
export type SignalClientErrorCode = ErrorCode | "network_error" | "unexpected_response";

export interface SignalClientError {
  code: SignalClientErrorCode;
  message: string;
  retryable: boolean;
  /** HTTP status when a response arrived. */
  status?: number;
}

export type SignalResult<T> = { data: T; ok: true } | { error: SignalClientError; ok: false };

export interface SignalClientOptions {
  /** Origin to call; empty (default) means relative URLs on the current origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Extra headers on every call, e.g. `Authorization` for Operator operations. */
  headers?: Record<string, string>;
}

export interface SignalCallOptions {
  signal?: AbortSignal;
}

const errorCodes = new Set<string>([
  "validation_failed",
  "not_found",
  "conflict",
  "rate_limited",
  "ai_unavailable",
  "database_unavailable",
  "unauthorized",
]);

const appendQuery = (query: URLSearchParams, key: string, value: unknown) => {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) for (const item of value) appendQuery(query, key, item);
  else query.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
};

/** The URL and init for one call: `:params` from the input, then query (GET) or JSON body. */
export const buildSignalRequest = (
  route: SignalRoute,
  input: Record<string, unknown> | undefined,
  options: SignalClientOptions = {},
): { init: RequestInit; url: string } => {
  const rest = new Map(Object.entries(input ?? {}));
  const path = route.path.replaceAll(/:(?<name>\w+)/gu, (_, name: string) => {
    const value = rest.get(name);
    rest.delete(name);
    if (value === undefined || value === null || value === "")
      throw new TypeError(`${route.name}: missing path parameter "${name}".`);
    return encodeURIComponent(String(value));
  });
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  const base = (options.baseUrl ?? "").replace(/\/$/u, "");

  if (route.method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of rest) appendQuery(query, key, value);
    const search = query.toString();
    return { init: { headers, method: "GET" }, url: `${base}${path}${search ? `?${search}` : ""}` };
  }
  return {
    init: {
      body: JSON.stringify(Object.fromEntries(rest)),
      headers: { ...headers, "content-type": "application/json" },
      method: route.method,
    },
    url: `${base}${path}`,
  };
};

const readJson = (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined as unknown);

const toClientError = (status: number, body: unknown): SignalClientError => {
  const error = (body as { error?: { code?: unknown; message?: unknown; retryable?: unknown } })
    ?.error;
  if (error && typeof error.code === "string" && errorCodes.has(error.code))
    return {
      code: error.code as ErrorCode,
      message: typeof error.message === "string" ? error.message : "Request failed.",
      retryable: error.retryable === true,
      status,
    };
  return {
    code: status === 404 ? "not_found" : "unexpected_response",
    message: `Unexpected response (HTTP ${status}).`,
    retryable: status >= 500,
    status,
  };
};

/** Calls one operation. Never throws for HTTP or network failures; aborts still reject. */
export const callSignalOperation = async <O>(
  route: SignalRoute,
  input: Record<string, unknown> | undefined,
  options: SignalClientOptions = {},
  call: SignalCallOptions = {},
): Promise<SignalResult<O>> => {
  const { init, url } = buildSignalRequest(route, input, options);
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: call.signal });
  } catch (error) {
    if (call.signal?.aborted) throw error;
    return {
      error: {
        code: "network_error",
        message: "Could not reach Signal. Check your connection and try again.",
        retryable: true,
      },
      ok: false,
    };
  }
  const body = await readJson(response);
  if (response.ok && body !== undefined) return { data: body as O, ok: true };
  return { error: toClientError(response.status, body), ok: false };
};
