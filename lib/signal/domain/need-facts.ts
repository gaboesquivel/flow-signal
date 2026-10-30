import { asc, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  accounts,
  needs,
  priorityCriteria,
  priorityScores,
  proposedSolutions,
  signals,
  submitters,
  themes,
} from "@/lib/db/schema";

import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import type { CriterionKey } from "./criteria";

/**
 * Operator-side facts about needs, shared by priority scoring, demand summaries, and decision
 * briefs. They include account names and revenue (Operator only); never submitter names or
 * emails, which no model prompt needs.
 */

export const DAY_MS = 86_400_000;
/** `trend` compares the last 30 days of a window with the 30 days before. */
export const TREND_DAYS = 30;

export type Trend = "rising" | "steady" | "falling";

/** rising above +20%, falling below −20%, otherwise steady (spec 001 → get_demand_summary). */
export const trendOf = (recent: number, previous: number): Trend => {
  if (previous === 0) return recent > 0 ? "rising" : "steady";
  const change = (recent - previous) / previous;
  if (change > 0.2) return "rising";
  if (change < -0.2) return "falling";
  return "steady";
};

/** `db.execute` returns `{ rows }` on Neon and PGlite; normalize to the rows. */
export const queryRows = async <Row>(db: SignalQueryable, statement: SQL) => {
  const result = (await db.execute(statement)) as unknown as { rows?: Row[] } | Row[];
  return Array.isArray(result) ? result : (result.rows ?? []);
};

export const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/** Weighted priority score (0–5) of a need; null when it has no scores. */
export const priorityScoreSql = (needId: SQL | string) => sql<number | null>`(
  select sum(ps.score * pc.weight)::float8
  from priority_scores ps join priority_criteria pc on pc.key = ps.criterion
  where ps.need_id = ${needId}
)`;

export const roundScore = (value: number | null) =>
  value === null ? null : Math.round(value * 100) / 100;

/** Distinct supporters whose first signal on the need falls in `[from, to)`. */
const firstSignalsBetween = (needId: string, from: Date, to: Date) => sql<number>`(
  select count(*)::int from (
    select s.submitter_id, min(s.created_at) as first_at from signals s
    where s.need_id = ${needId} group by s.submitter_id
  ) f where f.first_at >= ${ts(from)} and f.first_at < ${ts(to)}
)`;

export interface NeedFacts {
  accounts: { arrCents: number; name: string; openDealCents: number; plan: string }[];
  businessValueCents: number;
  needId: string;
  priorityScore: number | null;
  proposedSolutions: string[];
  scores: { criterion: CriterionKey; reason: string; score: number; source: "ai" | "pm" }[];
  signalCount: number;
  statement: string;
  status: typeof needs.$inferSelect.status;
  supporters: number;
  supportersLast30Days: number;
  supportersPrevious30Days: number;
  theme: { name: string; strategicWeight: number } | null;
  trend: Trend;
  urgency: { high: number; low: number; medium: number };
  /** Up to 12 of the supporters' own use cases, newest first (verbatim; Operator only). */
  useCases: string[];
  weights: Partial<Record<CriterionKey, number>>;
}

/** Everything a model needs to reason about one need; `not_found` when it does not exist. */
export const loadNeedFacts = async (
  db: SignalQueryable,
  needId: string,
  now: Date,
): Promise<NeedFacts> => {
  const recentFrom = new Date(now.getTime() - TREND_DAYS * DAY_MS);
  const previousFrom = new Date(now.getTime() - 2 * TREND_DAYS * DAY_MS);
  const [need] = await db
    .select({
      id: needs.id,
      previous: firstSignalsBetween(needId, previousFrom, recentFrom),
      priorityScore: priorityScoreSql(needId),
      recent: firstSignalsBetween(needId, recentFrom, now),
      statement: needs.statement,
      status: needs.status,
      themeName: themes.name,
      themeWeight: themes.strategicWeight,
    })
    .from(needs)
    .leftJoin(themes, eq(themes.id, needs.themeId))
    .where(eq(needs.id, needId))
    .limit(1);
  if (!need) throw new SignalError("not_found", `No need with id ${needId}.`);

  const signalRows = await db
    .select({
      accountId: accounts.id,
      arrCents: accounts.arrCents,
      name: accounts.name,
      openDealCents: accounts.openDealCents,
      plan: accounts.plan,
      submitterId: signals.submitterId,
      urgency: signals.urgency,
      useCase: signals.useCase,
    })
    .from(signals)
    .innerJoin(submitters, eq(submitters.id, signals.submitterId))
    .leftJoin(accounts, eq(accounts.id, submitters.accountId))
    .where(eq(signals.needId, needId))
    .orderBy(desc(signals.createdAt), asc(signals.id));

  const accountMap = new Map<string, NeedFacts["accounts"][number]>();
  const urgencyCounts = { high: 0, low: 0, medium: 0 };
  for (const row of signalRows) {
    if (row.accountId && row.name && row.plan)
      accountMap.set(row.accountId, {
        arrCents: Number(row.arrCents ?? 0),
        name: row.name,
        openDealCents: Number(row.openDealCents ?? 0),
        plan: row.plan,
      });
    if (row.urgency) urgencyCounts[row.urgency] += 1;
  }
  const accountList = [...accountMap.values()].toSorted((a, b) => a.name.localeCompare(b.name));

  const solutions = await db
    .selectDistinct({ text: proposedSolutions.text })
    .from(proposedSolutions)
    .where(eq(proposedSolutions.needId, needId))
    .orderBy(asc(proposedSolutions.text));
  const scores = await db
    .select({
      criterion: priorityScores.criterion,
      reason: priorityScores.reason,
      score: priorityScores.score,
      source: priorityScores.source,
    })
    .from(priorityScores)
    .where(eq(priorityScores.needId, needId))
    .orderBy(asc(priorityScores.criterion));
  const weights = await db.select().from(priorityCriteria);

  const recent = Number(need.recent);
  const previous = Number(need.previous);
  return {
    accounts: accountList,
    businessValueCents: accountList.reduce(
      (sum, account) => sum + account.arrCents + account.openDealCents,
      0,
    ),
    needId: need.id,
    priorityScore: roundScore(need.priorityScore === null ? null : Number(need.priorityScore)),
    proposedSolutions: solutions.map((row) => row.text),
    scores,
    signalCount: signalRows.length,
    statement: need.statement,
    status: need.status,
    supporters: new Set(signalRows.map((row) => row.submitterId)).size,
    supportersLast30Days: recent,
    supportersPrevious30Days: previous,
    theme:
      need.themeName === null
        ? null
        : { name: need.themeName, strategicWeight: Number(need.themeWeight ?? 0) },
    trend: trendOf(recent, previous),
    urgency: urgencyCounts,
    useCases: signalRows
      .map((row) => row.useCase?.trim())
      .filter((useCase): useCase is string => Boolean(useCase))
      .slice(0, 12),
    weights: Object.fromEntries(weights.map((row) => [row.key, row.weight])),
  };
};

export const formatCents = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** Facts as plain text for a model prompt (data, not instructions). */
export const describeNeedFacts = (facts: NeedFacts) =>
  [
    `Need: ${JSON.stringify(facts.statement)}`,
    `Status: ${facts.status}`,
    `Theme: ${facts.theme ? `${facts.theme.name} (strategic weight ${facts.theme.strategicWeight})` : "none"}`,
    `Supporters: ${facts.supporters} people, ${facts.signalCount} signals; new supporters last 30 days: ${facts.supportersLast30Days}, previous 30 days: ${facts.supportersPrevious30Days} (trend ${facts.trend})`,
    `Urgency: high ${facts.urgency.high}, medium ${facts.urgency.medium}, low ${facts.urgency.low}`,
    `Accounts (${facts.accounts.length}, combined ARR + open deals ${formatCents(facts.businessValueCents)}):`,
    ...facts.accounts.map(
      (account) =>
        `- ${account.name} (${account.plan}): ARR ${formatCents(account.arrCents)}, open deals ${formatCents(account.openDealCents)}`,
    ),
    `Proposed solutions: ${facts.proposedSolutions.length ? facts.proposedSolutions.join("; ") : "none"}`,
    `Use cases from supporters:`,
    ...(facts.useCases.length
      ? facts.useCases.map((useCase) => `- ${JSON.stringify(useCase)}`)
      : ["- none given"]),
    `Current scores (0–5): ${
      facts.scores.length
        ? facts.scores
            .map((score) => `${score.criterion} ${score.score} (${score.source}): ${score.reason}`)
            .join("; ")
        : "none"
    }`,
  ].join("\n");
