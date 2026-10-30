import { and, desc, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { needs, themes } from "@/lib/db/schema";

import type { SignalQueryable } from "../db";

/**
 * The public view of a need (PRODUCT.md → Visibility): statement, status, theme, proposed
 * solutions, supporter count (people only), demand band, the approved use-case summary, and
 * the decision note. Never submitter names, emails, companies, revenue, or verbatim signals.
 */

/** Statuses a live (not merged-away) need can have publicly. */
export const livePublicNeedStatuses = [
  "new",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
] as const;
export const publicNeedStatusSchema = z.enum([...livePublicNeedStatuses, "merged"]);
export type PublicNeedStatus = z.infer<typeof publicNeedStatusSchema>;

export const demandBandSchema = z.enum(["high", "medium", "low"]);
export type DemandBand = z.infer<typeof demandBandSchema>;

export const publicNeedSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  decision: z
    .object({
      note: z.string(),
      publishedAt: z.iso.datetime({ offset: true }),
      status: z.enum(["planned", "in_progress", "shipped", "declined"]),
    })
    .nullable(),
  demandBand: demandBandSchema,
  id: z.uuid(),
  /** Set when this need was merged into another; follow it for the live need. */
  mergedIntoId: z.uuid().nullable(),
  proposedSolutions: z.array(z.string()),
  /** Anonymized use-case summary, only once a PM approved it. */
  publicSummary: z.string().nullable(),
  statement: z.string(),
  status: publicNeedStatusSchema,
  supporterCount: z.number().int().nonnegative(),
  theme: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type PublicNeed = z.infer<typeof publicNeedSchema>;

/** Draft needs are public as "new" (GLOSSARY → Draft need). */
export const toPublicStatus = (status: typeof needs.$inferSelect.status): PublicNeedStatus =>
  status === "draft" ? "new" : status;

export const fromPublicStatus = (status: PublicNeedStatus): typeof needs.$inferSelect.status =>
  status === "new" ? "draft" : status;

/**
 * Demand band from the weighted priority score (0–5, weights sum to 1) when a need is scored,
 * otherwise from its supporter count. Task 05 owns scoring; keep the band rule here.
 */
export const demandBand = ({
  priorityScore,
  supporterCount,
}: {
  priorityScore: number | null;
  supporterCount: number;
}): DemandBand => {
  if (priorityScore !== null) {
    if (priorityScore >= 3.5) return "high";
    if (priorityScore >= 2) return "medium";
    return "low";
  }
  if (supporterCount >= 10) return "high";
  if (supporterCount >= 4) return "medium";
  return "low";
};

const supporterCount = sql<number>`(
  select count(distinct s.submitter_id)::int from signals s where s.need_id = ${needs.id}
)`;

const priorityScore = sql<number | null>`(
  select sum(ps.score * pc.weight)::float8
  from priority_scores ps join priority_criteria pc on pc.key = ps.criterion
  where ps.need_id = ${needs.id}
)`;

const proposedSolutionTexts = sql<string[]>`(
  select coalesce(array_agg(t.text order by t.text), '{}')
  from (select distinct ps.text from proposed_solutions ps where ps.need_id = ${needs.id}) t
)`;

const latestDecision = sql<{ note: string; published_at: string; status: string } | null>`(
  select json_build_object('status', d.status, 'note', d.note, 'published_at', d.published_at)
  from decisions d where d.need_id = ${needs.id}
  order by d.published_at desc limit 1
)`;

const publicNeedColumns = {
  createdAt: needs.createdAt,
  decision: latestDecision,
  id: needs.id,
  mergedIntoId: needs.mergedIntoId,
  priorityScore,
  proposedSolutions: proposedSolutionTexts,
  publicSummary: needs.publicSummary,
  publicSummaryStatus: needs.publicSummaryStatus,
  statement: needs.statement,
  status: needs.status,
  supporterCount,
  themeId: themes.id,
  themeName: themes.name,
};

interface PublicNeedRow {
  createdAt: Date;
  decision: { note: string; published_at: string; status: string } | null;
  id: string;
  mergedIntoId: string | null;
  priorityScore: number | null;
  proposedSolutions: string[];
  publicSummary: string | null;
  publicSummaryStatus: "none" | "pending" | "approved";
  statement: string;
  status: typeof needs.$inferSelect.status;
  supporterCount: number;
  themeId: string | null;
  themeName: string | null;
}

const iso = (value: string | Date) => new Date(value).toISOString();

export const toPublicNeed = (row: PublicNeedRow): PublicNeed => {
  const supporters = Number(row.supporterCount);
  return {
    createdAt: iso(row.createdAt),
    decision: row.decision
      ? {
          note: row.decision.note,
          publishedAt: iso(row.decision.published_at),
          status: row.decision.status as NonNullable<PublicNeed["decision"]>["status"],
        }
      : null,
    demandBand: demandBand({
      priorityScore: row.priorityScore === null ? null : Number(row.priorityScore),
      supporterCount: supporters,
    }),
    id: row.id,
    mergedIntoId: row.mergedIntoId,
    proposedSolutions: row.proposedSolutions,
    publicSummary: row.publicSummaryStatus === "approved" ? row.publicSummary : null,
    statement: row.statement,
    status: toPublicStatus(row.status),
    supporterCount: supporters,
    theme: row.themeId && row.themeName ? { id: row.themeId, name: row.themeName } : null,
  };
};

const selectPublicNeeds = (db: SignalQueryable) =>
  db.select(publicNeedColumns).from(needs).leftJoin(themes, eq(themes.id, needs.themeId));

export const getPublicNeed = async (db: SignalQueryable, id: string) => {
  const [row] = await selectPublicNeeds(db).where(eq(needs.id, id)).limit(1);
  return row ? toPublicNeed(row) : undefined;
};

const escapeLike = (value: string) => value.replaceAll(/[\\%_]/gu, (match) => `\\${match}`);
/** Bounds the per-word conditions a public search can add. */
const MAX_SEARCH_WORDS = 8;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface PublicNeedFilter {
  limit: number;
  offset: number;
  q?: string;
  status?: Exclude<PublicNeedStatus, "merged">;
  /** Theme id or name (case-insensitive). */
  theme?: string;
}

/** Live needs (never merged-away ones) ordered by supporters, then newest. */
export const searchPublicNeeds = async (db: SignalQueryable, filter: PublicNeedFilter) => {
  const conditions: SQL[] = [ne(needs.status, "merged")];
  if (filter.status) conditions.push(eq(needs.status, fromPublicStatus(filter.status)));
  if (filter.theme) {
    const theme = filter.theme.trim();
    conditions.push(
      uuidPattern.test(theme)
        ? eq(needs.themeId, theme)
        : sql`lower(${themes.name}) = lower(${theme})`,
    );
  }
  // Every word must appear somewhere public (statement, theme, approved summary, or a proposed
  // solution), in any order: agents and people search with phrases like "PDF export dashboard".
  const words = (filter.q ?? "").trim().split(/\s+/u).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
  for (const word of words) {
    const pattern = `%${escapeLike(word)}%`;
    const textMatch = or(
      ilike(needs.statement, pattern),
      ilike(themes.name, pattern),
      sql`(${needs.publicSummaryStatus} = 'approved' and ${needs.publicSummary} ilike ${pattern})`,
      sql`exists (select 1 from proposed_solutions ps where ps.need_id = ${needs.id} and ps.text ilike ${pattern})`,
    );
    if (textMatch) conditions.push(textMatch);
  }
  const rows = await selectPublicNeeds(db)
    .where(and(...conditions))
    .orderBy(desc(supporterCount), desc(needs.createdAt), asc(needs.id))
    .limit(filter.limit + 1)
    .offset(filter.offset);
  return {
    hasMore: rows.length > filter.limit,
    needs: rows.slice(0, filter.limit).map(toPublicNeed),
  };
};
