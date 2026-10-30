import { verifyOperatorRequest } from "@/lib/auth/operator-access";

import type { Actor } from "../context";
import { errorStatus, toErrorEnvelope } from "../errors";
import type { ErrorCode } from "../errors";
import { executeOperation } from "../operations/execute";
import { operations } from "../operations/registry";
import type { AnyOperation } from "../operations/types";

/**
 * REST adapter: matches `operation.http`, enforces Operator access, rate and body limits,
 * builds the input from path params plus query (GET) or JSON body, and maps results to the
 * error envelope. No business logic. Mounted by `app/api/[...path]/route.ts`.
 */

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_REQUESTS_PER_MINUTE = 120;

const compilePath = (path: string) => {
  const names: string[] = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      names.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { names, regex: new RegExp(`^${pattern}/?$`, "u") };
};

export const matchOperationPath = (
  ops: readonly AnyOperation[],
  method: string,
  pathname: string,
) => {
  const path = pathname.replace(/^\/v1(?=\/api\/)/u, "");
  let pathMatched = false;
  for (const operation of ops) {
    const { names, regex } = compilePath(operation.http.path);
    const match = regex.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (operation.http.method !== method) continue;
    const params = Object.fromEntries(
      names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]),
    );
    return { operation, params };
  }
  return pathMatched ? ("method_not_allowed" as const) : undefined;
};

const buckets = new Map<string, { count: number; resetAt: number }>();

const clientIp = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  request.headers.get("x-real-ip") ??
  "local";

const consumeRateLimit = (key: string, limit: number) => {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count <= limit) return;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
};

export const resetHttpRateLimits = () => buckets.clear();

const errorResponse = (
  code: ErrorCode,
  message: string,
  { headers, status }: { headers?: Record<string, string>; status?: number } = {},
) =>
  Response.json(toErrorEnvelope(code, message), {
    headers,
    status: status ?? errorStatus[code],
  });

/**
 * REST callers are humans by default; an agent calling REST identifies itself with
 * `X-Signal-Agent: <client name>` so its writes count under agent in the metrics.
 */
const actorFor = (request: Request): Actor => {
  const agent = request.headers.get("x-signal-agent")?.trim();
  if (agent)
    return { client: agent.slice(0, 100), kind: "agent", ref: `rest:${agent.slice(0, 100)}` };
  return { kind: "human", ref: "web" };
};

const readInput = async (request: Request, operation: AnyOperation, url: URL) => {
  if (operation.http.method === "GET") {
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key);
      query[key] = values.length > 1 ? values : (values[0] ?? "");
    }
    return { input: query };
  }
  const maxBytes = operation.limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    return {
      error: errorResponse("validation_failed", `Body exceeds ${maxBytes} bytes.`, { status: 413 }),
    };
  if (!text.trim()) return { input: {} };
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return { error: errorResponse("validation_failed", "Body must be a JSON object.") };
    return { input: body as Record<string, unknown> };
  } catch {
    return { error: errorResponse("validation_failed", "Body is not valid JSON.") };
  }
};

/** Returns a Response for a Signal operation route, or `undefined` when no operation matches. */
export const createSignalHttpHandler =
  (ops: readonly AnyOperation[] = operations) =>
  async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const match = matchOperationPath(ops, request.method, url.pathname);
    if (!match) return undefined;
    if (match === "method_not_allowed")
      return errorResponse(
        "validation_failed",
        `${request.method} is not supported on this path.`,
        {
          status: 405,
        },
      );
    const { operation, params } = match;

    if (operation.access === "operator") {
      const access = verifyOperatorRequest(request);
      if (!access.ok)
        return errorResponse(
          "unauthorized",
          access.reason === "disabled"
            ? "Operator access is not configured (OPERATOR_SECRET is unset)."
            : "Send Authorization: Bearer <OPERATOR_SECRET>.",
        );
    } else {
      const limit = operation.limits?.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
      const retryAfter = consumeRateLimit(`${operation.name}:${clientIp(request)}`, limit);
      if (retryAfter !== undefined)
        return errorResponse("rate_limited", "Too many requests from this client.", {
          headers: { "Retry-After": String(retryAfter) },
        });
    }

    const read = await readInput(request, operation, url);
    if (read.error) return read.error;

    const result = await executeOperation(
      operation,
      { ...read.input, ...params },
      actorFor(request),
    );
    if (result.ok) return Response.json(result.data);
    return errorResponse(result.error.code, result.error.message, {
      headers: result.error.code === "rate_limited" ? { "Retry-After": "60" } : undefined,
    });
  };
