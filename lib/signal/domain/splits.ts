import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { needs, proposedSolutions, signals } from "@/lib/db/schema";

import type { Actor } from "../context";
import type { SignalQueryable, SignalTx } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";

/**
 * Split (spec 001 → PM triage): moves some of a need's signals, with the proposed solutions
 * they named, to a new need. The new need gets `need.created` (decision latency starts there)
 * and the source need `need.split`. Embed the new need after the transaction commits
 * (`embedNeedsQuietly`).
 */

export const splitResultSchema = z.object({
  fromNeedId: z.uuid(),
  movedSignalIds: z.array(z.uuid()),
  /** The new need. */
  needId: z.uuid(),
  statement: z.string(),
  status: z.enum(["draft", "open"]),
});
type SplitResult = z.infer<typeof splitResultSchema>;

type NeedRow = typeof needs.$inferSelect;

/** The checks `splitNeed` makes before writing anything; shared with `previewSplit`. */
const checkSplit = ({
  needId,
  onNeed,
  signalIds,
  source,
  statement,
}: {
  needId: string;
  onNeed: { id: string }[];
  signalIds: string[];
  source: NeedRow | undefined;
  statement: string;
}) => {
  if (!source) throw new SignalError("not_found", `No need with id ${needId}.`);
  if (source.status === "merged")
    throw new SignalError("conflict", `Need ${needId} is merged into ${source.mergedIntoId}.`);
  const text = statement.trim();
  if (text.length < 10)
    throw new SignalError("validation_failed", "The new need needs a statement.");
  const wanted = [...new Set(signalIds)];
  if (wanted.length === 0)
    throw new SignalError("validation_failed", "Choose at least one signal to split out.");
  const onNeedIds = new Set(onNeed.map((row) => row.id));
  const missing = wanted.filter((id) => !onNeedIds.has(id));
  if (missing.length > 0)
    throw new SignalError(
      "validation_failed",
      `Signals ${missing.join(", ")} are not on need ${needId}.`,
    );
  if (wanted.length === onNeed.length)
    throw new SignalError(
      "validation_failed",
      "A split must leave at least one signal on the original need.",
    );
  return { source, text, wanted };
};

/** The new need's status: a split of a draft stays a draft. */
const splitStatus = (source: NeedRow) => (source.status === "draft" ? "draft" : "open");

export const splitNeed = async (
  tx: SignalTx,
  {
    actor,
    needId,
    now,
    signalIds,
    statement,
  }: { actor: Actor; needId: string; now: Date; signalIds: string[]; statement: string },
): Promise<SplitResult> => {
  const [found] = await tx.select().from(needs).where(eq(needs.id, needId)).for("update");
  const onNeed = found
    ? await tx
        .select({ createdAt: signals.createdAt, id: signals.id })
        .from(signals)
        .where(eq(signals.needId, needId))
        .for("update")
    : [];
  const { source, text, wanted } = checkSplit({
    needId,
    onNeed,
    signalIds,
    source: found,
    statement,
  });

  const movedSignalIds = onNeed
    .filter((row) => wanted.includes(row.id))
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((row) => row.id);
  const status = splitStatus(source);
  const [created] = await tx
    .insert(needs)
    .values({
      approvedAt: status === "open" ? now : null,
      createdAt: now,
      statement: text,
      status,
      themeId: source.themeId,
    })
    .returning({ id: needs.id });
  if (!created) throw new Error("Split need insert returned no row.");
  const newNeedId = created.id;
  await tx.update(signals).set({ needId: newNeedId }).where(inArray(signals.id, movedSignalIds));
  await tx
    .update(proposedSolutions)
    .set({ needId: newNeedId })
    .where(
      and(
        eq(proposedSolutions.needId, needId),
        inArray(proposedSolutions.sourceSignalId, movedSignalIds),
      ),
    );
  await recordEvent(tx, {
    actor,
    needId: newNeedId,
    occurredAt: now,
    payload: { splitFrom: needId },
    signalId: movedSignalIds[0],
    type: "need.created",
  });
  await recordEvent(tx, {
    actor,
    needId,
    occurredAt: now,
    payload: { newNeedId, signalIds: movedSignalIds },
    type: "need.split",
  });
  return { fromNeedId: needId, movedSignalIds, needId: newNeedId, statement: text, status };
};

/**
 * What `splitNeed` would do now, read-only (spec 014 previews): the same checks and errors, the
 * source need, the signals leaving and staying, the new statement, and the new need's status.
 */
export const previewSplit = async (
  db: SignalQueryable,
  { needId, signalIds, statement }: { needId: string; signalIds: string[]; statement: string },
) => {
  const [found] = await db.select().from(needs).where(eq(needs.id, needId));
  const onNeed = found
    ? await db.select({ id: signals.id }).from(signals).where(eq(signals.needId, needId))
    : [];
  const { source, text, wanted } = checkSplit({
    needId,
    onNeed,
    signalIds,
    source: found,
    statement,
  });
  return {
    leaving: wanted.length,
    source,
    statement: text,
    status: splitStatus(source),
    staying: onNeed.length - wanted.length,
  };
};
