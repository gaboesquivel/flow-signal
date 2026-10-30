import { count, eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";

import type { themes } from "../../../lib/db/schema";
import {
  decisions,
  events,
  merges,
  needs,
  signals,
  submitters,
  suggestions,
} from "../../../lib/db/schema";
import { getPublicNeed, searchPublicNeeds } from "../../../lib/signal/domain/public-needs";
import { seedDemoWorkspace } from "../../../lib/signal/seed/demo-workspace";
import { describeWithDatabase, useTestDatabase } from "../support/database";

const now = new Date("2026-10-30T09:00:00Z");

describeWithDatabase("demo seed", () => {
  const harness = useTestDatabase();
  let summary: Awaited<ReturnType<typeof seedDemoWorkspace>>;

  beforeAll(async () => {
    summary = await seedDemoWorkspace(harness.db, { now });
  });

  it("loads 8 accounts, 4 themes, about 25 needs and about 150 signals", async () => {
    expect(summary).toMatchObject({ accounts: 8, needs: 25, signals: 150, themes: 4 });
    const [signalCount] = await harness.db.select({ value: count() }).from(signals);
    expect(signalCount?.value).toBe(150);
    const oldest = await harness.db
      .select({ createdAt: signals.createdAt })
      .from(signals)
      .orderBy(signals.createdAt)
      .limit(1);
    expect(now.getTime() - oldest[0]!.createdAt.getTime()).toBeLessThanOrEqual(91 * 86_400_000);
  });

  it("includes the acceptance scenario's N1 and N2", async () => {
    const n1 = await getPublicNeed(harness.db, summary.needIds.n1!);
    expect(n1).toMatchObject({
      proposedSolutions: expect.arrayContaining(["PDF export"]),
      statement:
        "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
      status: "open",
      supporterCount: 11,
      theme: { name: "Reporting" },
    });
    const n2 = await getPublicNeed(harness.db, summary.needIds.n2!);
    expect(n2).toMatchObject({
      proposedSolutions: expect.arrayContaining(["PDF export"]),
      statement:
        "Compliance teams need to archive monthly reports so that audits have a fixed record",
    });
    const maya = await harness.db
      .select()
      .from(submitters)
      .where(eq(submitters.email, "maya@acme.example"));
    expect(maya).toHaveLength(0);
  });

  it("has history for every journey and metric", async () => {
    const counts = async (
      table: typeof merges | typeof decisions | typeof suggestions | typeof themes,
    ) => (await harness.db.select({ value: count() }).from(table))[0]!.value;
    expect(await counts(merges)).toBe(2);
    expect(await counts(decisions)).toBe(5);
    const types = await harness.db.selectDistinct({ type: events.type }).from(events);
    expect(types.map(({ type }) => type).toSorted()).toEqual([
      "decision.published",
      "need.created",
      "need.merged",
      "signal.created",
      "suggestion.accepted",
      "suggestion.created",
      "suggestion.edited",
      "suggestion.rejected",
    ]);
    const pending = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.status, "pending"));
    expect(pending.length).toBeGreaterThan(0);
    const agentSignals = await harness.db
      .select()
      .from(signals)
      .where(eq(signals.actorKind, "agent"));
    expect(agentSignals.length).toBeGreaterThan(0);
    const merged = await harness.db.select().from(needs).where(eq(needs.status, "merged"));
    expect(merged.every((need) => need.mergedIntoId)).toBe(true);
  });

  it("is deterministic", async () => {
    const before = await harness.db
      .select({ id: signals.id, title: signals.title })
      .from(signals)
      .orderBy(signals.id);
    const again = await seedDemoWorkspace(harness.db, { now });
    expect(again.needIds).toEqual(summary.needIds);
    const after = await harness.db
      .select({ id: signals.id, title: signals.title })
      .from(signals)
      .orderBy(signals.id);
    expect(after).toEqual(before);
  });

  it("serves the board from seeded data", async () => {
    const page = await searchPublicNeeds(harness.db, { limit: 50, offset: 0, q: "pdf" });
    expect(page.needs.map((need) => need.id)).toEqual(
      expect.arrayContaining([summary.needIds.n1, summary.needIds.n2]),
    );
  });
});
