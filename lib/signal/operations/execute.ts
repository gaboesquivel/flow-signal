import { z } from "zod";

import type { Actor } from "../context";
import {
  describeUnexpectedError,
  INTERNAL_ERROR_MESSAGE,
  isDatabaseUnavailable,
  SignalError,
  toErrorEnvelope,
} from "../errors";
import type { ErrorEnvelope } from "../errors";
import { createOperationContext } from "../runtime";
import { implicitErrors } from "./types";
import type { AnyOperation } from "./types";

type OperationResult = { data: unknown; ok: true } | (ErrorEnvelope & { ok: false });

const failure = (error: SignalError): OperationResult => ({
  ok: false,
  ...toErrorEnvelope(error.code, error.message),
});

/**
 * The single execution path behind every surface: validate input, build the context, run,
 * map errors to the envelope (anything unexpected becomes `internal`), and parse the output. Adapters only translate transport.
 * Data is returned as plain JSON so every surface returns byte-identical values.
 */
export const executeOperation = async (
  operation: AnyOperation,
  rawInput: unknown,
  actor: Actor,
): Promise<OperationResult> => {
  const parsed = operation.input.safeParse(rawInput ?? {});
  if (!parsed.success)
    return failure(new SignalError("validation_failed", z.prettifyError(parsed.error)));

  const allowed = new Set([...operation.errors, ...implicitErrors(operation.access)]);
  try {
    const context = createOperationContext(actor);
    const output = operation.output.parse(await operation.run(parsed.data, context));
    // JSON round trip, not structuredClone: Dates and undefined must serialize exactly as REST does.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    return { data: JSON.parse(JSON.stringify(output)) as unknown, ok: true };
  } catch (error) {
    if (error instanceof SignalError) {
      if (!allowed.has(error.code))
        throw new Error(`${operation.name} threw undeclared error code ${error.code}`, {
          cause: error,
        });
      return failure(error);
    }
    if (isDatabaseUnavailable(error))
      return failure(
        new SignalError("database_unavailable", "The Signal database is unavailable."),
      );
    // Driver errors carry SQL and params (emails, names, bodies): log a sanitized line and
    // return a generic envelope instead of letting a surface echo `error.message`.
    console.error(
      `[signal] ${operation.name} failed unexpectedly: ${describeUnexpectedError(error)}`,
    );
    return failure(new SignalError("internal", INTERNAL_ERROR_MESSAGE));
  }
};
