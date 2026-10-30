import { headers } from "next/headers";

import { createInProcessSignalClient } from "@/lib/signal/server-client";

/** The Signal client for a server component, rate limited as the requesting visitor. */
export const signalServerClient = async () => {
  const headerList = await headers();
  return createInProcessSignalClient({
    forwardedFor: headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip"),
  });
};
