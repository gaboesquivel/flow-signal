import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { events, merges, needs, proposedSolutions, signals } from "@/lib/db/schema";

import type { Actor } from "../context";
import type { SignalTx } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";

/**
 * Merge and undo (spec 001 → PM triage). A merge moves every signal of the merged-away need to
 * the live need (and the proposed solutions those signals named) and marks it `merged`; nothing
 * is deleted. `undoMerge` moves exactly the signals the merge moved back and restores the
 * previous status. Both run inside the caller's transaction with their event.
 */

type NeedStatus = typeof needs.$inferSelect.status;

export const mergeResultSchema = z.object({
  fromNeedId: z.uuid(),
  intoNeedId: z.uuid(),
  mergeId: z.uuid(),
  /** Every signal that moved; `undo_merge` moves exactly these back. */
  movedSignalIds: z.array(z.uuid()),
});
export type MergeResult = z.infer<typeof mergeResultSchema>;

export const undoMergeResultSchema = z.object({
  intoNeedId: z.uuid(),
  mergeId: z.uuid(),
  /** The restored need. */
  needId: z.uuid(),
  restoredSignalIds: z.array(z.uuid()),
  /** The restored need's status (its status before the merge). */
  status: z.enum(["draft", "open", "planned", "in_progress", "shipped", "declined"]),
});

const lockNeeds = (tx: SignalTx, ids: string[]) =>
  tx
    .select({
      approvedAt: needs.approvedAt,
      id: needs.id,
      mergedIntoId: needs.mergedIntoId,
      status: needs.status,
    })
    .from(needs)
    .where(inArray(needs.id, ids))
    .orderBy(needs.id)
    .for("update");

export const mergeNeeds = async (
  tx: SignalTx,
  {
    actor,
    fromNeedId,
    intoNeedId,
    now,
  }: { actor: Actor; fromNeedId: string; intoNeedId: string; now: Date },
): Promise<MergeResult> => {
  if (fromNeedId === intoNeedId)
    throw new SignalError("validation_failed", "A need cannot be merged into itself.");
  const rows = await lockNeeds(tx, [fromNeedId, intoNeedId]);
  const from = rows.find((row) => row.id === fromNeedId);
  const into = rows.find((row) => row.id === intoNeedId);
  if (!from) throw new SignalError("not_found", `No need with id ${fromNeedId}.`);
  if (!into) throw new SignalError("not_found", `No need with id ${intoNeedId}.`);
  if (from.status === "merged")
    throw new SignalError("conflict", `Need ${fromNeedId} is already merged.`);
  if (into.status === "merged")
    throw new SignalError(
      "conflict",
      `Need ${intoNeedId} is merged into ${into.mergedIntoId}; merge into that need instead.`,
    );

  const moved = await tx
    .update(signals)
    .set({ needId: intoNeedId })
    .where(eq(signals.needId, fromNeedId))
    .returning({ createdAt: signals.createdAt, id: signals.id });
  const movedSignalIds = moved
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((row) => row.id);
  if (movedSignalIds.length > 0)
    await tx
      .update(proposedSolutions)
      .set({ needId: intoNeedId })
      .where(
        and(
          eq(proposedSolutions.needId, fromNeedId),
          inArray(proposedSolutions.sourceSignalId, movedSignalIds),
        ),
      );
  await tx
    .update(needs)
    .set({ mergedIntoId: intoNeedId, status: "merged" })
    .where(eq(needs.id, fromNeedId));
  const [merge] = await tx
    .insert(merges)
    .values({ createdAt: now, fromNeedId, intoNeedId, movedSignalIds })
    .returning({ id: merges.id });
  if (!merge) throw new Error("Merge insert returned no row.");
  const mergeId = merge.id;
  await recordEvent(tx, {
    actor,
    needId: fromNeedId,
    occurredAt: now,
    payload: { intoNeedId, mergeId, previousStatus: from.status },
    type: "need.merged",
  });
  return { fromNeedId, intoNeedId, mergeId, movedSignalIds };
};

/** The status before the merge, from its `need.merged` event (seeded merges lack it). */
const previousStatus = async (
  tx: SignalTx,
  mergeId: string,
  fallback: { approvedAt: Date | null },
): Promise<Exclude<NeedStatus, "merged">> => {
  const [event] = await tx
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.type, "need.merged"), sql`${events.payload}->>'mergeId' = ${mergeId}`))
    .orderBy(desc(events.occurredAt))
    .limit(1);
  const status = event?.payload.previousStatus;
  const parsed = undoMergeResultSchema.shape.status.safeParse(status);
  if (parsed.success) return parsed.data;
  return fallback.approvedAt ? "open" : "draft";
};

export const undoMerge = async (
  tx: SignalTx,
  { actor, mergeId, now }: { actor: Actor; mergeId: string; now: Date },
) => {
  const [merge] = await tx.select().from(merges).where(eq(merges.id, mergeId)).for("update");
  if (!merge) throw new SignalError("not_found", `No merge with id ${mergeId}.`);
  if (merge.undoneAt) throw new SignalError("conflict", `Merge ${mergeId} was already undone.`);
  const rows = await lockNeeds(tx, [merge.fromNeedId, merge.intoNeedId]);
  const from = rows.find((row) => row.id === merge.fromNeedId);
  const into = rows.find((row) => row.id === merge.intoNeedId);
  if (!from || !into) throw new SignalError("not_found", `Merge ${mergeId} lost its needs.`);
  if (from.status !== "merged" || from.mergedIntoId !== merge.intoNeedId)
    throw new SignalError("conflict", `Need ${from.id} is no longer merged by ${mergeId}.`);
  if (into.status === "merged")
    throw new SignalError(
      "conflict",
      `Need ${into.id} was merged into ${into.mergedIntoId} afterwards; undo that merge first.`,
    );

  const status = await previousStatus(tx, mergeId, from);
  const restored =
    merge.movedSignalIds.length === 0
      ? []
      : await tx
          .update(signals)
          .set({ needId: from.id })
          .where(and(inArray(signals.id, merge.movedSignalIds), eq(signals.needId, into.id)))
          .returning({ id: signals.id });
  const restoredIds = new Set(restored.map((row) => row.id));
  const restoredSignalIds = merge.movedSignalIds.filter((id) => restoredIds.has(id));
  if (restoredSignalIds.length > 0)
    await tx
      .update(proposedSolutions)
      .set({ needId: from.id })
      .where(
        and(
          eq(proposedSolutions.needId, into.id),
          inArray(proposedSolutions.sourceSignalId, restoredSignalIds),
        ),
      );
  await tx.update(needs).set({ mergedIntoId: null, status }).where(eq(needs.id, from.id));
  await tx.update(merges).set({ undoneAt: now }).where(eq(merges.id, mergeId));
  await recordEvent(tx, {
    actor,
    needId: from.id,
    occurredAt: now,
    payload: { intoNeedId: into.id, mergeId },
    type: "merge.undone",
  });
  return { intoNeedId: into.id, mergeId, needId: from.id, restoredSignalIds, status };
};
