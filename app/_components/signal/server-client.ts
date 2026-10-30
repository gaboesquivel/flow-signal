import { headers } from "next/headers";

import { createInProcessSignalClient } from "@/lib/signal/server-client";
import "@/lib/signal/next";

/** The Signal client for a server component, rate limited as the requesting visitor. */
export const signalServerClient = async () => {
  const headerList = await headers();
  return createInProcessSignalClient({
    forwardedFor: headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip"),
  });
};

/**
 * The Signal client for an Operator console page: forwards the visitor's operator session
 * cookie, so Operator operations authorize exactly as the browser's own requests would.
 */
export const signalOperatorServerClient = async () => {
  const headerList = await headers();
  const cookie = headerList.get("cookie");
  return createInProcessSignalClient({
    forwardedFor: headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip"),
    headers: cookie ? { cookie } : {},
  });
};
