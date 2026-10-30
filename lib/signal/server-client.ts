import { createSignalHttpHandler } from "./adapters/http";
import { createSignalClient } from "./client";
import type { SignalClient } from "./client";
import { toErrorEnvelope } from "./errors";

/**
 * The generated client for server components. Calls go through the same REST adapter as a
 * browser request (validation, rate limits, error envelope), dispatched in process instead of
 * over the network, so pages never touch the domain or the database directly.
 */

const handle = createSignalHttpHandler();

/** Not a real host: requests never leave the process. */
const IN_PROCESS_ORIGIN = "http://signal.internal";

const inProcessFetch: typeof fetch = async (input, init) =>
  (await handle(new Request(input, init))) ??
  Response.json(toErrorEnvelope("not_found", "No Signal operation matches this path."), {
    status: 404,
  });

/**
 * `forwardedFor` is the visitor's address, so server-rendered reads share that visitor's
 * per-IP rate limit instead of one bucket for the whole server. `headers` adds request
 * headers, e.g. an `authorization: Bearer <OPERATOR_SECRET>` header for Operator operations.
 */
export const createInProcessSignalClient = ({
  forwardedFor,
  headers = {},
}: { forwardedFor?: string | null; headers?: Record<string, string> } = {}): SignalClient =>
  createSignalClient({
    baseUrl: IN_PROCESS_ORIGIN,
    fetch: inProcessFetch,
    headers: forwardedFor ? { ...headers, "x-forwarded-for": forwardedFor } : headers,
  });
