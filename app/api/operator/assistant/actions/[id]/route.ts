import { operatorAccessDeniedResponse, verifyOperatorRequest } from "@/lib/auth/operator-access";
import { isOperatorAssistantEnabled } from "@/lib/flags/operator-assistant";
import { confirmAction, getAction, rejectAction } from "@/lib/signal/domain/assistant-actions";
import { assistantConfirmActor } from "@/lib/signal/domain/assistant-action-contract";
import {
  describeUnexpectedError,
  errorStatus,
  INTERNAL_ERROR_MESSAGE,
  isDatabaseUnavailable,
  SignalError,
  toErrorEnvelope,
} from "@/lib/signal/errors";
import type { ErrorCode } from "@/lib/signal/errors";
import { createOperationContext } from "@/lib/signal/runtime";

/**
 * A pending assistant action (spec 014 → Assistant routes, decision 0011). The only path that
 * runs a write the assistant proposed; it never calls the model.
 *
 * - `GET` → `{ action: { id, operation, status, input, preview, result, edited, … } }`.
 * - `POST { decision: "confirm", input? }` → `{ status: "confirmed", result }` or
 *   `{ status: "needs_review", preview }`; `POST { decision: "reject" }` → `{ status: "rejected" }`.
 *
 * Operator access only; `not_found` while `OPERATOR_ASSISTANT` is off. Errors use the Signal
 * envelope (`not_found`, `action_closed`, `validation_failed`, and the operation's own codes).
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_BODY_BYTES = 16 * 1024;

const errorResponse = (code: ErrorCode, message: string, status?: number) =>
  Response.json(toErrorEnvelope(code, message), { status: status ?? errorStatus[code] });

const fromError = (error: unknown) => {
  if (error instanceof SignalError) return errorResponse(error.code, error.message);
  if (isDatabaseUnavailable(error))
    return errorResponse("database_unavailable", "The Signal database is unavailable.");
  console.error(`[assistant-actions] failed unexpectedly: ${describeUnexpectedError(error)}`);
  return errorResponse("internal", INTERNAL_ERROR_MESSAGE);
};

/** Operator access, then the flag: `null` when the request may proceed. */
const guard = (request: Request) => {
  const access = verifyOperatorRequest(request);
  if (!access.ok) return operatorAccessDeniedResponse({ reason: access.reason });
  if (!isOperatorAssistantEnabled()) return errorResponse("not_found", "Not found.");
  return null;
};

type Decision = { decision: "confirm"; input?: Record<string, unknown> } | { decision: "reject" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readDecision = async (request: Request): Promise<Decision | Response> => {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    return errorResponse("validation_failed", `Body exceeds ${MAX_BODY_BYTES} bytes.`, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse("validation_failed", "Body is not valid JSON.");
  }
  if (isRecord(body) && body.decision === "reject") return { decision: "reject" };
  if (
    isRecord(body) &&
    body.decision === "confirm" &&
    (body.input === undefined || isRecord(body.input))
  )
    return body.input === undefined
      ? { decision: "confirm" }
      : { decision: "confirm", input: body.input };
  return errorResponse(
    "validation_failed",
    'Send { "decision": "confirm", "input"?: { … } } or { "decision": "reject" }.',
  );
};

export const GET = async (request: Request, { params }: RouteContext) => {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const { db } = createOperationContext(assistantConfirmActor);
    return Response.json({ action: await getAction(db, id) });
  } catch (error) {
    return fromError(error);
  }
};

export const POST = async (request: Request, { params }: RouteContext) => {
  const denied = guard(request);
  if (denied) return denied;
  const decision = await readDecision(request);
  if (decision instanceof Response) return decision;
  try {
    const { id } = await params;
    const context = createOperationContext(assistantConfirmActor);
    if (decision.decision === "reject")
      return Response.json(await rejectAction(context.db, { actionId: id }, context));
    return Response.json(
      await confirmAction(context.db, { actionId: id, input: decision.input }, context),
    );
  } catch (error) {
    return fromError(error);
  }
};
