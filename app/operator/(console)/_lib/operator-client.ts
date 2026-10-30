import { cookies } from "next/headers";

import { OPERATOR_SESSION_COOKIE } from "@/lib/auth/operator-access";
import type { SignalClient } from "@/lib/signal/client";
import { createInProcessSignalClient } from "@/lib/signal/server-client";

/**
 * The generated Signal client for Operator server components. Calls go in process through the
 * REST adapter carrying the PM's own session cookie, so the adapter checks Operator access
 * (as for a browser request) and records the PM as a human actor. The server never attaches
 * the secret on the PM's behalf.
 */
export const operatorServerClient = async (): Promise<SignalClient> => {
  const cookieStore = await cookies();
  const session = cookieStore.get(OPERATOR_SESSION_COOKIE)?.value ?? "";
  return createInProcessSignalClient({
    headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${encodeURIComponent(session)}` },
  });
};
