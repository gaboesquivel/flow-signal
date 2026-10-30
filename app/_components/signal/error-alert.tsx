import { AlertCircleIcon } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/alert";
import type { SignalClientError } from "@/lib/signal/client";

import { errorCopy } from "./labels";

/** A failed call explained in plain words, with a retry link when the page can be reloaded. */
export function SignalErrorAlert({
  error,
  retryHref,
}: {
  error: Pick<SignalClientError, "code">;
  retryHref?: string;
}) {
  const copy = errorCopy(error);
  return (
    <Alert variant="destructive">
      <AlertCircleIcon aria-hidden />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.description}</p>
        {retryHref ? (
          <p>
            <Link className="underline underline-offset-4" href={retryHref}>
              Try again
            </Link>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
