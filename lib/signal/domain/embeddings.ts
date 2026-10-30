import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";

import { needs } from "@/lib/db/schema";

import type { Embedder } from "../ai/ports";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";

/**
 * Need embeddings (spec 001 → retrieve step). A need is embedded when it is created and when its
 * statement changes; `embedMissingNeeds` backfills any that were stored without one (seeded
 * without Gateway access, or created while the embedder was down). Embeddings are only a
 * retrieval aid: a need without one is simply not a match candidate until it is embedded.
 */

/** Embeds one statement, or returns null when AI is unavailable (the caller stores no vector). */
export const tryEmbed = async (embedder: Embedder, text: string) => {
  try {
    const [vector] = await embedder.embed([text]);
    return vector ?? null;
  } catch (error) {
    if (error instanceof SignalError && error.code === "ai_unavailable") return null;
    throw error;
  }
};

/**
 * Re-embeds the given needs from their current statements. Call it after a statement change
 * (resolve_suggestion edits, split_need) outside the write transaction, or with `after()`.
 * Returns how many were embedded; throws `ai_unavailable` when the embedder is down.
 */
export const embedNeeds = async (db: SignalQueryable, embedder: Embedder, needIds: string[]) => {
  if (needIds.length === 0) return 0;
  const rows = await db
    .select({ id: needs.id, statement: needs.statement })
    .from(needs)
    .where(inArray(needs.id, needIds));
  if (rows.length === 0) return 0;
  const vectors = await embedder.embed(rows.map((row) => row.statement));
  const updates = rows.flatMap((row, index) => {
    const embedding = vectors[index];
    return embedding?.length
      ? [db.update(needs).set({ embedding }).where(eq(needs.id, row.id))]
      : [];
  });
  await Promise.all(updates);
  return updates.length;
};

/**
 * Backfill: embeds every live need that has no embedding, in batches. Idempotent (embedded
 * needs are skipped), so it is safe to rerun. Used by `pnpm db:embed`.
 */
export const embedMissingNeeds = async (
  db: SignalQueryable,
  embedder: Embedder,
  { batchSize = 64 }: { batchSize?: number } = {},
) => {
  let embedded = 0;
  for (;;) {
    // Batches run one after another: each query sees what the previous batch embedded.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const batch = await db
      .select({ id: needs.id })
      .from(needs)
      .where(and(isNull(needs.embedding), ne(needs.status, "merged")))
      .orderBy(asc(needs.createdAt), asc(needs.id))
      .limit(batchSize);
    if (batch.length === 0) return embedded;
    // oxlint-disable-next-line eslint/no-await-in-loop
    const count = await embedNeeds(
      db,
      embedder,
      batch.map((row) => row.id),
    );
    // An embedder that returns nothing would otherwise loop forever.
    if (count === 0) return embedded;
    embedded += count;
  }
};
