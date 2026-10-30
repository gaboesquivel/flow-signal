import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { needs, suggestionKind, suggestions, suggestionStatus } from "@/lib/db/schema";

import type { OperationContext } from "../context";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { embedNeedsQuietly } from "./embeddings";
import { suggestionKindHandlers } from "./suggestion-kinds";
import type { SuggestionKind, SuggestionRow } from "./suggestion-types";

/**
 * The PM triage queue (spec 001 → PM triage): AI output is always a `suggestions` row until a
 * PM (or an agent with Operator access) accepts, edits, or rejects it. Nothing is applied
 * without that resolution. Per-kind effects live in `suggestion-kinds.ts`.
 */

export const suggestionKinds = suggestionKind.enumValues;
export const suggestionStatuses = suggestionStatus.enumValues;

const iso = z.iso.datetime({ offset: true });
const needRefSchema = z.object({ id: z.uuid(), statement: z.string(), status: z.string() });

export const suggestionViewSchema = z.object({
  createdAt: iso,
  id: z.uuid(),
  kind: z.enum(suggestionKinds),
  model: z.string().nullable(),
  /** The need it is about (the merged-away need for a merge). */
  need: needRefSchema.nullable(),
  needId: z.uuid().nullable(),
  /** The proposal by kind (statement, intoNeedId, themeId, summary, signalIds, scores, ...) and `edit` once edited. */
  payload: z.record(z.string(), z.unknown()),
  /** The model's reason, from the payload. */
  reason: z.string().nullable(),
  /** A merge's target need. */
  relatedNeed: needRefSchema.nullable(),
  relatedNeedId: z.uuid().nullable(),
  resolvedAt: iso.nullable(),
  resolvedByKind: z.enum(["human", "agent"]).nullable(),
  signalIds: z.array(z.uuid()),
  status: z.enum(suggestionStatuses),
  themeId: z.uuid().nullable(),
});
export type SuggestionView = z.infer<typeof suggestionViewSchema>;

export const resolutionSchema = z.object({
  /** What applying it did (merge id, new need id, approved summary, ...); null for a rejection. */
  result: z.record(z.string(), z.unknown()).nullable(),
  suggestion: suggestionViewSchema,
});

/** Shapes rows for output, loading the needs they mention in one query. */
export const toSuggestionViews = async (
  db: SignalQueryable,
  rows: SuggestionRow[],
): Promise<SuggestionView[]> => {
  const needIds = [
    ...new Set(rows.flatMap((row) => [row.needId, row.relatedNeedId]).filter(Boolean)),
  ] as string[];
  const needRows =
    needIds.length === 0
      ? []
      : await db
          .select({ id: needs.id, statement: needs.statement, status: needs.status })
          .from(needs)
          .where(inArray(needs.id, needIds));
  const byId = new Map(needRows.map((row) => [row.id, row]));
  const ref = (id: string | null) => (id ? (byId.get(id) ?? null) : null);
  return rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    kind: row.kind,
    model: row.model,
    need: ref(row.needId),
    needId: row.needId,
    payload: row.payload,
    reason: typeof row.payload.reason === "string" ? row.payload.reason : null,
    relatedNeed: ref(row.relatedNeedId),
    relatedNeedId: row.relatedNeedId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByKind: row.resolvedByKind,
    signalIds: row.signalIds,
    status: row.status,
    themeId: row.themeId,
  }));
};

export interface SuggestionFilter {
  kind?: SuggestionKind;
  limit: number;
  /** As subject (`needId`) or merge target (`relatedNeedId`). */
  needId?: string;
  offset: number;
  status: SuggestionRow["status"];
}

export const listSuggestions = async (db: SignalQueryable, filter: SuggestionFilter) => {
  const conditions: (SQL | undefined)[] = [eq(suggestions.status, filter.status)];
  if (filter.kind) conditions.push(eq(suggestions.kind, filter.kind));
  if (filter.needId)
    conditions.push(
      or(eq(suggestions.needId, filter.needId), eq(suggestions.relatedNeedId, filter.needId)),
    );
  const rows = await db
    .select()
    .from(suggestions)
    .where(and(...conditions))
    .orderBy(desc(suggestions.createdAt), desc(suggestions.id))
    .limit(filter.limit + 1)
    .offset(filter.offset);
  return {
    hasMore: rows.length > filter.limit,
    suggestions: await toSuggestionViews(db, rows.slice(0, filter.limit)),
  };
};

const resolvedStatus = { accept: "accepted", edit: "edited", reject: "rejected" } as const;
export type ResolveAction = keyof typeof resolvedStatus;

/**
 * Accept, edit, or reject one pending suggestion. The kind's effect, the status change, and the
 * `suggestion.accepted | edited | rejected` event (actor = resolver, payload `{ kind }`) commit
 * together; if applying fails (for example the need was merged meanwhile) nothing is written.
 */
export const resolveSuggestion = async (
  { actor, ai, clock, db }: OperationContext,
  { action, edit, id }: { action: ResolveAction; edit?: Record<string, unknown>; id: string },
) => {
  const now = clock.now();
  const outcome = await db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, id))
      .for("update");
    if (!suggestion) throw new SignalError("not_found", `No suggestion with id ${id}.`);
    if (suggestion.status !== "pending")
      throw new SignalError("conflict", `Suggestion ${id} was already ${suggestion.status}.`);

    const handler = suggestionKindHandlers[suggestion.kind];
    let parsedEdit: unknown;
    if (action === "edit") {
      if (!edit) throw new SignalError("validation_failed", "`edit` is required to edit.");
      if (!handler?.edit)
        throw new SignalError(
          "validation_failed",
          `${suggestion.kind} suggestions can't be edited.`,
        );
      const parsed = handler.edit.safeParse(edit);
      if (!parsed.success)
        throw new SignalError("validation_failed", z.prettifyError(parsed.error));
      parsedEdit = parsed.data;
    } else if (edit !== undefined)
      throw new SignalError("validation_failed", "`edit` is only allowed with action `edit`.");

    const base = { actor, ai, now, suggestion, tx };
    const applied =
      action === "reject"
        ? (await handler?.reject?.(base), undefined)
        : await handler?.apply?.({ ...base, edit: parsedEdit });

    const status = resolvedStatus[action];
    const [updated] = await tx
      .update(suggestions)
      .set({
        payload:
          action === "edit" ? { ...suggestion.payload, edit: parsedEdit } : suggestion.payload,
        resolvedAt: now,
        resolvedByKind: actor.kind,
        status,
      })
      .where(eq(suggestions.id, id))
      .returning();
    if (!updated) throw new Error("Suggestion update returned no row.");
    await recordEvent(tx, {
      actor,
      needId: suggestion.needId,
      occurredAt: now,
      payload: { kind: suggestion.kind },
      suggestionId: id,
      type: `suggestion.${status}`,
    });
    return { applied, updated };
  });
  await embedNeedsQuietly(db, ai.embedder, outcome.applied?.embedNeedIds ?? []);
  const [view] = await toSuggestionViews(db, [outcome.updated]);
  if (!view) throw new Error("Suggestion view is missing.");
  return { result: outcome.applied?.result ?? null, suggestion: view };
};
