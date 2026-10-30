import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { mergeChecks, needs, signals, suggestions } from "@/lib/db/schema";

import type { SignalAi } from "../ai/ports";
import type { Actor, Clock, OperationContext } from "../context";
import type { SignalDb, SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { tryEmbed } from "./embeddings";
import { judgeMergeCandidates } from "./merge-judge";
import { mergeNeeds } from "./merges";
import { getPublicNeed, publicNeedSchema } from "./public-needs";
import { resolveTrackingLink } from "./tracking-links";

/**
 * The post-submission duplicate backstop (spec 009). A **merge check** asks the merge judge
 * (`merge-judge.ts`) whether a draft need duplicates one of its nearest needs, up to twice per
 * check, and records what it saw in `merge_checks`. A draft is **due** for another check only
 * when the draft, its eligible candidates, or their supporters changed, so a **duplicate sweep**
 * over recent drafts costs no model call when nothing moved. Generation runs the first check;
 * the sweep runs after every submission (same `after()` task), after `pnpm db:embed`, and on
 * demand (`sweep_duplicates`). Submitters see pending proposals on My signals as suggested
 * matches and answer them with `answer_suggested_match`.
 */

/** Nearest needs shown to the judge per question. */
export const MERGE_CANDIDATES = 5;
/** Merge suggestions one check may create (the judge is asked again without each pick). */
export const MAX_PROPOSALS_PER_CHECK = 2;
/** Due drafts checked per sweep run after a submission. */
export const SWEEP_CHECKS_PER_RUN = 2;
/** Drafts older than this are left to the PM. */
export const SWEEP_WINDOW_DAYS = 30;
/** Drafts a sweep looks at (newest first) before stopping. */
const SWEEP_SCAN_LIMIT = 50;
const DAY_MS = 86_400_000;

/** The event actor for AI-created suggestions (matches suggestion generation and the seed). */
const SUGGESTION_AI_ACTOR: Actor = { kind: "agent", ref: "signal:ai" };

export interface BackstopDeps {
  ai: SignalAi;
  clock: Clock;
  db: SignalDb;
}

export interface CheckResult {
  needId: string;
  proposed: { intoNeedId: string; suggestionId: string }[];
  /**
   * `checked`: the judge was asked (`proposed` may be empty). `not_due`: nothing changed since
   * the last check. `unavailable`: AI was down; nothing recorded, so it stays due. `skipped`:
   * not a live draft.
   */
  status: "checked" | "not_due" | "skipped" | "unavailable";
}

type Snapshot = { needId: string; supporters: number }[];

const isAiUnavailable = (error: unknown) =>
  error instanceof SignalError && error.code === "ai_unavailable";

const supporterCounts = async (db: SignalQueryable, needIds: string[]) => {
  if (needIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ needId: signals.needId, supporters: sql<number | string>`count(*)` })
    .from(signals)
    .where(inArray(signals.needId, needIds))
    .groupBy(signals.needId);
  return new Map(rows.map((row) => [row.needId, Number(row.supporters)]));
};

/**
 * Needs a check must not propose for `needId`: ones already proposed from it (pending or
 * rejected) and ones with a pending proposal into it (no mutual proposals).
 */
const excludedTargets = async (db: SignalQueryable, needId: string) => {
  const rows = await db
    .select({
      needId: suggestions.needId,
      relatedNeedId: suggestions.relatedNeedId,
      status: suggestions.status,
    })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.kind, "merge"),
        or(
          and(eq(suggestions.needId, needId), inArray(suggestions.status, ["pending", "rejected"])),
          and(eq(suggestions.relatedNeedId, needId), eq(suggestions.status, "pending")),
        ),
      ),
    );
  return new Set(
    rows.flatMap((row) => [row.needId === needId ? row.relatedNeedId : row.needId]),
  ) as Set<string>;
};

const eligibleCandidates = async (
  { ai, db }: BackstopDeps,
  needId: string,
  embedding: number[],
) => {
  const excluded = await excludedTargets(db, needId);
  const retrieved = await ai.retriever.retrieve({
    db,
    embedding,
    limit: MERGE_CANDIDATES + excluded.size + 1,
  });
  return retrieved
    .filter((c) => c.needId !== needId && !excluded.has(c.needId))
    .slice(0, MERGE_CANDIDATES);
};

/** The due rule (spec 009 → Due rule). */
const isDue = (
  previous: typeof mergeChecks.$inferSelect | undefined,
  current: { candidates: Snapshot; draftSupporters: number },
) => {
  if (!previous) return true;
  if (previous.draftSupporters !== current.draftSupporters) return true;
  const before = new Map(previous.candidates.map((c) => [c.needId, c.supporters]));
  if (before.size !== current.candidates.length) return true;
  return current.candidates.some(
    (c) => !before.has(c.needId) || c.supporters > (before.get(c.needId) ?? 0),
  );
};

/** Stores one merge suggestion unless the pair was already proposed (overlapping sweeps). */
const storeMergeSuggestion = (
  { clock, db }: BackstopDeps,
  {
    fromNeedId,
    model,
    reason,
    similarity,
    intoNeedId,
  }: { fromNeedId: string; intoNeedId: string; model: string; reason: string; similarity: number },
) =>
  db.transaction(async (tx) => {
    // Serializes checks of the same draft, so the pair check below is reliable.
    await tx.select({ id: needs.id }).from(needs).where(eq(needs.id, fromNeedId)).for("update");
    const [existing] = await tx
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.kind, "merge"),
          inArray(suggestions.status, ["pending", "rejected"]),
          or(
            and(eq(suggestions.needId, fromNeedId), eq(suggestions.relatedNeedId, intoNeedId)),
            and(
              eq(suggestions.needId, intoNeedId),
              eq(suggestions.relatedNeedId, fromNeedId),
              eq(suggestions.status, "pending"),
            ),
          ),
        ),
      )
      .limit(1);
    if (existing) return;
    const now = clock.now();
    const [row] = await tx
      .insert(suggestions)
      .values({
        createdAt: now,
        kind: "merge",
        model,
        needId: fromNeedId,
        payload: { intoNeedId, reason: reason.trim(), similarity },
        relatedNeedId: intoNeedId,
      })
      .returning({ id: suggestions.id });
    if (!row) throw new Error("Suggestion insert returned no row.");
    await recordEvent(tx, {
      actor: SUGGESTION_AI_ACTOR,
      needId: fromNeedId,
      occurredAt: now,
      payload: { kind: "merge" },
      suggestionId: row.id,
      type: "suggestion.created",
    });
    return row.id;
  });

/**
 * One merge check of a draft need: embed it if it has no vector (and store the vector), decide
 * whether it is due, then ask the judge up to `MAX_PROPOSALS_PER_CHECK` times, each time without
 * the need it picked. Records the check in `merge_checks`. Throws only on database errors.
 */
export const checkDraftForDuplicates = async (
  deps: BackstopDeps,
  needId: string,
): Promise<CheckResult> => {
  const { ai, clock, db } = deps;
  const result = (status: CheckResult["status"], proposed: CheckResult["proposed"] = []) => ({
    needId,
    proposed,
    status,
  });
  const [need] = await db
    .select({ embedding: needs.embedding, statement: needs.statement, status: needs.status })
    .from(needs)
    .where(eq(needs.id, needId));
  if (!need || need.status !== "draft") return result("skipped");

  let { embedding } = need;
  if (!embedding) {
    embedding = await tryEmbed(ai.embedder, need.statement);
    if (!embedding) return result("unavailable");
    await db
      .update(needs)
      .set({ embedding })
      .where(and(eq(needs.id, needId), isNull(needs.embedding)));
  }

  const candidates = await eligibleCandidates(deps, needId, embedding);
  const counts = await supporterCounts(db, [needId, ...candidates.map((c) => c.needId)]);
  const snapshot: Snapshot = candidates.map((c) => ({
    needId: c.needId,
    supporters: counts.get(c.needId) ?? 0,
  }));
  const draftSupporters = counts.get(needId) ?? 0;
  const [previous] = await db.select().from(mergeChecks).where(eq(mergeChecks.needId, needId));
  if (!isDue(previous, { candidates: snapshot, draftSupporters })) return result("not_due");

  const proposed: CheckResult["proposed"] = [];
  let remaining = candidates;
  try {
    while (remaining.length > 0 && proposed.length < MAX_PROPOSALS_PER_CHECK) {
      // Each question depends on the previous answer.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const judgement = await judgeMergeCandidates(ai, need.statement, remaining);
      const target = judgement.candidate === null ? undefined : remaining[judgement.candidate - 1];
      if (!target) break;
      // oxlint-disable-next-line eslint/no-await-in-loop
      const suggestionId = await storeMergeSuggestion(deps, {
        fromNeedId: needId,
        intoNeedId: target.needId,
        model: judgement.model,
        reason: judgement.reason,
        similarity: Math.round(target.similarity * 1000) / 1000,
      });
      if (suggestionId) proposed.push({ intoNeedId: target.needId, suggestionId });
      remaining = remaining.filter((c) => c.needId !== target.needId);
    }
  } catch (error) {
    if (!isAiUnavailable(error)) throw error;
    if (proposed.length === 0) return result("unavailable");
  }

  const checkedAt = clock.now();
  await db
    .insert(mergeChecks)
    .values({ candidates: snapshot, checkedAt, draftSupporters, needId })
    .onConflictDoUpdate({
      set: { candidates: snapshot, checkedAt, draftSupporters },
      target: mergeChecks.needId,
    });
  return result("checked", proposed);
};

export const sweepResultSchema = z.object({
  /** Drafts whose merge check ran (the judge was asked), with the merges it proposed. */
  checked: z.array(
    z.object({
      needId: z.uuid(),
      proposed: z.array(z.object({ intoNeedId: z.uuid(), suggestionId: z.uuid() })),
    }),
  ),
  /** Live drafts from the last 30 days looked at. */
  examined: z.number().int().nonnegative(),
  /** Drafts that could not be checked because AI was unavailable (still due). */
  unavailable: z.number().int().nonnegative(),
});
export type SweepResult = z.infer<typeof sweepResultSchema>;

/**
 * Duplicate sweep: looks at live drafts from the last `SWEEP_WINDOW_DAYS` (newest first) and
 * checks due ones until `checks` checks ran (or AI failed that often). Throws only on database
 * errors.
 */
export const sweepDuplicates = async (
  deps: BackstopDeps,
  { checks = SWEEP_CHECKS_PER_RUN }: { checks?: number } = {},
): Promise<SweepResult> => {
  const since = new Date(deps.clock.now().getTime() - SWEEP_WINDOW_DAYS * DAY_MS);
  const drafts = await deps.db
    .select({ id: needs.id })
    .from(needs)
    .where(and(eq(needs.status, "draft"), gte(needs.createdAt, since)))
    .orderBy(desc(needs.createdAt), desc(needs.id))
    .limit(SWEEP_SCAN_LIMIT);
  const outcome: SweepResult = { checked: [], examined: 0, unavailable: 0 };
  for (const draft of drafts) {
    if (outcome.checked.length + outcome.unavailable >= checks) break;
    outcome.examined += 1;
    // One draft at a time: a check may create a need's vector the next one retrieves.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const checked = await checkDraftForDuplicates(deps, draft.id);
    if (checked.status === "checked")
      outcome.checked.push({ needId: checked.needId, proposed: checked.proposed });
    if (checked.status === "unavailable") outcome.unavailable += 1;
  }
  return outcome;
};

/** `sweepDuplicates` for background work: logs and swallows errors. */
export const sweepDuplicatesQuietly = async (deps: BackstopDeps) => {
  try {
    return await sweepDuplicates(deps);
  } catch (error) {
    console.error(
      "[signal] duplicate sweep failed",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// Submitter follow-up (spec 009 → Submitter follow-up)

export const suggestedMatchSchema = z.object({
  /** The live need Signal thinks this request duplicates. */
  need: publicNeedSchema,
  /** Pass to `answer_suggested_match`. */
  suggestionId: z.uuid(),
});
export type SuggestedMatch = z.infer<typeof suggestedMatchSchema>;

/**
 * Pending merge proposals to offer on a My signals link, by draft need id. Only drafts every
 * signal of which is on `linkId` (the holder alone supports them), only live targets, and never
 * one the holder declined.
 */
export const suggestedMatchesForLink = async (
  db: SignalQueryable,
  linkId: string,
  needIds: string[],
): Promise<Map<string, SuggestedMatch[]>> => {
  const result = new Map<string, SuggestedMatch[]>();
  if (needIds.length === 0) return result;
  const drafts = await db
    .select({ id: needs.id })
    .from(needs)
    .where(
      and(
        inArray(needs.id, needIds),
        eq(needs.status, "draft"),
        sql`not exists (
          select 1 from ${signals}
          where ${signals.needId} = ${needs.id}
            and ${signals.trackingLinkId} is distinct from ${linkId}
        )`,
      ),
    );
  if (drafts.length === 0) return result;
  const rows = await db
    .select({
      id: suggestions.id,
      intoNeedId: suggestions.relatedNeedId,
      needId: suggestions.needId,
    })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.kind, "merge"),
        eq(suggestions.status, "pending"),
        inArray(
          suggestions.needId,
          drafts.map((d) => d.id),
        ),
        sql`coalesce((${suggestions.payload}->>'submitterDeclined')::boolean, false) = false`,
      ),
    )
    .orderBy(suggestions.createdAt, suggestions.id);
  const views = await Promise.all(
    rows.map((row) => (row.intoNeedId ? getPublicNeed(db, row.intoNeedId) : undefined)),
  );
  for (const [index, row] of rows.entries()) {
    const need = views[index];
    if (!row.needId || !need || need.status === "merged") continue;
    const list = result.get(row.needId) ?? [];
    list.push({ need, suggestionId: row.id });
    result.set(row.needId, list);
  }
  return result;
};

export const answerInputSchema = z.object({
  /** `join` adds this request's voice to the suggested need; `decline` keeps it separate. */
  answer: z.enum(["join", "decline"]),
  suggestionId: z.uuid(),
  token: z.string(),
});

export const answerOutputSchema = z.object({
  answer: z.enum(["join", "decline"]),
  /** The need the holder's request is on now (the suggested need after a join). */
  needId: z.uuid(),
});

/**
 * The holder of a My signals link answers a suggested match. `join` merges their draft into the
 * suggested need and accepts the PM suggestion (as the submitter); `decline` leaves it pending
 * for the PM, marked `submitterDeclined`. Both record `follow_up.answered`.
 */
export const answerSuggestedMatch = async (
  { actor, clock, db }: OperationContext,
  { answer, suggestionId, token }: z.output<typeof answerInputSchema>,
) => {
  const link = await resolveTrackingLink(db, token);
  if (!link) throw new SignalError("not_found", "No signals for this link.");
  const notOffered = () =>
    new SignalError("not_found", `Suggestion ${suggestionId} is not offered on this link.`);
  const now = clock.now();
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.id, suggestionId), eq(suggestions.kind, "merge")))
      .for("update");
    if (!suggestion?.needId || !suggestion.relatedNeedId) throw notOffered();
    const draftId = suggestion.needId;
    const intoNeedId = suggestion.relatedNeedId;
    const onDraft = await tx
      .select({ linkId: signals.trackingLinkId })
      .from(signals)
      .where(eq(signals.needId, draftId));
    if (!onDraft.some((row) => row.linkId === link.id)) throw notOffered();
    if (suggestion.status !== "pending")
      throw new SignalError(
        "conflict",
        `Suggestion ${suggestionId} was already ${suggestion.status}.`,
      );
    if (onDraft.some((row) => row.linkId !== link.id))
      throw new SignalError(
        "conflict",
        "Other people support this request too; a product manager will review the match.",
      );

    if (answer === "join") {
      await mergeNeeds(tx, { actor, fromNeedId: draftId, intoNeedId, now });
      await tx
        .update(suggestions)
        .set({ resolvedAt: now, resolvedByKind: actor.kind, status: "accepted" })
        .where(eq(suggestions.id, suggestionId));
      await recordEvent(tx, {
        actor,
        needId: draftId,
        occurredAt: now,
        payload: { kind: "merge", via: "submitter" },
        suggestionId,
        type: "suggestion.accepted",
      });
    } else
      await tx
        .update(suggestions)
        .set({ payload: sql`${suggestions.payload} || '{"submitterDeclined": true}'::jsonb` })
        .where(eq(suggestions.id, suggestionId));
    await recordEvent(tx, {
      actor,
      dedupeKey: `follow_up.answered:${suggestionId}`,
      needId: draftId,
      occurredAt: now,
      payload: { answer, intoNeedId, suggestionId },
      suggestionId,
      type: "follow_up.answered",
    });
    return { answer, needId: answer === "join" ? intoNeedId : draftId };
  });
};
