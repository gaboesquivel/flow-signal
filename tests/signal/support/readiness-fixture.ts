import { needs, suggestions } from "../../../lib/db/schema";
import type { SignalDb } from "../../../lib/signal/db";
import { eq } from "drizzle-orm";
import { insertAccount, insertNeed, insertSubmitter, insertTheme } from "./builders";

/**
 * Spec 007 readiness data: `big` has one $300k account (over the default $250k line), `small`
 * has two $10k supporters (under it), `decided` is over the line but already planned.
 */
export const buildReadinessFixture = async (db: SignalDb) => {
  const reporting = await insertTheme(db, { name: "Reporting" });
  const acme = await insertAccount(db, { arrCents: 30_000_000, name: "Acme" });
  const tiny = await insertAccount(db, { arrCents: 1_000_000, name: "Tiny" });
  const acmeSubmitter = await insertSubmitter(db, { accountId: acme.id });
  const tinyA = await insertSubmitter(db, { accountId: tiny.id });
  const tinyB = await insertSubmitter(db, { accountId: tiny.id });
  const big = await insertNeed(db, {
    createdAt: new Date("2026-10-01T00:00:00Z"),
    signals: [{ submitterId: acmeSubmitter.id }],
    statement: "Ops managers need to export shift reports so that payroll closes on time",
    themeId: reporting.id,
  });
  const small = await insertNeed(db, {
    createdAt: new Date("2026-10-02T00:00:00Z"),
    signals: [{ submitterId: tinyA.id }, { submitterId: tinyB.id }],
  });
  const decided = await insertNeed(db, {
    decision: { note: "Planned.", status: "planned" },
    signals: [{ submitterId: acmeSubmitter.id }],
    status: "planned",
  });
  return { acme, big, decided, reporting, small, tiny };
};
export type ReadinessFixture = Awaited<ReturnType<typeof buildReadinessFixture>>;

/** Marks a need ready at `readyAt` and optionally files a brief for it. */
export const markReady = async (
  db: SignalDb,
  needId: string,
  readyAt: Date,
  brief?: { createdAt?: Date; status?: "pending" | "accepted" | "edited" | "rejected" },
) => {
  await db.update(needs).set({ readyAt }).where(eq(needs.id, needId));
  if (!brief) return null;
  const [row] = await db
    .insert(suggestions)
    .values({
      createdAt: brief.createdAt ?? readyAt,
      kind: "decision_brief",
      model: "fake",
      needId,
      payload: {
        reason: "Strong demand.",
        recommendation: { note: "Targeting Q1", status: "planned" },
      },
      status: brief.status ?? "pending",
    })
    .returning();
  return row!;
};
