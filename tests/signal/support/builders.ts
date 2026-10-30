import { randomUUID } from "node:crypto";

import {
  accounts,
  decisions,
  needs,
  priorityCriteria,
  priorityScores,
  proposedSolutions,
  signals,
  submitters,
  themes,
} from "../../../lib/db/schema";
import type { SignalDb } from "../../../lib/signal/db";

/**
 * Small insert helpers for tests: each returns the inserted row(s) with sensible defaults.
 * Prefer these over the demo seed so each test states the data it depends on.
 */

let counter = 0;
const nextNumber = () => {
  counter += 1;
  return counter;
};

export const insertAccount = async (
  db: SignalDb,
  values: Partial<typeof accounts.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(accounts)
    .values({ arrCents: 0, name: `Account ${nextNumber()}`, plan: "Growth", ...values })
    .returning();
  return row!;
};

export const insertSubmitter = async (
  db: SignalDb,
  values: Partial<typeof submitters.$inferInsert> = {},
) => {
  const n = nextNumber();
  const [row] = await db
    .insert(submitters)
    .values({ email: `person${n}@example.test`, name: `Person ${n}`, ...values })
    .returning();
  return row!;
};

export const insertTheme = async (
  db: SignalDb,
  values: Partial<typeof themes.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(themes)
    .values({ name: `Theme ${nextNumber()}`, ...values })
    .returning();
  return row!;
};

export interface NeedSpec extends Partial<typeof needs.$inferInsert> {
  decision?: {
    note: string;
    publishedAt?: Date;
    status: "planned" | "in_progress" | "shipped" | "declined";
  };
  /** Priority scores per criterion (0–5); criteria rows must exist (`insertCriteria`). */
  scores?: Partial<Record<"demand" | "business_value" | "strategic_fit" | "effort", number>>;
  solutions?: string[];
  /** Signals to attach, one per new submitter unless `submitterId` is given. */
  signals?: Partial<typeof signals.$inferInsert>[];
}

export const insertNeed = async (db: SignalDb, spec: NeedSpec = {}) => {
  const { decision, scores, signals: signalSpecs = [], solutions = [], ...values } = spec;
  const [need] = await db
    .insert(needs)
    .values({
      statement: `Someone needs thing ${nextNumber()} so that outcome`,
      status: "open",
      ...values,
    })
    .returning();
  const created = [];
  for (const signal of signalSpecs) {
    const submitterId = signal.submitterId ?? (await insertSubmitter(db)).id;
    const [row] = await db
      .insert(signals)
      .values({
        actorKind: "human",
        attachedTo: "existing",
        body: `Verbatim body ${nextNumber()}`,
        channel: "web",
        needId: need!.id,
        originalNeedId: need!.id,
        submitterId,
        title: `Verbatim title ${nextNumber()}`,
        trackingToken: randomUUID(),
        ...signal,
      })
      .returning();
    created.push(row!);
  }
  if (solutions.length)
    await db
      .insert(proposedSolutions)
      .values(solutions.map((text) => ({ needId: need!.id, text })));
  if (decision)
    await db.insert(decisions).values({
      needId: need!.id,
      note: decision.note,
      publishedAt: decision.publishedAt ?? new Date(),
      publishedByKind: "human",
      status: decision.status,
    });
  if (scores)
    await db.insert(priorityScores).values(
      Object.entries(scores).map(([criterion, score]) => ({
        criterion: criterion as "demand",
        needId: need!.id,
        reason: "test",
        score,
        source: "ai" as const,
      })),
    );
  return { need: need!, signals: created };
};

/** The default criteria with weights summing to 1. */
export const insertCriteria = (db: SignalDb) =>
  db.insert(priorityCriteria).values([
    { key: "demand", weight: 0.4 },
    { key: "business_value", weight: 0.3 },
    { key: "strategic_fit", weight: 0.2 },
    { key: "effort", weight: 0.1 },
  ]);

/** `count` signals from distinct new submitters. */
export const supporters = (count: number) => Array.from({ length: count }, () => ({}));
