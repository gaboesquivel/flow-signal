import { eq } from "drizzle-orm";

import { accounts, decisions, needs, signals, submitters, suggestions } from "@/lib/db/schema";
import type { Embedder } from "@/lib/signal/ai/ports";
import type { SignalDb } from "@/lib/signal/db";
import { seedDemoWorkspace } from "@/lib/signal/seed/demo-workspace";

/**
 * The seeded demo workspace (lib/signal/seed) every scenario starts from, plus the lookups the
 * checks need: need ids by seed key (n1, n2, embed, ...), pending suggestions, and the private
 * data no public reply may contain. Reseeded before each scenario, so scenarios are independent.
 */

export interface PendingSuggestion {
  id: string;
  kind: string;
  needKey: string | undefined;
}

export interface Fixture {
  accountNames: string[];
  db: SignalDb;
  needIds: Record<string, string>;
  pending: PendingSuggestion[];
  submitterEmails: string[];
}

export const seedFixture = async (db: SignalDb, embedder?: Embedder): Promise<Fixture> => {
  const summary = await seedDemoWorkspace(db, { embedder });
  const needIds = summary.needIds as Record<string, string>;
  const keyOf = new Map(Object.entries(needIds).map(([key, id]) => [id, key]));
  const pending = await db
    .select({ id: suggestions.id, kind: suggestions.kind, needId: suggestions.needId })
    .from(suggestions)
    .where(eq(suggestions.status, "pending"));
  const accountRows = await db.select({ name: accounts.name }).from(accounts);
  const submitterRows = await db.select({ email: submitters.email }).from(submitters);
  return {
    accountNames: accountRows.map((row) => row.name),
    db,
    needIds,
    pending: pending.map((row) => ({
      id: row.id,
      kind: row.kind,
      needKey: row.needId ? keyOf.get(row.needId) : undefined,
    })),
    submitterEmails: submitterRows.map((row) => row.email),
  };
};

export const needId = (fixture: Fixture, key: string) => {
  const id = fixture.needIds[key];
  if (!id) throw new Error(`Seed has no need ${key}`);
  return id;
};

export const pendingSuggestion = (fixture: Fixture, kind: string, needKey: string) => {
  const found = fixture.pending.find((item) => item.kind === kind && item.needKey === needKey);
  if (!found) throw new Error(`Seed has no pending ${kind} suggestion for ${needKey}`);
  return found.id;
};

// ---- Database state for checks ----

export const signalsByEmail = (db: SignalDb, email: string) =>
  db
    .select({ needId: signals.needId, title: signals.title, urgency: signals.urgency })
    .from(signals)
    .innerJoin(submitters, eq(signals.submitterId, submitters.id))
    .where(eq(submitters.email, email.toLowerCase()));

export const needRow = async (db: SignalDb, id: string) => {
  const [row] = await db
    .select({ statement: needs.statement, status: needs.status })
    .from(needs)
    .where(eq(needs.id, id));
  return row;
};

export const decisionsFor = (db: SignalDb, id: string) =>
  db
    .select({
      note: decisions.note,
      publishedByKind: decisions.publishedByKind,
      status: decisions.status,
    })
    .from(decisions)
    .where(eq(decisions.needId, id));

export const suggestionStatus = async (db: SignalDb, id: string) => {
  const [row] = await db
    .select({ status: suggestions.status })
    .from(suggestions)
    .where(eq(suggestions.id, id));
  return row?.status;
};
