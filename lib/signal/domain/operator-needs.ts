import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { SignalQueryable } from "../db";
import { criterionKeys } from "./criteria";
import type { CriterionKey } from "./criteria";
import { priorityScoreSql, queryRows, roundScore } from "./need-facts";

/**
 * The PM console's needs table (spec 006 → list_operator_needs): every live (not merged-away)
 * need with its demand, money, scores, and pending triage in one query, so the console never
 * stitches `search_needs`, `get_demand_summary`, and `list_suggestions` together.
 *
 * - `people`: distinct submitters on the need. `accounts`: their distinct accounts.
 * - `arrCents` / `openDealCents`: summed over those accounts.
 * - `score`: the weighted priority score (0–5) with the current weights; null when unscored.
 *   `criterionScores`: the stored score per criterion (null when unscored, a key null when that
 *   criterion has no score), so the console can re-rank for new weights in the browser.
 * - `pendingSuggestions`: pending suggestions about the need, as subject or merge target (the
 *   same rule as `list_suggestions` with `needId`).
 * - Sort `priority`: score descending, unscored last, then people; `people`, `accounts`, `arr`:
 *   that number descending, then people. Ties end on id so the order is stable.
 */

export const operatorNeedStatuses = [
  "draft",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
] as const;
export type OperatorNeedStatus = (typeof operatorNeedStatuses)[number];

export const operatorNeedSorts = ["priority", "people", "accounts", "arr"] as const;
export type OperatorNeedSort = (typeof operatorNeedSorts)[number];

const criterionScoresSchema = z.object(
  Object.fromEntries(criterionKeys.map((key) => [key, z.number().nullable()])) as Record<
    CriterionKey,
    z.ZodNullable<z.ZodNumber>
  >,
);

export const operatorNeedSchema = z.object({
  accounts: z.number().int().nonnegative(),
  arrCents: z.number().int().nonnegative(),
  criterionScores: criterionScoresSchema.nullable(),
  id: z.uuid(),
  openDealCents: z.number().int().nonnegative(),
  pendingSuggestions: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
  score: z.number().nullable(),
  statement: z.string(),
  status: z.enum(operatorNeedStatuses),
  theme: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type OperatorNeed = z.infer<typeof operatorNeedSchema>;

export interface OperatorNeedFilter {
  /** Words that must each appear in the statement, theme name, or a proposed solution. */
  query?: string;
  sort: OperatorNeedSort;
  status?: OperatorNeedStatus;
  themeId?: string;
}

interface OperatorNeedRow {
  accounts: number | string;
  arr_cents: number | string;
  criterion_scores: Record<string, number> | null;
  id: string;
  open_deal_cents: number | string;
  pending_suggestions: number | string;
  people: number | string;
  score: number | string | null;
  statement: string;
  status: OperatorNeedStatus;
  theme_id: string | null;
  theme_name: string | null;
}

const MAX_QUERY_WORDS = 8;
const escapeLike = (value: string) => value.replaceAll(/[\\%_]/gu, (match) => `\\${match}`);

const orderBy: Record<OperatorNeedSort, SQL> = {
  accounts: sql`accounts desc, people desc, n.id`,
  arr: sql`arr_cents desc, people desc, n.id`,
  people: sql`people desc, score desc nulls last, n.id`,
  priority: sql`score desc nulls last, people desc, n.id`,
};

export const listOperatorNeeds = async (
  db: SignalQueryable,
  filter: OperatorNeedFilter,
): Promise<OperatorNeed[]> => {
  const conditions: SQL[] = [sql`n.status <> 'merged'`];
  if (filter.themeId) conditions.push(sql`n.theme_id = ${filter.themeId}`);
  if (filter.status) conditions.push(sql`n.status = ${filter.status}`);
  const words = (filter.query ?? "").trim().split(/\s+/u).filter(Boolean).slice(0, MAX_QUERY_WORDS);
  for (const word of words) {
    const pattern = `%${escapeLike(word)}%`;
    conditions.push(sql`(
      n.statement ilike ${pattern} or t.name ilike ${pattern}
      or exists (select 1 from proposed_solutions ps where ps.need_id = n.id and ps.text ilike ${pattern})
    )`);
  }
  const rows = await queryRows<OperatorNeedRow>(
    db,
    sql`
      select n.id, n.statement, n.status, t.id as theme_id, t.name as theme_name,
        ${priorityScoreSql(sql`n.id`)} as score,
        coalesce(p.people, 0) as people,
        coalesce(a.accounts, 0) as accounts,
        coalesce(a.arr_cents, 0) as arr_cents,
        coalesce(a.open_deal_cents, 0) as open_deal_cents,
        sc.criterion_scores,
        coalesce(sg.pending, 0) as pending_suggestions
      from needs n
      left join themes t on t.id = n.theme_id
      left join lateral (
        select count(distinct s.submitter_id)::int as people from signals s where s.need_id = n.id
      ) p on true
      left join lateral (
        select count(*)::int as accounts, sum(ac.arr_cents)::bigint as arr_cents,
          sum(ac.open_deal_cents)::bigint as open_deal_cents
        from accounts ac
        where ac.id in (
          select u.account_id from signals s join submitters u on u.id = s.submitter_id
          where s.need_id = n.id and u.account_id is not null
        )
      ) a on true
      left join lateral (
        select json_object_agg(ps.criterion, ps.score) as criterion_scores
        from priority_scores ps where ps.need_id = n.id
      ) sc on true
      left join lateral (
        select count(*)::int as pending from suggestions su
        where su.status = 'pending' and (su.need_id = n.id or su.related_need_id = n.id)
      ) sg on true
      where ${sql.join(conditions, sql` and `)}
      order by ${orderBy[filter.sort]}
    `,
  );
  return rows.map((row) => ({
    accounts: Number(row.accounts),
    arrCents: Number(row.arr_cents),
    criterionScores: row.criterion_scores
      ? (Object.fromEntries(
          criterionKeys.map((key) => [key, row.criterion_scores?.[key] ?? null]),
        ) as Record<CriterionKey, number | null>)
      : null,
    id: row.id,
    openDealCents: Number(row.open_deal_cents),
    pendingSuggestions: Number(row.pending_suggestions),
    people: Number(row.people),
    score: roundScore(row.score === null ? null : Number(row.score)),
    statement: row.statement,
    status: row.status,
    theme: row.theme_id && row.theme_name ? { id: row.theme_id, name: row.theme_name } : null,
  }));
};
