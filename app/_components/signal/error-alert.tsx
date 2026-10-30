import { AlertCircleIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/alert";
import type { SignalClientError } from "@/lib/signal/client";

import { errorCopy } from "./labels";

export function SignalErrorAlert({ error }: { error: Pick<SignalClientError, "code"> }) {
  const copy = errorCopy(error);
  return (
    <Alert variant="destructive">
      <AlertCircleIcon aria-hidden />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.description}</AlertDescription>
    </Alert>
  );
}
