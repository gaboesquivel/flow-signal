"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";

import type { SignalClientError } from "@/lib/signal/client";

import type { PublicTextFinding } from "../_lib/console";
import { ConsoleError } from "./console-bits";
import { OperatorCallError, browserSignal, unwrap } from "./operator-browser";

/**
 * check_public_text for text that will be public (an approved summary, a decision note):
 * names, accounts, and emails found in it warn and block the button until edited.
 */

export const checkKey = (text: string, needId: string | null) =>
  ["operator", "check-public-text", needId, text] as const;

/** The findings, or the call's error (returned, not thrown, for imperative callers). */
export const checkText = async (text: string, needId: string | null) => {
  try {
    const { findings } = await unwrap(
      browserSignal.checkPublicText({ needId: needId ?? undefined, text }),
    );
    return findings;
  } catch (error) {
    if (error instanceof OperatorCallError) return error;
    throw error;
  }
};

export function useTextCheck(text: string, needId: string | null, enabled: boolean) {
  return useQuery({
    enabled: enabled && text.trim().length > 0,
    queryFn: async () => {
      const findings = await checkText(text, needId);
      if (findings instanceof OperatorCallError) throw findings;
      return findings;
    },
    queryKey: checkKey(text, needId),
    staleTime: 60_000,
  });
}

const findingLabels: Record<PublicTextFinding["kind"], string> = {
  account: "Account",
  email: "Email",
  person: "Person",
};

/** The check line under public text: what identifying text was found, if any. */
export function CheckLine({
  action = "approving",
  error,
  findings,
  loading,
}: {
  /** What the finding blocks, e.g. "approving" or "publishing". */
  action?: string;
  error: Pick<SignalClientError, "code" | "message"> | null;
  findings: PublicTextFinding[] | undefined;
  loading: boolean;
}) {
  if (loading)
    return (
      <p className="text-muted-foreground text-xs" data-testid="check-line" data-check="checking">
        Checking for names, accounts, and emails…
      </p>
    );
  if (error) return <ConsoleError error={error} />;
  if (!findings) return null;
  if (findings.length === 0)
    return (
      <p
        className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
        data-check="clear"
        data-testid="check-line"
      >
        <Check aria-hidden="true" className="size-3.5" /> No names, accounts, or emails found.
      </p>
    );
  return (
    <div
      className="text-destructive text-sm"
      data-check="findings"
      data-testid="check-line"
      role="alert"
    >
      <p className="font-medium">Remove identifying text before {action}:</p>
      <ul className="mt-1 list-disc pl-5">
        {findings.map((finding) => (
          <li key={`${finding.kind}-${finding.match}`}>
            {findingLabels[finding.kind]}: <span className="font-mono">{finding.match}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
