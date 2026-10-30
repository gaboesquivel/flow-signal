import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { events, merges, needs, proposedSolutions, signals, suggestions } from "@/lib/db/schema";

import type { Actor } from "../context";
import type { SignalQueryable, SignalTx } from "../db";
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
type MergeResult = z.infer<typeof mergeResultSchema>;

export const undoMergeResultSchema = z.object({
  intoNeedId: z.uuid(),
  mergeId: z.uuid(),
  /** The restored need. */
  needId: z.uuid(),
  restoredSignalIds: z.array(z.uuid()),
  /** The restored need's status (its status before the merge). */
  status: z.enum(["draft", "open", "planned", "in_progress", "shipped", "declined"]),
});

const needColumns = {
  approvedAt: needs.approvedAt,
  id: needs.id,
  mergedIntoId: needs.mergedIntoId,
  statement: needs.statement,
  status: needs.status,
};
type NeedRow = { [K in keyof typeof needColumns]: (typeof needs.$inferSelect)[K] };

const lockNeeds = (tx: SignalTx, ids: string[]) =>
  tx.select(needColumns).from(needs).where(inArray(needs.id, ids)).orderBy(needs.id).for("update");

/** Unlocked read for previews (spec 014): same rows, no lock. */
const readNeeds = (db: SignalQueryable, ids: string[]) =>
  db.select(needColumns).from(needs).where(inArray(needs.id, ids)).orderBy(needs.id);

/** The checks `mergeNeeds` makes before moving anything; shared with `previewMerge`. */
const mergeablePair = (rows: NeedRow[], fromNeedId: string, intoNeedId: string) => {
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
  return { from, into };
};

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
  const { from } = mergeablePair(
    await lockNeeds(tx, [fromNeedId, intoNeedId]),
    fromNeedId,
    intoNeedId,
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

type MergeRow = typeof merges.$inferSelect;

/** The checks `undoMerge` makes before moving anything; shared with `previewUndoMerge`. */
const undoablePair = (merge: MergeRow | undefined, mergeId: string, rows: NeedRow[]) => {
  if (!merge) throw new SignalError("not_found", `No merge with id ${mergeId}.`);
  if (merge.undoneAt) throw new SignalError("conflict", `Merge ${mergeId} was already undone.`);
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
  return { from, into, merge };
};

/** The status before the merge, from its `need.merged` event (seeded merges lack it). */
const previousStatus = async (
  tx: SignalQueryable,
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
  const [found] = await tx.select().from(merges).where(eq(merges.id, mergeId)).for("update");
  const { from, into, merge } = undoablePair(
    found,
    mergeId,
    found ? await lockNeeds(tx, [found.fromNeedId, found.intoNeedId]) : [],
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

/** Distinct submitters with a signal on any of `needIds`. */
const countPeople = async (db: SignalQueryable, needIds: string[]) => {
  const [row] = await db
    .select({ people: sql<number | string>`count(distinct ${signals.submitterId})` })
    .from(signals)
    .where(inArray(signals.needId, needIds));
  return Number(row?.people ?? 0);
};

/**
 * What `mergeNeeds` would do now, read-only (spec 014 previews): the same checks and errors,
 * the signals and people that would move, the people on the target afterwards, and the pending
 * suggestions about the merged-away need (as subject or target) that the merge leaves stale.
 */
export const previewMerge = async (
  db: SignalQueryable,
  { fromNeedId, intoNeedId }: { fromNeedId: string; intoNeedId: string },
) => {
  if (fromNeedId === intoNeedId)
    throw new SignalError("validation_failed", "A need cannot be merged into itself.");
  const { from, into } = mergeablePair(
    await readNeeds(db, [fromNeedId, intoNeedId]),
    fromNeedId,
    intoNeedId,
  );
  const [moving] = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(signals)
    .where(eq(signals.needId, fromNeedId));
  const [open] = await db
    .select({ count: sql<number | string>`count(*)` })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.status, "pending"),
        sql`(${suggestions.needId} = ${fromNeedId} or ${suggestions.relatedNeedId} = ${fromNeedId})`,
      ),
    );
  return {
    from,
    into,
    openSuggestions: Number(open?.count ?? 0),
    peopleAfter: await countPeople(db, [fromNeedId, intoNeedId]),
    peopleMoving: await countPeople(db, [fromNeedId]),
    signalsMoving: Number(moving?.count ?? 0),
  };
};

/**
 * What `undoMerge` would do now, read-only: the same checks and errors, the needs, the status
 * restored, and the merge's signals that would return (those still on the target).
 */
export const previewUndoMerge = async (db: SignalQueryable, mergeId: string) => {
  const [row] = await db.select().from(merges).where(eq(merges.id, mergeId));
  const { from, into, merge } = undoablePair(
    row,
    mergeId,
    row ? await readNeeds(db, [row.fromNeedId, row.intoNeedId]) : [],
  );
  const returning =
    merge.movedSignalIds.length === 0
      ? []
      : await db
          .select({ id: signals.id })
          .from(signals)
          .where(and(inArray(signals.id, merge.movedSignalIds), eq(signals.needId, into.id)));
  return {
    from,
    into,
    merge,
    signalsReturning: returning.length,
    status: await previousStatus(db, mergeId, from),
  };
};
