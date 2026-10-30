import type { AnyOperation } from "../operations/types";

/**
 * Per-operation, per-client-IP fixed-window limits shared by the REST and public MCP adapters
 * (one budget per client and operation across both). In-memory, so each server instance counts
 * on its own; a shared store (e.g. KV) is out of scope for the MVP.
 */

const DEFAULT_REQUESTS_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

const buckets = new Map<string, { count: number; resetAt: number }>();
let lastSweep = Number.NEGATIVE_INFINITY;

/** Drops expired buckets at most once per window so the map cannot grow without bound. */
const sweep = (now: number) => {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
};

/** The client's IP, read the same way as the MCP route's global limiter. */
export const clientIp = (request?: Request) =>
  request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  request?.headers.get("x-real-ip") ??
  "local";

/** Counts one request; returns seconds until the window resets when over `limit`. */
export const consumeRateLimit = (key: string, limit: number, now = Date.now()) => {
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  bucket.count += 1;
  if (bucket.count <= limit) return;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
};

/**
 * Applies `operation.limits.requestsPerMinute` (default 120) to a public operation for this
 * client. Returns seconds to wait when limited; Operator operations are not limited here.
 */
export const consumeOperationRateLimit = (operation: AnyOperation, request?: Request) => {
  if (operation.access !== "public") return;
  const limit = operation.limits?.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
  return consumeRateLimit(`${operation.name}:${clientIp(request)}`, limit);
};

export const RATE_LIMITED_MESSAGE = "Too many requests from this client.";

export const resetRateLimits = () => {
  buckets.clear();
  lastSweep = Number.NEGATIVE_INFINITY;
};

/** For tests: how many client buckets are held. */
export const rateLimitBucketCount = () => buckets.size;
