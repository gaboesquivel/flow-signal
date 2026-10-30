import { jsonError, withExtraHeaders } from "@/lib/api/json-error";
import { discoveryRateLimitHeaders } from "@/lib/api/rate-limit-headers";
import { createSignalHttpHandler } from "@/lib/signal/adapters/http";
import "@/lib/signal/next";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () =>
  withExtraHeaders(
    jsonError({
      code: "api_route_not_found",
      message: "No API route matches this path.",
      resolution: "See /openapi.json and /developers for supported endpoints.",
      status: 404,
    }),
    discoveryRateLimitHeaders(),
  );

/** Signal operations (`lib/signal/operations/registry.ts`) mount here; anything else is a 404. */
const signal = createSignalHttpHandler();

const handler = async (request: Request) => (await signal(request)) ?? notFound();

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
