import { createHash, randomUUID } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";

import { assistantActions } from "@/lib/db/schema";

import type { SignalAi } from "../ai/ports";
import type { Clock } from "../context";
import type { SignalDb, SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { executeOperation } from "../operations/execute";
import { operations } from "../operations/registry";
import { isPlanned } from "../operations/types";
import type { AnyOperation } from "../operations/types";
import {
  ACTION_TTL_MS,
  actionPreviewSchema,
  assistantAgentActor,
  assistantConfirmActor,
} from "./assistant-action-contract";
import type { ActionPreview, ActionStatus } from "./assistant-action-contract";

/**
 * Propose, confirm, and reject Operator assistant actions (spec 014, decision 0011). The contract
 * (preview schema, actors, write event types) lives in `assistant-action-contract.ts` and is
 * imported from there directly.
 */

/**
 * Stable hash of what the PM saw (`title`, `lines`, `needs`, `blocks`); confirm refuses to run
 * when the recomputed preview's fingerprint differs. Here, not in the contract, so the contract
 * stays browser-safe.
 */
export const fingerprint = (preview: ActionPreview): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        preview.title,
        preview.lines.map(({ label, value }) => [label, value]),
        preview.needs.map(({ id, role, statement }) => [id, role, statement]),
        preview.blocks.map(({ code, flags, message }) => [
          code,
          message,
          (flags ?? []).map((flag) => JSON.stringify(flag)),
        ]),
      ]),
    )
    .digest("base64url");

/* ---------------------------------------------------------------------------------------------
 * Propose, confirm, reject (spec 014 task 03).
 * ------------------------------------------------------------------------------------------- */

/** What the action functions need besides the database. */
export interface ActionContext {
  ai: SignalAi;
  clock: Clock;
  /** The operations that may be proposed; the registry by default (tests pass their own). */
  operations?: readonly AnyOperation[];
}

type ProposableOperation = AnyOperation & Required<Pick<AnyOperation, "preview">>;

export type AssistantActionRow = typeof assistantActions.$inferSelect;

/** What `GET /api/operator/assistant/actions/:id` returns as `action`. */
export interface ActionView {
  edited: boolean;
  errorCode: string | null;
  expiresAt: string;
  id: string;
  input: Record<string, unknown>;
  operation: string;
  preview: ActionPreview;
  result: unknown;
  status: ActionStatus;
}

export type ConfirmOutcome =
  | { result: unknown; status: "confirmed" }
  | { preview: ActionPreview; status: "needs_review" };

/** JSON round trip, not structuredClone: what is stored must equal what a client gets back. */
const toJson = <T>(value: T): T =>
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  JSON.parse(JSON.stringify(value)) as T;

/** Only built `effects: "write"` operations with a `preview` can be proposed. */
const proposable = (ctx: ActionContext, name: string): ProposableOperation => {
  const operation = (ctx.operations ?? operations).find(
    (candidate) => candidate.name === name && !isPlanned(candidate),
  );
  if (!operation || operation.effects !== "write" || !operation.preview)
    throw new SignalError(
      "validation_failed",
      `${name} cannot be proposed: only write operations with a preview can.`,
    );
  return operation as ProposableOperation;
};

const takesKey = (operation: AnyOperation, key: string) =>
  Object.hasOwn(operation.input.shape as Record<string, unknown>, key);

/** Parses input with the operation's schema; the action id is the idempotency key where taken. */
const validate = (operation: AnyOperation, input: Record<string, unknown>, actionId: string) => {
  const raw = takesKey(operation, "idempotencyKey")
    ? { ...input, idempotencyKey: actionId }
    : input;
  const parsed = operation.input.safeParse(raw);
  if (!parsed.success) throw new SignalError("validation_failed", z.prettifyError(parsed.error));
  return toJson(parsed.data as Record<string, unknown>);
};

/** Previews read only; they run as the assistant agent. */
const runPreview = async (
  operation: ProposableOperation,
  input: Record<string, unknown>,
  db: SignalDb,
  ctx: ActionContext,
) =>
  actionPreviewSchema.parse(
    await operation.preview(input, {
      actor: assistantAgentActor,
      ai: ctx.ai,
      clock: ctx.clock,
      db,
    }),
  );

const toView = (row: AssistantActionRow): ActionView => ({
  edited: row.edited,
  errorCode: row.errorCode,
  expiresAt: row.expiresAt.toISOString(),
  id: row.id,
  input: row.input,
  operation: row.operation,
  preview: row.preview as ActionPreview,
  result: row.result ?? null,
  status: row.status,
});

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

const loadAction = async (db: SignalQueryable, actionId: string) => {
  if (!uuidPattern.test(actionId)) return;
  const [row] = await db.select().from(assistantActions).where(eq(assistantActions.id, actionId));
  return row;
};

const notFound = () => new SignalError("not_found", "No such assistant action.");

/**
 * Validates `input` with the operation's schema, runs its `preview` (reads only), and stores a
 * `proposed` action with `assistant.action_proposed` in one transaction. A bad input or a
 * throwing preview stores nothing and throws, so the model can correct itself.
 */
export const proposeAction = async (
  db: SignalDb,
  { input, operation: name }: { input: Record<string, unknown>; operation: string },
  ctx: ActionContext,
) => {
  const operation = proposable(ctx, name);
  const id = randomUUID();
  const parsed = validate(operation, input ?? {}, id);
  const preview = await runPreview(operation, parsed, db, ctx);
  const now = ctx.clock.now();
  await db.transaction(async (tx) => {
    await tx.insert(assistantActions).values({
      createdAt: now,
      expiresAt: new Date(now.getTime() + ACTION_TTL_MS),
      fingerprint: fingerprint(preview),
      id,
      input: parsed,
      operation: operation.name,
      preview,
    });
    await recordEvent(tx, {
      actor: assistantAgentActor,
      occurredAt: now,
      payload: { actionId: id, operation: operation.name },
      type: "assistant.action_proposed",
    });
  });
  return { actionId: id, operation: operation.name, preview };
};

/** The action's current row, so a reloaded card shows its true state. */
export const getAction = async (db: SignalQueryable, actionId: string) => {
  const row = await loadAction(db, actionId);
  if (!row) throw notFound();
  return toView(row);
};

/**
 * An unclaimed pending action: `proposed` with no `resolved_at`. Confirm claims an action by
 * setting `resolved_at` while it is still `proposed`, so this condition is the claim's guard.
 */
const unclaimed = (actionId: string) =>
  and(
    eq(assistantActions.id, actionId),
    eq(assistantActions.status, "proposed"),
    isNull(assistantActions.resolvedAt),
  );

const isExpired = (row: AssistantActionRow, now: Date) => row.expiresAt.getTime() <= now.getTime();

const markExpired = (db: SignalDb, actionId: string, now: Date) =>
  db
    .update(assistantActions)
    .set({ resolvedAt: now, status: "expired" })
    .where(unclaimed(actionId));

/**
 * The answer for an action this request cannot run: the stored result after a success (a retry
 * runs nothing), the stored preview while it awaits review, else `action_closed`.
 */
const settled = async (db: SignalDb, actionId: string, now: Date): Promise<ConfirmOutcome> => {
  const row = await loadAction(db, actionId);
  if (!row) throw notFound();
  if (row.status === "confirmed") return { result: row.result ?? null, status: "confirmed" };
  if (row.status === "proposed" && row.resolvedAt)
    throw new SignalError("action_closed", "This action is already being confirmed.");
  if (row.status === "proposed" && isExpired(row, now)) {
    await markExpired(db, actionId, now);
    throw new SignalError("action_closed", "This action expired. Ask again for a fresh one.");
  }
  if (row.status === "proposed")
    return { preview: row.preview as ActionPreview, status: "needs_review" };
  throw new SignalError(
    "action_closed",
    row.status === "failed"
      ? `This action already failed (${row.errorCode ?? "internal"}). Ask again for a fresh one.`
      : `This action is ${row.status}.`,
  );
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The value at a dotted path (`edit.statement`, `weights.demand`), or undefined. */
const valueAt = (input: Record<string, unknown>, path: string): unknown => {
  let value: unknown = input;
  for (const key of path.split(".")) value = record(value)?.[key];
  return value;
};

/** A copy of `input` with `value` at a dotted path, creating objects along the way. */
const withValueAt = (input: Record<string, unknown>, path: string, value: unknown) => {
  const copy = toJson(input);
  const keys = path.split(".");
  let target = copy;
  for (const key of keys.slice(0, -1)) {
    target[key] = record(target[key]) ?? {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys.at(-1) ?? path] = value;
  return copy;
};

/**
 * Applies the PM's edits, keyed by input key or by an `editable` dotted path (`edit.statement`).
 * Only the preview's `editable` keys may differ from the stored input.
 */
const applyEdits = (
  stored: Record<string, unknown>,
  edits: Record<string, unknown> | undefined,
  preview: ActionPreview,
) => {
  if (!edits) return { changed: false, input: stored };
  const editable = new Set(preview.editable.map(({ key }) => key));
  const changedKeys = Object.keys(edits).filter(
    (key) => JSON.stringify(edits[key]) !== JSON.stringify(valueAt(stored, key)),
  );
  const locked = changedKeys.filter((key) => !editable.has(key));
  if (locked.length > 0)
    throw new SignalError(
      "validation_failed",
      `Only ${editable.size > 0 ? [...editable].join(", ") : "no fields"} can be edited on this action, not ${locked.join(", ")}.`,
    );
  let input = stored;
  for (const key of changedKeys) input = withValueAt(input, key, edits[key]);
  return { changed: changedKeys.length > 0, input };
};

/**
 * Runs a proposed action once, as the PM through the assistant (spec 014 → Pending actions).
 *
 * 1. Unknown id → `not_found`. Not `proposed`, already claimed, or expired → `action_closed`
 *    (an expired action is marked `expired`); a confirmed action returns its stored result.
 * 2. Only `editable` keys of `input` may change (else `validation_failed`); then re-validate.
 * 3. Recompute the preview. If its fingerprint differs from the stored one (staleness, or an
 *    edit that changed it) or it has `blocks`, store it and return `needs_review`, running nothing.
 * 4. Claim with one conditional `UPDATE … SET resolved_at = now WHERE status = 'proposed' AND
 *    resolved_at IS NULL AND fingerprint = <recomputed>`. Postgres re-checks the condition after
 *    taking the row lock, so exactly one of two concurrent confirms matches; the other re-reads
 *    the row and gets the stored result, or `action_closed` while the winner is still running.
 *    No transaction is held while the operation runs (it opens its own).
 * 5. Run `executeOperation` as `assistantConfirmActor` (idempotency key: the action id, where the
 *    operation takes one). Store `confirmed` + result with `assistant.action_confirmed` (deduped
 *    by the action id), or `failed` + the error code (the operation wrote no event) and throw it.
 *
 * A claim whose process dies mid-run stays claimed (`proposed` with `resolved_at`) and answers
 * `action_closed`; it is never run again, since not every operation is idempotent.
 */
export const confirmAction = async (
  db: SignalDb,
  { actionId, input: edits }: { actionId: string; input?: Record<string, unknown> },
  ctx: ActionContext,
): Promise<ConfirmOutcome> => {
  const now = ctx.clock.now();
  const row = await loadAction(db, actionId);
  if (!row) throw notFound();
  if (row.status !== "proposed" || row.resolvedAt || isExpired(row, now))
    return settled(db, actionId, now);

  const operation = proposable(ctx, row.operation);
  const { changed, input: merged } = applyEdits(row.input, edits, row.preview as ActionPreview);
  const input = validate(operation, merged, actionId);
  const edited = row.edited || changed;
  const preview = await runPreview(operation, input, db, ctx);
  const fresh = fingerprint(preview);

  if (fresh !== row.fingerprint || preview.blocks.length > 0) {
    const updated = await db
      .update(assistantActions)
      .set({ edited, fingerprint: fresh, input, preview })
      .where(unclaimed(actionId))
      .returning({ id: assistantActions.id });
    if (updated.length === 0) return settled(db, actionId, now);
    return { preview, status: "needs_review" };
  }

  const claimed = await db
    .update(assistantActions)
    .set({ edited, input, preview, resolvedAt: now })
    .where(and(unclaimed(actionId), eq(assistantActions.fingerprint, fresh)))
    .returning({ id: assistantActions.id });
  if (claimed.length === 0) return settled(db, actionId, now);

  // Confirming is the acknowledgement for `share_report`: the card listed every flag.
  const runInput = takesKey(operation, "acknowledgeFlags")
    ? { ...input, acknowledgeFlags: true }
    : input;
  const fail = (errorCode: string) =>
    db
      .update(assistantActions)
      .set({ errorCode, status: "failed" })
      .where(eq(assistantActions.id, actionId));

  let outcome: Awaited<ReturnType<typeof executeOperation>>;
  try {
    outcome = await executeOperation(operation, runInput, assistantConfirmActor);
  } catch (error) {
    await fail("internal");
    throw error;
  }
  if (!outcome.ok) {
    await fail(outcome.error.code);
    throw new SignalError(outcome.error.code, outcome.error.message);
  }

  const { data } = outcome;
  await db.transaction(async (tx) => {
    await tx
      .update(assistantActions)
      .set({ result: data, status: "confirmed" })
      .where(eq(assistantActions.id, actionId));
    await recordEvent(tx, {
      actor: assistantConfirmActor,
      dedupeKey: `assistant.action_confirmed:${actionId}`,
      occurredAt: now,
      payload: { actionId, edited, operation: operation.name },
      type: "assistant.action_confirmed",
    });
  });
  return { result: data, status: "confirmed" };
};

/**
 * Dismisses a pending action: `rejected`, with `assistant.action_rejected` (the PM as actor).
 * Rejecting again answers `rejected`; any other closed, claimed, or expired action is
 * `action_closed`.
 */
export const rejectAction = async (
  db: SignalDb,
  { actionId }: { actionId: string },
  ctx: Pick<ActionContext, "clock">,
) => {
  const now = ctx.clock.now();
  const row = await loadAction(db, actionId);
  if (!row) throw notFound();
  if (row.status === "rejected") return { status: "rejected" as const };
  const rejected = await db.transaction(async (tx) => {
    const updated = await tx
      .update(assistantActions)
      .set({ resolvedAt: now, status: "rejected" })
      .where(and(unclaimed(actionId), gt(assistantActions.expiresAt, now)))
      .returning({ id: assistantActions.id });
    if (updated.length === 0) return false;
    await recordEvent(tx, {
      actor: assistantConfirmActor,
      dedupeKey: `assistant.action_rejected:${actionId}`,
      occurredAt: now,
      payload: { actionId, operation: row.operation },
      type: "assistant.action_rejected",
    });
    return true;
  });
  if (rejected) return { status: "rejected" as const };

  const current = (await loadAction(db, actionId)) ?? row;
  if (current.status === "rejected") return { status: "rejected" as const };
  if (current.status === "proposed" && current.resolvedAt)
    throw new SignalError("action_closed", "This action is already being confirmed.");
  if (current.status === "proposed") {
    await markExpired(db, actionId, now);
    throw new SignalError("action_closed", "This action expired.");
  }
  throw new SignalError("action_closed", `This action is ${current.status}.`);
};
