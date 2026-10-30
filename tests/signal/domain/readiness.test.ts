import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import { events, needs, signals, strategies, suggestions } from "../../../lib/db/schema";
import { createUnavailableAi } from "../../../lib/signal/ai/fakes";
import type { SignalAi } from "../../../lib/signal/ai/ports";
import {
  checkReadiness,
  configureAutoBriefs,
  resetAutoBriefs,
} from "../../../lib/signal/domain/readiness";
import { getStrategy, setStrategy, strategyInputSchema } from "../../../lib/signal/domain/strategy";
import { generateSuggestionsForSignal } from "../../../lib/signal/domain/suggestion-generation";
import { executeOperation } from "../../../lib/signal/operations/execute";
import { mergeNeeds } from "../../../lib/signal/operations/merge-needs";
import { setStrategy as setStrategyOperation } from "../../../lib/signal/operations/set-strategy";
import { undoMerge } from "../../../lib/signal/operations/undo-merge";
import { insertAccount, insertNeed, insertSubmitter } from "../support/builders";
import {
  describeWithDatabase,
  resetDatabase,
  scheduledGenerations,
  useTestDatabase,
} from "../support/database";
import { fakeReasoningAi } from "../support/prioritization-fixture";
import { buildReadinessFixture, markReady } from "../support/readiness-fixture";
import type { ReadinessFixture } from "../support/readiness-fixture";

const NOW = new Date("2026-10-30T09:00:00Z");
const clock = { now: () => NOW };
const pm = { kind: "human" as const, ref: "operator" };
const strategyInput = {
  capacityPerQuarter: 3,
  focusThemeIds: [] as string[],
  readinessArrCents: 25_000_000,
  readinessSupporters: 5,
  revenueFocus: "mid-market retention",
};

describeWithDatabase("strategy and readiness (spec 007)", () => {
  const harness = useTestDatabase();
  let f: ReadinessFixture;
  let scheduled: (() => Promise<unknown>)[];
  const deps = (ai: SignalAi = fakeReasoningAi()) => ({
    ai,
    clock,
    db: harness.db,
    schedule: (task: () => Promise<unknown>) => {
      scheduled.push(task);
    },
  });
  const runScheduled = async () => {
    const tasks = scheduled.splice(0);
    for (const task of tasks) await task();
  };
  const readyEvents = (needId: string) =>
    harness.db
      .select()
      .from(events)
      .where(and(eq(events.type, "need.ready"), eq(events.needId, needId)));
  const briefs = (needId: string) =>
    harness.db
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.kind, "decision_brief"), eq(suggestions.needId, needId)));
  const readyAt = async (needId: string) =>
    (await harness.db.select().from(needs).where(eq(needs.id, needId)))[0]?.readyAt ?? null;
  const addSignal = async (needId: string, accountId: string) => {
    const submitter = await insertSubmitter(harness.db, { accountId });
    const [row] = await harness.db
      .insert(signals)
      .values({
        actorKind: "human",
        attachedTo: "existing",
        body: "We need this too.",
        channel: "web",
        needId,
        originalNeedId: needId,
        submitterId: submitter.id,
        title: "Me too",
        trackingToken: randomUUID(),
      })
      .returning();
    return row!;
  };

  beforeEach(async () => {
    await resetDatabase(harness.db);
    scheduled = [];
    scheduledGenerations.length = 0;
    f = await buildReadinessFixture(harness.db);
  });

  it("versions the strategy and validates themes and the readiness line", async () => {
    expect(await getStrategy(harness.db)).toBeNull();
    const first = await setStrategy(harness.db, pm, strategyInput, NOW);
    const second = await setStrategy(
      harness.db,
      pm,
      { ...strategyInput, focusThemeIds: [f.reporting.id, f.reporting.id] },
      NOW,
    );
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(await getStrategy(harness.db)).toMatchObject({
      focusThemes: [{ id: f.reporting.id, name: "Reporting" }],
      version: 2,
    });
    expect(await harness.db.select().from(strategies)).toHaveLength(2);
    await expect(
      setStrategy(harness.db, pm, { ...strategyInput, focusThemeIds: [randomUUID()] }, NOW),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(
      strategyInputSchema.safeParse({ ...strategyInput, capacityPerQuarter: -1 }).success,
    ).toBe(false);
    expect(
      strategyInputSchema.safeParse({
        ...strategyInput,
        readinessArrCents: 0,
        readinessSupporters: 0,
      }).success,
    ).toBe(false);
  });

  it("marks a need ready once, with demand and strategy version, and schedules one brief", async () => {
    await setStrategy(harness.db, pm, strategyInput, NOW);
    expect(await checkReadiness(deps())).toEqual([f.big.need.id]);
    expect(await checkReadiness(deps())).toEqual([]);
    expect(await readyAt(f.big.need.id)).toEqual(NOW);
    expect(await readyAt(f.small.need.id)).toBeNull();
    expect(await readyAt(f.decided.need.id)).toBeNull();
    const ready = await readyEvents(f.big.need.id);
    expect(ready).toMatchObject([
      {
        actorKind: "agent",
        actorRef: "signal:ai",
        dedupeKey: `need.ready:${f.big.need.id}`,
        payload: { arrCents: 30_000_000, strategyVersion: 1, supporters: 1 },
      },
    ]);
    // Both checks saw no brief yet; the second task finds the first one's brief and skips.
    expect(scheduled).toHaveLength(2);
    await runScheduled();
    expect(await briefs(f.big.need.id)).toMatchObject([{ status: "pending" }]);
    // A pending brief is never duplicated by later checks.
    await checkReadiness(deps());
    expect(scheduled).toHaveLength(0);
  });

  it("records readiness but drafts no brief while auto briefs are off (Crewday oracle runs)", async () => {
    await setStrategy(harness.db, pm, strategyInput, NOW);
    configureAutoBriefs(false);
    try {
      expect(await checkReadiness(deps())).toEqual([f.big.need.id]);
      expect(await readyEvents(f.big.need.id)).toHaveLength(1);
      expect(scheduled).toHaveLength(0);
    } finally {
      resetAutoBriefs();
    }
    await checkReadiness(deps());
    expect(scheduled).toHaveLength(1);
  });

  it("marks the need ready when a signal lands (suggestion generation)", async () => {
    const signal = await addSignal(f.small.need.id, f.acme.id);
    await generateSuggestionsForSignal(
      { ai: fakeReasoningAi(), clock, db: harness.db },
      { signalId: signal.id },
    );
    expect(await readyEvents(f.small.need.id)).toMatchObject([
      { payload: { arrCents: 31_000_000, strategyVersion: null, supporters: 3 } },
    ]);
    // The brief is scheduled off the hot path through the suggestion scheduler.
    expect(scheduledGenerations).toHaveLength(1);
    await scheduledGenerations[0]!();
    expect(await briefs(f.small.need.id)).toHaveLength(1);
    // A second signal: no second event, no second brief.
    const again = await addSignal(f.small.need.id, f.acme.id);
    await generateSuggestionsForSignal(
      { ai: fakeReasoningAi(), clock, db: harness.db },
      { signalId: again.id },
    );
    expect(await readyEvents(f.small.need.id)).toHaveLength(1);
    expect(scheduledGenerations).toHaveLength(1);
  });

  it("skips the auto brief when one is pending, and does not redraft a resolved one", async () => {
    await markReady(harness.db, f.small.need.id, NOW, { status: "pending" });
    await markReady(harness.db, f.big.need.id, NOW, { status: "rejected" });
    await checkReadiness(deps());
    expect(scheduled).toEqual([]);
  });

  it("retries the brief on the next trigger after ai_unavailable", async () => {
    expect(await checkReadiness(deps(createUnavailableAi()))).toEqual([f.big.need.id]);
    await runScheduled();
    expect(await readyEvents(f.big.need.id)).toHaveLength(1);
    expect(await briefs(f.big.need.id)).toEqual([]);
    expect(await checkReadiness(deps())).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await runScheduled();
    expect(await briefs(f.big.need.id)).toHaveLength(1);
  });

  it("moves readiness to the surviving need on merge, and rechecks after undo", async () => {
    // small (two Tiny supporters, $10k) merged into a need with one $240k supporter: $250k.
    const initech = await insertAccount(harness.db, { arrCents: 24_000_000, name: "Initech" });
    const { need: target } = await insertNeed(harness.db);
    const targetId = target.id;
    await addSignal(targetId, initech.id);
    expect(await checkReadiness(deps(), [targetId, f.small.need.id])).toEqual([]);

    const merged = await executeOperation(
      mergeNeeds,
      { id: f.small.need.id, intoNeedId: targetId },
      pm,
    );
    expect(merged.ok).toBe(true);
    expect(scheduledGenerations).toHaveLength(1);
    await scheduledGenerations[0]!();
    expect(await readyEvents(targetId)).toMatchObject([
      { payload: { arrCents: 25_000_000, supporters: 3 } },
    ]);
    expect(await readyEvents(f.small.need.id)).toEqual([]);

    const mergeId = merged.ok ? (merged.data as { mergeId: string }).mergeId : "";
    scheduledGenerations.length = 0;
    expect((await executeOperation(undoMerge, { id: mergeId }, pm)).ok).toBe(true);
    // Readiness is checked again for both needs after the undo; neither is newly ready.
    expect(scheduledGenerations).toHaveLength(1);
    await scheduledGenerations[0]!();
    expect(await readyEvents(targetId)).toHaveLength(1);
    expect(await readyAt(f.small.need.id)).toBeNull();
  });

  it("set_strategy rechecks every live need and reports newlyReady", async () => {
    const first = await executeOperation(setStrategyOperation, strategyInput, pm);
    expect(first).toMatchObject({ data: { newlyReady: 1, strategy: { version: 1 } }, ok: true });
    const lower = await executeOperation(
      setStrategyOperation,
      { ...strategyInput, readinessSupporters: 2 },
      pm,
    );
    expect(lower).toMatchObject({ data: { newlyReady: 1, strategy: { version: 2 } }, ok: true });
    expect(await readyEvents(f.small.need.id)).toMatchObject([
      { payload: { strategyVersion: 2, supporters: 2 } },
    ]);
    expect(await readyAt(f.decided.need.id)).toBeNull();
  });
});
