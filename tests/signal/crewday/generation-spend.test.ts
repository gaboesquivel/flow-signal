import { randomUUID } from "node:crypto";

import { beforeEach, expect, it } from "vitest";

import { createAiMeter, meterAi } from "@/evals/crewday/sim/meter";
import { signals, suggestions } from "@/lib/db/schema";
import { createFakeAi, fakeReasoner } from "@/lib/signal/ai/fakes";
import {
  generateSuggestionsForSignal,
  onNeedCadence,
} from "@/lib/signal/domain/suggestion-generation";

import { insertNeed, insertSubmitter, insertTheme } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

// Spend guardrail (PRODUCT.md: under $0.01 per signal). A fixture smoke run measured $0.014,
// about half of it suggestion generation re-proposing every need-level kind on every signal.
// This replays signals arriving one by one on an existing need, with the PM rejecting whatever
// was proposed, and counts reasoner calls with the Crewday meter.

const SIGNALS = 20;
const start = Date.parse("2026-03-02T09:00:00Z");

const reasoner = fakeReasoner({
  priority: () => ({
    business_value: { reason: "r", score: 3 },
    demand: { reason: "r", score: 3 },
    effort: { reason: "r", score: 3 },
    strategic_fit: { reason: "r", score: 3 },
    summary: "s",
  }),
  public_summary: () => ({ reason: "r", summary: "Teams swap shifts without calling a manager." }),
  split: () => ({ reason: "r", split: null }),
});

describeWithDatabase("suggestion generation spend", () => {
  const harness = useTestDatabase();
  beforeEach(() => resetDatabase(harness.db));

  it("runs need-level kinds on a cadence, not on every signal", async () => {
    const theme = await insertTheme(harness.db, { name: "Scheduling" });
    const { need } = await insertNeed(harness.db, {
      statement: "Shift workers need to swap shifts so that coverage holds",
      themeId: theme.id,
    });
    const meter = createAiMeter();
    meter.setPhase("generation");
    const ai = meterAi(createFakeAi({ reasoner }), meter);

    const perSignal: number[] = [];
    for (let n = 1; n <= SIGNALS; n += 1) {
      const at = new Date(start + n * 60_000);
      const submitter = await insertSubmitter(harness.db);
      const [signal] = await harness.db
        .insert(signals)
        .values({
          actorKind: "human",
          attachedTo: "existing",
          body: `Swap request ${n}`,
          channel: "web",
          createdAt: at,
          needId: need.id,
          originalNeedId: need.id,
          submitterId: submitter.id,
          title: `Shift swaps ${n}`,
          trackingToken: randomUUID(),
          useCase: `Store ${n} covers weekend shifts.`,
        })
        .returning();
      const before = meter.count({ port: "reasoner" });
      await generateSuggestionsForSignal(
        { ai, clock: { now: () => new Date(at.getTime() + 30_000) }, db: harness.db },
        { signalId: signal!.id },
      );
      perSignal.push(meter.count({ port: "reasoner" }) - before);
      // The PM rejects everything, so nothing stays pending to suppress the next proposal.
      await harness.db.update(suggestions).set({ status: "rejected" });
    }

    // Before: priority and public_summary on every signal, split from the second.
    const everySignal = Array.from({ length: SIGNALS }, (_, i) => 2 + (i >= 1 ? 1 : 0));
    const expected = everySignal.map((calls, i) => (onNeedCadence(i + 1) ? calls : 0));
    expect(perSignal).toEqual(expected);

    const total = perSignal.reduce((sum, calls) => sum + calls, 0);
    const before = everySignal.reduce((sum, calls) => sum + calls, 0);
    expect(before).toBe(59);
    expect(total).toBe(17);
    // Over 70% fewer generation model calls on a need's long tail.
    expect(total / before).toBeLessThan(0.3);
  });
});
