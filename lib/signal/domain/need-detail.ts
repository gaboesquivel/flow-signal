import { asc, desc, eq, or } from "drizzle-orm";
import { z } from "zod";

import {
  accounts,
  decisions,
  merges,
  needs,
  priorityCriteria,
  priorityScores,
  proposedSolutions,
  signals,
  submitters,
  suggestions,
  themes,
} from "@/lib/db/schema";

import type { SignalQueryable } from "../db";
import { suggestionViewSchema, toSuggestionViews } from "./suggestions";

/**
 * The Operator's full view of one need (`get_need_detail`): unlike the public view it holds
 * private data (verbatim signals, submitter emails, accounts, revenue). Operator access only.
 */

const iso = z.iso.datetime({ offset: true });

const accountSchema = z.object({
  arrCents: z.number(),
  id: z.uuid(),
  name: z.string(),
  openDealCents: z.number(),
  plan: z.string(),
});

export const needDetailSchema = z.object({
  /** Accounts behind the need's signals, with how many of their people support it. */
  accounts: z.array(accountSchema.extend({ supporters: z.number().int() })),
  approvedAt: iso.nullable(),
  createdAt: iso,
  decisions: z.array(
    z.object({
      briefMarkdown: z.string().nullable(),
      id: z.uuid(),
      note: z.string(),
      publishedAt: iso,
      publishedByKind: z.enum(["human", "agent"]),
      status: z.enum(["planned", "in_progress", "shipped", "declined"]),
    }),
  ),
  id: z.uuid(),
  mergedIntoId: z.uuid().nullable(),
  /** Merges into this need and out of it, newest first; undo with `undo_merge`. */
  merges: z.array(
    z.object({
      createdAt: iso,
      fromNeedId: z.uuid(),
      id: z.uuid(),
      intoNeedId: z.uuid(),
      movedSignalIds: z.array(z.uuid()),
      undoneAt: iso.nullable(),
    }),
  ),
  /** Weighted priority score (0–5) over the current criteria, or null when unscored. */
  priorityScore: z.number().nullable(),
  proposedSolutions: z.array(
    z.object({ id: z.uuid(), sourceSignalId: z.uuid().nullable(), text: z.string() }),
  ),
  publicSummary: z.string().nullable(),
  publicSummaryStatus: z.enum(["none", "pending", "approved"]),
  scores: z.array(
    z.object({
      criterion: z.enum(["demand", "business_value", "strategic_fit", "effort"]),
      reason: z.string(),
      score: z.number(),
      source: z.enum(["ai", "pm"]),
      updatedAt: iso,
    }),
  ),
  signals: z.array(
    z.object({
      account: accountSchema.nullable(),
      actorKind: z.enum(["human", "agent"]),
      agentClient: z.string().nullable(),
      attachedTo: z.enum(["existing", "draft"]),
      body: z.string(),
      channel: z.enum(["web", "mcp"]),
      createdAt: iso,
      id: z.uuid(),
      /** The need it was filed on, if a merge or split moved it since. */
      originalNeedId: z.uuid(),
      submitter: z.object({ email: z.string(), id: z.uuid(), name: z.string().nullable() }),
      title: z.string(),
      urgency: z.enum(["low", "medium", "high"]).nullable(),
      useCase: z.string().nullable(),
    }),
  ),
  statement: z.string(),
  status: z.enum(["draft", "open", "planned", "in_progress", "shipped", "declined", "merged"]),
  /** Suggestions about the need (as subject or merge target), newest first, any status. */
  suggestions: z.array(suggestionViewSchema),
  supporterCount: z.number().int(),
  theme: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
export type NeedDetail = z.infer<typeof needDetailSchema>;

const toAccount = (account: typeof accounts.$inferSelect) => ({
  arrCents: Number(account.arrCents),
  id: account.id,
  name: account.name,
  openDealCents: Number(account.openDealCents),
  plan: account.plan,
});

const round = (value: number) => Math.round(value * 100) / 100;

export const getNeedDetail = async (
  db: SignalQueryable,
  id: string,
): Promise<NeedDetail | undefined> => {
  const [need] = await db
    .select({ need: needs, theme: { id: themes.id, name: themes.name } })
    .from(needs)
    .leftJoin(themes, eq(themes.id, needs.themeId))
    .where(eq(needs.id, id));
  if (!need) return undefined;

  const [
    signalRows,
    solutionRows,
    scoreRows,
    criteriaRows,
    decisionRows,
    mergeRows,
    suggestionRows,
  ] = await Promise.all([
    db
      .select({ account: accounts, signal: signals, submitter: submitters })
      .from(signals)
      .innerJoin(submitters, eq(submitters.id, signals.submitterId))
      .leftJoin(accounts, eq(accounts.id, submitters.accountId))
      .where(eq(signals.needId, id))
      .orderBy(asc(signals.createdAt), asc(signals.id)),
    db
      .select()
      .from(proposedSolutions)
      .where(eq(proposedSolutions.needId, id))
      .orderBy(asc(proposedSolutions.text), asc(proposedSolutions.id)),
    db
      .select()
      .from(priorityScores)
      .where(eq(priorityScores.needId, id))
      .orderBy(asc(priorityScores.criterion)),
    db.select().from(priorityCriteria),
    db
      .select()
      .from(decisions)
      .where(eq(decisions.needId, id))
      .orderBy(desc(decisions.publishedAt)),
    db
      .select()
      .from(merges)
      .where(or(eq(merges.fromNeedId, id), eq(merges.intoNeedId, id)))
      .orderBy(desc(merges.createdAt), asc(merges.id)),
    db
      .select()
      .from(suggestions)
      .where(or(eq(suggestions.needId, id), eq(suggestions.relatedNeedId, id)))
      .orderBy(desc(suggestions.createdAt), desc(suggestions.id)),
  ]);

  const accountSupporters = new Map<
    string,
    { account: typeof accounts.$inferSelect; people: Set<string> }
  >();
  for (const { account, submitter } of signalRows) {
    if (!account) continue;
    const entry = accountSupporters.get(account.id) ?? { account, people: new Set<string>() };
    entry.people.add(submitter.id);
    accountSupporters.set(account.id, entry);
  }
  const weights = new Map(criteriaRows.map((row) => [row.key, row.weight]));
  const priorityScore = scoreRows.length
    ? round(scoreRows.reduce((sum, row) => sum + row.score * (weights.get(row.criterion) ?? 0), 0))
    : null;

  return {
    accounts: [...accountSupporters.values()]
      .map(({ account, people }) => ({ ...toAccount(account), supporters: people.size }))
      .toSorted((a, b) => b.arrCents - a.arrCents || a.name.localeCompare(b.name)),
    approvedAt: need.need.approvedAt?.toISOString() ?? null,
    createdAt: need.need.createdAt.toISOString(),
    decisions: decisionRows.map((row) => ({
      briefMarkdown: row.briefMarkdown,
      id: row.id,
      note: row.note,
      publishedAt: row.publishedAt.toISOString(),
      publishedByKind: row.publishedByKind,
      status: row.status,
    })),
    id: need.need.id,
    mergedIntoId: need.need.mergedIntoId,
    merges: mergeRows.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      fromNeedId: row.fromNeedId,
      id: row.id,
      intoNeedId: row.intoNeedId,
      movedSignalIds: row.movedSignalIds,
      undoneAt: row.undoneAt?.toISOString() ?? null,
    })),
    priorityScore,
    proposedSolutions: solutionRows.map((row) => ({
      id: row.id,
      sourceSignalId: row.sourceSignalId,
      text: row.text,
    })),
    publicSummary: need.need.publicSummary,
    publicSummaryStatus: need.need.publicSummaryStatus,
    scores: scoreRows.map((row) => ({
      criterion: row.criterion,
      reason: row.reason,
      score: row.score,
      source: row.source,
      updatedAt: row.updatedAt.toISOString(),
    })),
    signals: signalRows.map(({ account, signal, submitter }) => ({
      account: account ? toAccount(account) : null,
      actorKind: signal.actorKind,
      agentClient: signal.agentClient,
      attachedTo: signal.attachedTo,
      body: signal.body,
      channel: signal.channel,
      createdAt: signal.createdAt.toISOString(),
      id: signal.id,
      originalNeedId: signal.originalNeedId,
      submitter: { email: submitter.email, id: submitter.id, name: submitter.name },
      title: signal.title,
      urgency: signal.urgency,
      useCase: signal.useCase,
    })),
    statement: need.need.statement,
    status: need.need.status,
    suggestions: await toSuggestionViews(db, suggestionRows),
    supporterCount: new Set(signalRows.map((row) => row.submitter.id)).size,
    theme: need.theme?.id ? need.theme : null,
  };
};
