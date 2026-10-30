import { asc, eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";

import { events } from "../../../lib/db/schema";
import { createFakeAi } from "../../../lib/signal/ai/fakes";
import type { Actor } from "../../../lib/signal/context";
import { publishDecision } from "../../../lib/signal/domain/decisions";
import { mergeNeeds } from "../../../lib/signal/domain/merges";
import { getMySignals } from "../../../lib/signal/domain/my-signals";
import { submitSignal } from "../../../lib/signal/domain/submissions";
import type { SubmitInput } from "../../../lib/signal/domain/submissions";
import { computeMetrics } from "../../../lib/signal/metrics";
import { insertNeed } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

/**
 * Close-the-loop rate: reading a My signals link records `signal.decision_seen` once per signal
 * and decision published after the signal, and `get_metrics` divides the signals whose holder
 * saw a decision by the signals on needs with that decision.
 */

const human: Actor = { kind: "human", ref: "web" };
const operator: Actor = { kind: "human", ref: "operator" };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 12, minute));
const window = { from: new Date("2026-10-26T00:00:00Z"), to: new Date("2026-10-30T09:00:00Z") };

describeWithDatabase("decision seen on My signals", () => {
  const harness = useTestDatabase();
  let key = 0;
  beforeEach(async () => {
    key = 0;
    await resetDatabase(harness.db);
  });

  const submit = async (target: SubmitInput["target"], minute: number) => {
    key += 1;
    const result = await submitSignal(
      { actor: human, ai: createFakeAi(), clock: { now: () => at(minute) }, db: harness.db },
      {
        body: `Body ${key}`,
        email: `person${key}@acme.example`,
        idempotencyKey: `key-${String(key).padStart(4, "0")}`,
        target,
        title: `Title ${key}`,
      },
    );
    return { ...result, token: result.trackingUrl.split("/my/")[1]! };
  };

  const publish = (needId: string, minute: number, status: "planned" | "shipped" = "planned") =>
    publishDecision(
      { actor: operator, db: harness.db, now: at(minute) },
      { needId, note: `Decided at ${minute}`, status },
    );

  const read = (token: string, minute: number) =>
    getMySignals(harness.db, token, { actor: human, now: at(minute) });

  const seenEvents = () =>
    harness.db
      .select()
      .from(events)
      .where(eq(events.type, "signal.decision_seen"))
      .orderBy(asc(events.occurredAt));

  it("records a decision the holder sees once, however often they look", async () => {
    const { need } = await insertNeed(harness.db, { createdAt: at(0) });
    const signal = await submit({ needId: need.id }, 1);
    // nothing to see yet
    await read(signal.token, 2);
    expect(await seenEvents()).toEqual([]);

    const decision = await publish(need.id, 3);
    await read(signal.token, 4);
    await read(signal.token, 5);

    const seen = await seenEvents();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      actorKind: "human",
      dedupeKey: `signal.decision_seen:${signal.signalId}:${decision.id}`,
      needId: need.id,
      occurredAt: at(4),
      payload: { decisionId: decision.id, status: "planned" },
      signalId: signal.signalId,
    });
  });

  it("records a later decision on the same need again", async () => {
    const { need } = await insertNeed(harness.db, { createdAt: at(0) });
    const signal = await submit({ needId: need.id }, 1);
    await publish(need.id, 2);
    await read(signal.token, 3);
    await publish(need.id, 4, "shipped");
    await read(signal.token, 5);

    expect((await seenEvents()).map((event) => event.payload.status)).toEqual([
      "planned",
      "shipped",
    ]);
  });

  it("does not record decisions published before the signal", async () => {
    const { need } = await insertNeed(harness.db, { createdAt: at(0) });
    await publish(need.id, 1);
    const late = await submit({ needId: need.id }, 2);
    const result = await read(late.token, 3);

    expect(result?.signals[0]?.decisions).toHaveLength(1);
    expect(await seenEvents()).toEqual([]);
  });

  it("records a decision on the need a duplicate was merged into", async () => {
    const { need } = await insertNeed(harness.db, { createdAt: at(0) });
    const draft = await submit(
      { newNeed: { statement: "Admins need exports so that audits pass" } },
      1,
    );
    await harness.db.transaction((tx) =>
      mergeNeeds(tx, {
        actor: operator,
        fromNeedId: draft.needId,
        intoNeedId: need.id,
        now: at(2),
      }),
    );
    const decision = await publish(need.id, 3);
    await read(draft.token, 4);

    expect(await seenEvents()).toMatchObject([
      { needId: need.id, payload: { decisionId: decision.id }, signalId: draft.signalId },
    ]);
  });

  it("still returns the link when recording fails", async () => {
    const { need } = await insertNeed(harness.db, { createdAt: at(0) });
    const signal = await submit({ needId: need.id }, 1);
    await publish(need.id, 2);
    const insert = vi.spyOn(harness.db, "insert").mockImplementation(() => {
      throw new Error("database hiccup");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => null);
    try {
      const result = await read(signal.token, 3);
      expect(result?.signals.map((row) => row.signalId)).toEqual([signal.signalId]);
      expect(error).toHaveBeenCalledOnce();
    } finally {
      insert.mockRestore();
      error.mockRestore();
    }
    expect(await seenEvents()).toEqual([]);
  });

  it("feeds close-the-loop rate: holders who saw it ÷ signals on the decided need", async () => {
    const { need } = await insertNeed(harness.db, { createdAt: at(0) });
    const maya = await submit({ needId: need.id }, 1);
    await submit({ needId: need.id }, 2);
    await publish(need.id, 3);
    // filed after the decision: not in the denominator
    const late = await submit({ needId: need.id }, 4);
    await read(maya.token, 5);
    await read(late.token, 6);

    const { closeTheLoopRate } = await computeMetrics(harness.db, window);
    expect(closeTheLoopRate).toEqual({ decidedSignals: 2, rate: 0.5, seen: 1 });
  });
});
