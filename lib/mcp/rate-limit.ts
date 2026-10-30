import { jsonError } from "@/lib/api/json-error";
import { buildRateLimitHeaders, mcpRateLimitPolicy } from "@/lib/api/rate-limit-headers";
import { clientIp } from "@/lib/signal/adapters/rate-limit";

const windowMs = mcpRateLimitPolicy.windowSeconds * 1000;
const maxPerWindow = mcpRateLimitPolicy.limit;

const buckets = new Map<string, { count: number; resetAt: number }>();

let lastSweep = Number.NEGATIVE_INFINITY;

/** Drops expired buckets at most once per window so the map cannot grow without bound. */
const sweep = (now: number) => {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
};

export const consumeMcpRateLimit = (request: Request) => {
  const key = clientIp(request);
  const now = Date.now();
  sweep(now);
  const current = buckets.get(key);
  if (!current || now >= current.resetAt) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return {
      headers: buildRateLimitHeaders({
        remaining: maxPerWindow - 1,
        resetAt,
      }),
      limited: null,
    };
  }
  current.count += 1;
  const remaining = maxPerWindow - current.count;
  const headers = buildRateLimitHeaders({
    remaining,
    resetAt: current.resetAt,
  });
  if (current.count > maxPerWindow) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return {
      headers,
      limited: jsonError({
        code: "rate_limited",
        message: "Too many MCP requests from this client.",
        resolution: "Wait one minute and retry.",
        retryAfterSeconds: retryAfter,
        status: 429,
      }),
    };
  }
  return { headers, limited: null };
};
