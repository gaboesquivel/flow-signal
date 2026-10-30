import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { decisions, needs, suggestions } from "@/lib/db/schema";

import type { SignalAi } from "../ai/ports";
import type { Clock } from "../context";
import type { SignalDb, SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { decisionStatusSchema, draftDecisionBrief } from "./decisions";
import { getStrategy, readinessLine } from "./strategy";
import type { Readiness } from "./strategy";
import { aiSuggestionActor } from "./priority";
import { scheduleOffHotPath } from "./scheduler";
import type { SuggestionScheduler } from "./scheduler";

/**
 * Readiness (spec 007 → Readiness). A live, undecided need (`draft | open`, no decision) is
 * ready when its distinct supporting accounts' ARR or its distinct supporters reach the readiness
 * line (`readinessLine(getStrategy())`; a threshold of 0 is unused). It is marked once: `ready_at`
 * is set and `need.ready` recorded (`dedupeKey: need.ready:<needId>`), and an automatic decision
 * brief is scheduled off the hot path.
 *
 * Callers: suggestion generation after a signal lands (that signal's need), `merge_needs` and
 * `undo_merge` (both needs, scheduled after the response), and `set_strategy` (every live need,
 * inline so it can report `newlyReady`).
 *
 * Auto briefs: a ready, undecided need gets one only when it has no pending `decision_brief`
 * and none was drafted since it became ready (so a brief the PM already resolved is not redrafted).
 * `ai_unavailable` leaves readiness recorded and no brief; the next check for that need drafts it.
 */

export interface ReadinessDeps {
  ai: SignalAi;
  clock: Clock;
  db: SignalDb;
  /** Where auto briefs run; defaults to the suggestion scheduler (Next.js `after()`). */
  schedule?: SuggestionScheduler;
}

/** Distinct supporting accounts' ARR in cents (the query Crewday's `observeDemand` uses). */
export const needArrCentsSql = sql<string>`coalesce((
  select sum(a.arr_cents) from accounts a where a.id in (
    select sb.account_id from signals s join submitters sb on sb.id = s.submitter_id
    where s.need_id = "needs"."id"
  )
), 0)`;

/** Distinct supporters (submitters) with a signal on the need. */
export const needSupportersSql = sql<string>`(
  select count(distinct s.submitter_id) from signals s where s.need_id = "needs"."id"
)`;

/** Live (`draft | open`) needs with no published decision. */
export const liveUndecided = (db: SignalQueryable): SQL =>
  and(
    inArray(needs.status, ["draft", "open"]),
    notExists(
      db
        .select({ one: sql`1` })
        .from(decisions)
        .where(eq(decisions.needId, needs.id)),
    ),
  ) ?? sql`false`;

/** Whether demand meets the line: either nonzero threshold reached. */
export const meetsReadiness = (
  line: Readiness,
  { arrCents, supporters }: { arrCents: number; supporters: number },
) =>
  (line.readinessArrCents > 0 && arrCents >= line.readinessArrCents) ||
  (line.readinessSupporters > 0 && supporters >= line.readinessSupporters);

const describeError = (error: unknown) => {
  if (error instanceof SignalError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

/** Ready, undecided needs among `needIds` (all when omitted) that should get an auto brief. */
const needsWantingBrief = async (db: SignalDb, needIds?: string[]) => {
  const rows = await db
    .select({ id: needs.id })
    .from(needs)
    .where(
      and(
        liveUndecided(db),
        isNotNull(needs.readyAt),
        needIds ? inArray(needs.id, needIds) : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(suggestions)
            .where(
              and(
                eq(suggestions.needId, needs.id),
                eq(suggestions.kind, "decision_brief"),
                or(eq(suggestions.status, "pending"), gte(suggestions.createdAt, needs.readyAt)),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(needs.readyAt), asc(needs.id));
  return rows.map((row) => row.id);
};

/**
 * Drafts the automatic brief for a ready need unless one is pending or already drafted since it
 * became ready (rechecked here, when the task runs). Never throws.
 */
export const draftAutoBrief = async ({ ai, clock, db }: ReadinessDeps, needId: string) => {
  try {
    const [wanted] = await needsWantingBrief(db, [needId]);
    if (!wanted) return null;
    return await draftDecisionBrief({ ai, db, now: clock.now() }, needId);
  } catch (error) {
    if (!(error instanceof SignalError && error.code === "ai_unavailable"))
      console.error("[signal] automatic decision brief failed", describeError(error));
    return null;
  }
};

/**
 * Checks `needIds` (every live need when omitted) against the readiness line: marks newly ready
 * needs once and schedules a brief for each ready need that still lacks one. Returns the ids of
 * the needs that became ready in this call, oldest first. Throws only on database errors.
 */
export const checkReadiness = async (deps: ReadinessDeps, needIds?: string[]) => {
  if (needIds && needIds.length === 0) return [];
  const { clock, db } = deps;
  const strategy = await getStrategy(db);
  const line = readinessLine(strategy);
  const candidates = await db
    .select({ arr: needArrCentsSql, id: needs.id, supporters: needSupportersSql })
    .from(needs)
    .where(
      and(
        liveUndecided(db),
        isNull(needs.readyAt),
        needIds ? inArray(needs.id, needIds) : undefined,
      ),
    )
    .orderBy(asc(needs.createdAt), asc(needs.id));

  const newlyReady: string[] = [];
  for (const candidate of candidates) {
    const demand = { arrCents: Number(candidate.arr), supporters: Number(candidate.supporters) };
    if (!meetsReadiness(line, demand)) continue;
    const now = clock.now();
    // oxlint-disable-next-line eslint/no-await-in-loop -- one short transaction per ready need
    const marked = await db.transaction(async (tx) => {
      // Conditional update: a concurrent check that already marked the need wins.
      const [row] = await tx
        .update(needs)
        .set({ readyAt: now })
        .where(and(eq(needs.id, candidate.id), isNull(needs.readyAt)))
        .returning({ id: needs.id });
      if (!row) return false;
      await recordEvent(tx, {
        actor: aiSuggestionActor,
        dedupeKey: `need.ready:${candidate.id}`,
        needId: candidate.id,
        occurredAt: now,
        payload: { ...demand, strategyVersion: strategy?.version ?? null },
        type: "need.ready",
      });
      return true;
    });
    if (marked) newlyReady.push(candidate.id);
  }

  const schedule = deps.schedule ?? scheduleOffHotPath;
  for (const needId of await needsWantingBrief(db, needIds))
    schedule(() => draftAutoBrief(deps, needId));
  return newlyReady;
};

/** `checkReadiness` that never throws (for off-hot-path hooks). */
export const checkReadinessQuietly = async (deps: ReadinessDeps, needIds?: string[]) => {
  try {
    return await checkReadiness(deps, needIds);
  } catch (error) {
    console.error("[signal] readiness check failed", describeError(error));
    return [];
  }
};

/** Schedules `checkReadiness` off the hot path (after `merge_needs` and `undo_merge`). */
export const scheduleReadinessCheck = (deps: ReadinessDeps, needIds: string[]) => {
  const schedule = deps.schedule ?? scheduleOffHotPath;
  schedule(() => checkReadinessQuietly(deps, needIds));
};

const recommendationViewSchema = z
  .object({
    capacityNote: z.string().nullish(),
    confidence: z.number().nullish(),
    note: z.string(),
    status: decisionStatusSchema,
    strategyFit: z.object({ inFocus: z.boolean(), reason: z.string() }).nullish(),
  })
  .loose();

/** One row of `list_ready_needs`: demand now, and the need's latest decision brief. */
export const readyNeedSchema = z.object({
  arrCents: z.number().int(),
  /** The latest `decision_brief` suggestion for the need, or null when none is drafted yet. */
  brief: z
    .object({
      /** The brief's recommendation as stored (null when it is malformed). */
      recommendation: recommendationViewSchema.nullable(),
      status: z.enum(["pending", "accepted", "edited", "rejected"]),
      suggestionId: z.uuid(),
    })
    .nullable(),
  needId: z.uuid(),
  readyAt: z.iso.datetime({ offset: true }),
  statement: z.string(),
  supporters: z.number().int(),
});
export type ReadyNeed = z.infer<typeof readyNeedSchema>;

/** Ready, undecided needs, oldest ready first, with their latest brief. */
export const listReadyNeeds = async (
  db: SignalQueryable,
  { limit, offset }: { limit: number; offset: number },
) => {
  const rows = await db
    .select({
      arr: needArrCentsSql,
      id: needs.id,
      readyAt: needs.readyAt,
      statement: needs.statement,
      supporters: needSupportersSql,
    })
    .from(needs)
    .where(and(liveUndecided(db), isNotNull(needs.readyAt)))
    .orderBy(asc(needs.readyAt), asc(needs.id))
    .limit(limit + 1)
    .offset(offset);
  const page = rows.slice(0, limit);
  const briefs =
    page.length === 0
      ? []
      : await db
          .select({
            createdAt: suggestions.createdAt,
            id: suggestions.id,
            needId: suggestions.needId,
            payload: suggestions.payload,
            status: suggestions.status,
          })
          .from(suggestions)
          .where(
            and(
              eq(suggestions.kind, "decision_brief"),
              inArray(
                suggestions.needId,
                page.map((row) => row.id),
              ),
            ),
          )
          .orderBy(desc(suggestions.createdAt), desc(suggestions.id));
  const latest = new Map<string, (typeof briefs)[number]>();
  for (const brief of briefs)
    if (brief.needId && !latest.has(brief.needId)) latest.set(brief.needId, brief);
  const needsOut: ReadyNeed[] = page.map((row) => {
    const brief = latest.get(row.id);
    const recommendation = recommendationViewSchema.safeParse(brief?.payload.recommendation);
    return {
      arrCents: Number(row.arr),
      brief: brief
        ? {
            recommendation: recommendation.success ? recommendation.data : null,
            status: brief.status,
            suggestionId: brief.id,
          }
        : null,
      needId: row.id,
      readyAt: (row.readyAt ?? new Date(0)).toISOString(),
      statement: row.statement,
      supporters: Number(row.supporters),
    };
  });
  return { hasMore: rows.length > limit, needs: needsOut };
};
