import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  OPERATOR_SESSION_COOKIE,
  getOperatorAccessToken,
  isOperatorAccessConfigured,
  signOperatorSession,
} from "@/lib/auth/operator-access";
import { OperatorDisabled } from "../operator-disabled";
import { ConsoleShell } from "./_components/console-shell";
import { operatorServerClient } from "./_lib/operator-client";

export default async function OperatorConsoleLayout({ children }: { children: ReactNode }) {
  if (!isOperatorAccessConfigured()) return <OperatorDisabled />;

  const cookieStore = await cookies();
  const session = cookieStore.get(OPERATOR_SESSION_COOKIE)?.value;
  const expected = signOperatorSession({ token: getOperatorAccessToken() });

  if (session !== expected) redirect("/operator/access");

  const client = await operatorServerClient();
  const pending = await client.listSuggestions({ limit: 100 });

  return (
    <ConsoleShell
      initialPending={
        pending.ok
          ? { count: pending.data.suggestions.length, more: pending.data.nextCursor !== null }
          : null
      }
    >
      {children}
    </ConsoleShell>
  );
}
