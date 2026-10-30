import { en, Faker } from "@faker-js/faker";
import { sql } from "drizzle-orm";

import { signalReasoningModelId } from "@/lib/ai/models";
import {
  accounts,
  decisions,
  events,
  merges,
  needs,
  priorityCriteria,
  priorityScores,
  proposedSolutions,
  signals,
  signalTableNames,
  submitters,
  suggestions,
  themes,
} from "@/lib/db/schema";

import type { Embedder } from "../ai/ports";
import type { SignalDb } from "../db";
import { demoAccounts, demoCriteria, demoNeeds, demoThemes } from "./demo-data";
import type { DemoNeed } from "./demo-data";

/**
 * Loads the deterministic demo workspace (spec 001 → Seed and eval): 8 accounts, 4 themes,
 * 25 needs, 150 signals over 90 days, with merges, decisions, scores, suggestions, and the
 * matching events, so every journey and metric has data. Content and ids are identical on
 * every run (fixed faker seed); dates are relative to `now`. Replaces all Signal data.
 */

const DEMO_SEED = 20_261_030;
const DAY = 86_400_000;
const PEOPLE = 72;
const PROSPECTS = 10;

type SignalRow = typeof signals.$inferInsert & { createdAt: Date; id: string };
type SuggestionRow = typeof suggestions.$inferInsert;

interface SeedOptions {
  /** Embeds need statements when given (needs Gateway access); otherwise embeddings stay null. */
  embedder?: Embedder;
  now?: Date;
}

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`Demo seed is missing ${what}`);
  return value;
};

const createRows = () => ({
  decisions: [] as (typeof decisions.$inferInsert)[],
  events: [] as (typeof events.$inferInsert)[],
  merges: [] as (typeof merges.$inferInsert)[],
  needs: [] as (typeof needs.$inferInsert)[],
  scores: [] as (typeof priorityScores.$inferInsert)[],
  signals: [] as SignalRow[],
  solutions: [] as (typeof proposedSolutions.$inferInsert)[],
  suggestions: [] as SuggestionRow[],
});

const createSeedContext = (now: Date) => {
  const faker = new Faker({ locale: [en] });
  faker.seed(DEMO_SEED);
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  return {
    daysAgo: (days: number) => new Date(anchor - days * DAY),
    faker,
    id: () => faker.string.uuid(),
    model: signalReasoningModelId(),
    rows: createRows(),
  };
};
type SeedContext = ReturnType<typeof createSeedContext>;

const buildDirectory = ({ faker, id }: SeedContext) => {
  const accountRows = demoAccounts.map((account) => ({ ...account, id: id() }));
  const themeRows = demoThemes.map((theme) => ({ ...theme, id: id() }));
  const submitterRows = Array.from({ length: PEOPLE }, (_unused, index) => {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const account =
      index >= PEOPLE - PROSPECTS ? undefined : accountRows[index % accountRows.length];
    const local = `${firstName}.${lastName}${index}`.toLowerCase().replaceAll(/[^a-z0-9.]/gu, "");
    return {
      accountId: account?.id ?? null,
      email: `${local}@${account?.domain ?? "prospect.example"}`,
      id: id(),
      name: `${firstName} ${lastName}`,
    };
  });
  return {
    accountRows,
    submitterRows,
    themeIds: new Map(themeRows.map((theme) => [theme.key, theme.id])),
    themeRows,
  };
};

const suggest = (
  { id, rows }: SeedContext,
  row: Omit<SuggestionRow, "id">,
  resolution?: { at: Date; status: "accepted" | "edited" | "rejected" },
) => {
  const suggestionId = id();
  rows.suggestions.push({
    ...row,
    id: suggestionId,
    resolvedAt: resolution?.at,
    resolvedByKind: resolution ? "human" : undefined,
    status: resolution?.status ?? "pending",
  });
  rows.events.push({
    actorKind: "agent",
    actorRef: "signal:ai",
    dedupeKey: `seed:suggestion.created:${suggestionId}`,
    needId: row.needId,
    occurredAt: row.createdAt,
    payload: { kind: row.kind },
    suggestionId,
    type: "suggestion.created",
  });
  if (resolution)
    rows.events.push({
      actorKind: "human",
      actorRef: "operator",
      dedupeKey: `seed:suggestion.${resolution.status}:${suggestionId}`,
      needId: row.needId,
      occurredAt: resolution.at,
      payload: { kind: row.kind },
      suggestionId,
      type: `suggestion.${resolution.status}`,
    });
};

const actorRefFor = (kind: "human" | "agent") => (kind === "agent" ? "mcp:support-copilot" : "web");

/** One signal per supporter, the first at the need's creation (it created the draft need). */
const buildSignals = (
  { faker, id }: SeedContext,
  need: DemoNeed,
  ids: { live: string; need: string },
  people: { id: string }[],
  createdAt: Date,
): SignalRow[] => {
  const span = Math.max(1, need.createdDaysAgo - 1) * DAY;
  const offsets = [
    0,
    ...Array.from({ length: people.length - 1 }, () =>
      faker.number.int({ max: span, min: DAY / 2 }),
    ),
  ].toSorted((a, b) => a - b);
  return people.map((person, index) => {
    const ask = required(need.asks[index % need.asks.length], `asks for ${need.key}`);
    const agent = faker.datatype.boolean({ probability: 0.2 });
    return {
      actorKind: agent ? "agent" : "human",
      agentClient: agent ? "support-copilot" : null,
      attachedTo: index === 0 ? "draft" : "existing",
      body: ask.body,
      channel: agent ? "mcp" : "web",
      createdAt: new Date(createdAt.getTime() + (offsets[index] ?? 0)),
      id: id(),
      needId: ids.live,
      originalNeedId: ids.need,
      submitterId: person.id,
      title: ask.title,
      trackingToken: faker.string.alphanumeric(32),
      urgency: faker.helpers.arrayElement(["low", "medium", "medium", "high"] as const),
      useCase: faker.datatype.boolean({ probability: 0.75 })
        ? faker.helpers.arrayElement(need.useCases)
        : null,
    };
  });
};

const recordMerge = (
  context: SeedContext,
  merge: { at: Date; from: string; into: string; signals: SignalRow[] },
) => {
  suggest(
    context,
    {
      createdAt: new Date(merge.at.getTime() - DAY),
      kind: "merge",
      model: context.model,
      needId: merge.from,
      payload: {
        intoNeedId: merge.into,
        reason: "Same underlying problem described in different words.",
      },
      relatedNeedId: merge.into,
    },
    { at: merge.at, status: "accepted" },
  );
  const mergeId = context.id();
  context.rows.merges.push({
    createdAt: merge.at,
    fromNeedId: merge.from,
    id: mergeId,
    intoNeedId: merge.into,
    movedSignalIds: merge.signals.map((signal) => signal.id),
  });
  context.rows.events.push({
    actorKind: "human",
    actorRef: "operator",
    dedupeKey: `seed:need.merged:${mergeId}`,
    needId: merge.from,
    occurredAt: merge.at,
    payload: { intoNeedId: merge.into, mergeId },
    type: "need.merged",
  });
};

const recordScores = (context: SeedContext, need: DemoNeed, needId: string, createdAt: Date) => {
  if (!need.scores) return;
  const scoredAt = new Date(createdAt.getTime() + 5 * DAY);
  for (const [criterion, score] of Object.entries(need.scores))
    context.rows.scores.push({
      criterion: criterion as keyof NonNullable<DemoNeed["scores"]>,
      needId,
      reason: `AI estimate from supporters, accounts, and theme fit (${criterion.replace("_", " ")}).`,
      score,
      source: "ai",
      updatedAt: scoredAt,
    });
  suggest(
    context,
    {
      createdAt: scoredAt,
      kind: "priority",
      model: context.model,
      needId,
      payload: { reason: "Scored against current criteria.", scores: need.scores },
    },
    { at: new Date(scoredAt.getTime() + DAY), status: "accepted" },
  );
};

const recordDecision = (context: SeedContext, need: DemoNeed, needId: string) => {
  if (!need.decision) return;
  const publishedAt = context.daysAgo(need.decision.daysAgo);
  const decisionId = context.id();
  context.rows.decisions.push({
    id: decisionId,
    needId,
    note: need.decision.note,
    publishedAt,
    publishedByKind: "human",
    status: need.decision.status,
  });
  context.rows.events.push({
    actorKind: "human",
    actorRef: "operator",
    dedupeKey: `seed:decision.published:${decisionId}`,
    needId,
    occurredAt: publishedAt,
    payload: { decisionId, status: need.decision.status },
    type: "decision.published",
  });
};

const recordSummary = (context: SeedContext, need: DemoNeed, needId: string, createdAt: Date) => {
  if (!need.publicSummary) return;
  suggest(
    context,
    {
      createdAt: new Date(createdAt.getTime() + 3 * DAY),
      kind: "public_summary",
      model: context.model,
      needId,
      payload: {
        reason: "Anonymized from supporters' use cases.",
        summary: need.publicSummary.text,
      },
    },
    need.publicSummary.status === "approved"
      ? {
          at: new Date(createdAt.getTime() + 4 * DAY),
          status: need.key === "n1" ? "edited" : "accepted",
        }
      : undefined,
  );
};

const buildNeed = (
  context: SeedContext,
  need: DemoNeed,
  directory: ReturnType<typeof buildDirectory>,
  needIds: Map<string, string>,
) => {
  const { rows } = context;
  const needId = required(needIds.get(need.key), need.key);
  const live = need.mergedInto
    ? required(needIds.get(need.mergedInto.key), need.mergedInto.key)
    : needId;
  const createdAt = context.daysAgo(need.createdDaysAgo);
  const people = context.faker.helpers.arrayElements(directory.submitterRows, need.supporters);
  const needSignals = buildSignals(context, need, { live, need: needId }, people, createdAt);
  const first = required(needSignals[0], `first signal of ${need.key}`);

  rows.signals.push(...needSignals);
  rows.needs.push({
    approvedAt: need.status === "draft" ? null : new Date(createdAt.getTime() + 2 * DAY),
    createdAt,
    id: needId,
    mergedIntoId: need.mergedInto ? live : null,
    publicSummary: need.publicSummary?.text ?? null,
    publicSummaryStatus: need.publicSummary?.status ?? "none",
    statement: need.statement,
    status: need.status,
    themeId: directory.themeIds.get(need.theme) ?? null,
  });
  rows.events.push({
    actorKind: first.actorKind,
    actorRef: actorRefFor(first.actorKind),
    dedupeKey: `seed:need.created:${needId}`,
    needId,
    occurredAt: createdAt,
    signalId: first.id,
    type: "need.created",
  });
  for (const signal of needSignals)
    rows.events.push({
      actorKind: signal.actorKind,
      actorRef: actorRefFor(signal.actorKind),
      dedupeKey: `seed:signal.created:${signal.id}`,
      needId,
      occurredAt: signal.createdAt,
      payload: { attachedTo: signal.attachedTo, hasUseCase: signal.useCase !== null },
      signalId: signal.id,
      type: "signal.created",
    });
  for (const text of need.solutions)
    rows.solutions.push({ id: context.id(), needId: live, sourceSignalId: first.id, text });

  if (need.status === "draft")
    suggest(context, {
      createdAt: new Date(createdAt.getTime() + 60_000),
      kind: "draft_need",
      model: context.model,
      needId,
      payload: {
        reason: "New submission with no match above the threshold.",
        statement: need.statement,
      },
      signalIds: [first.id],
    });
  if (need.mergedInto)
    recordMerge(context, {
      at: context.daysAgo(need.mergedInto.daysAgo),
      from: needId,
      into: live,
      signals: needSignals,
    });
  recordSummary(context, need, needId, createdAt);
  recordScores(context, need, needId, createdAt);
  recordDecision(context, need, needId);
};

export const seedDemoWorkspace = async (
  db: SignalDb,
  { embedder, now = new Date() }: SeedOptions = {},
) => {
  const context = createSeedContext(now);
  const { rows } = context;
  const directory = buildDirectory(context);
  const needIds = new Map(demoNeeds.map((need) => [need.key, context.id()]));
  for (const need of demoNeeds) buildNeed(context, need, directory, needIds);

  // A PM rejected merging N2 into N1: same solution ("PDF export"), different need.
  suggest(
    context,
    {
      createdAt: context.daysAgo(50),
      kind: "merge",
      model: context.model,
      needId: needIds.get("n2"),
      payload: { intoNeedId: needIds.get("n1"), reason: "Both ask for PDF export." },
      relatedNeedId: needIds.get("n1"),
    },
    { at: context.daysAgo(49), status: "rejected" },
  );
  suggest(context, {
    createdAt: context.daysAgo(8),
    kind: "theme",
    model: context.model,
    needId: needIds.get("embed"),
    payload: {
      reason: "Embedding is an integration surface.",
      themeId: directory.themeIds.get("integrations"),
    },
    themeId: directory.themeIds.get("integrations"),
  });

  // Each published decision followed an accepted decision brief (decision latency and
  // suggestion acceptance both have recent history). Added last so earlier ids stay stable.
  for (const need of demoNeeds) {
    if (!need.decision) continue;
    const publishedAt = context.daysAgo(need.decision.daysAgo);
    suggest(
      context,
      {
        createdAt: new Date(publishedAt.getTime() - DAY),
        kind: "decision_brief",
        model: context.model,
        needId: needIds.get(need.key),
        payload: {
          reason: "Requested before publishing a decision.",
          status: need.decision.status,
        },
      },
      { at: new Date(publishedAt.getTime() - DAY / 4), status: "accepted" },
    );
  }

  if (embedder) {
    const vectors = await embedder.embed(rows.needs.map((row) => row.statement));
    for (const [index, row] of rows.needs.entries()) row.embedding = vectors[index];
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`TRUNCATE TABLE ${signalTableNames.join(", ")} RESTART IDENTITY CASCADE`),
    );
    await tx.insert(accounts).values(directory.accountRows);
    await tx.insert(themes).values(directory.themeRows);
    await tx.insert(submitters).values(directory.submitterRows);
    await tx.insert(needs).values(rows.needs);
    await tx.insert(signals).values(rows.signals);
    await tx.insert(proposedSolutions).values(rows.solutions);
    await tx.insert(merges).values(rows.merges);
    await tx.insert(priorityCriteria).values(demoCriteria.map((criterion) => ({ ...criterion })));
    await tx.insert(priorityScores).values(rows.scores);
    await tx.insert(suggestions).values(rows.suggestions);
    await tx.insert(decisions).values(rows.decisions);
    await tx.insert(events).values(rows.events);
  });

  return {
    accounts: directory.accountRows.length,
    embedded: Boolean(embedder),
    events: rows.events.length,
    needIds: Object.fromEntries(needIds),
    needs: rows.needs.length,
    signals: rows.signals.length,
    submitters: directory.submitterRows.length,
    suggestions: rows.suggestions.length,
    themes: directory.themeRows.length,
  };
};
