import { randomUUID } from "node:crypto";

import { beforeEach, expect, it } from "vitest";

import { assistantActions } from "../../../lib/db/schema";
import type { Actor } from "../../../lib/signal/context";
import {
  ACTION_TTL_MS,
  assistantAgentActor,
  assistantConfirmActor,
} from "../../../lib/signal/domain/assistant-actions";
import { recordEvent } from "../../../lib/signal/events";
import type { SignalEvent } from "../../../lib/signal/events";
import { computeMetrics, DAY_MS } from "../../../lib/signal/metrics";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

// spec 014 → Metric: assistant action share
const now = new Date("2026-10-30T09:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const window = { from: new Date(now.getTime() - 7 * DAY_MS), to: now };

const pm: Actor = { client: "console", kind: "human", ref: "web" };
const agent: Actor = { client: "support-copilot", kind: "agent", ref: "mcp:support-copilot" };

describeWithDatabase("assistant action share (spec 014)", () => {
  const harness = useTestDatabase();
  beforeEach(() => resetDatabase(harness.db));
  const record = (event: SignalEvent) => recordEvent(harness.db, event);
  const share = async () => (await computeMetrics(harness.db, window, now)).assistantActions;

  /** An `assistant.action_proposed` event, and its stored row unless `row` is false. */
  const propose = async (
    at: Date,
    options: { expiresAt?: Date; row?: boolean; status?: "failed" } = {},
  ) => {
    const actionId = randomUUID();
    if (options.row !== false)
      await harness.db.insert(assistantActions).values({
        expiresAt: options.expiresAt ?? new Date(at.getTime() + ACTION_TTL_MS),
        fingerprint: "fp",
        id: actionId,
        input: {},
        operation: "merge_needs",
        preview: {},
        status: options.status ?? "proposed",
      });
    await record({
      actor: assistantAgentActor,
      dedupeKey: `assistant.action_proposed:${actionId}`,
      occurredAt: at,
      payload: { actionId, operation: "merge_needs" },
      type: "assistant.action_proposed",
    });
    return actionId;
  };

  /** A confirm as the confirm route records it: the write's event plus `action_confirmed`. */
  const confirm = async (actionId: string, edited: boolean, at = minutesAgo(50)) => {
    await record({
      actor: assistantConfirmActor,
      dedupeKey: `assistant.write:${actionId}`,
      needId: randomUUID(),
      occurredAt: at,
      payload: { intoNeedId: randomUUID(), mergeId: randomUUID() },
      type: "need.merged",
    });
    await record({
      actor: assistantConfirmActor,
      dedupeKey: `assistant.action_confirmed:${actionId}`,
      occurredAt: at,
      payload: { actionId, edited, operation: "merge_needs" },
      type: "assistant.action_confirmed",
    });
  };

  const reject = (actionId: string) =>
    record({
      actor: assistantConfirmActor,
      dedupeKey: `assistant.action_rejected:${actionId}`,
      occurredAt: minutesAgo(50),
      payload: { actionId, operation: "merge_needs" },
      type: "assistant.action_rejected",
    });

  const write = (actor: Actor, type: "suggestion.accepted" | "decision.published") =>
    record({
      actor,
      needId: randomUUID(),
      occurredAt: minutesAgo(120),
      payload: { decisionId: randomUUID(), kind: "brief", status: "planned" },
      suggestionId: randomUUID(),
      type,
    });

  it("counts outcomes and divides assistant writes by all human writes", async () => {
    await confirm(await propose(minutesAgo(60)), false);
    await confirm(await propose(minutesAgo(60)), true);
    await reject(await propose(minutesAgo(60)));
    // Expired 60 minutes ago, never answered.
    await propose(minutesAgo(90));
    await write(pm, "suggestion.accepted");
    await write(pm, "decision.published");
    await write(agent, "decision.published");

    expect(await share()).toEqual({
      confirmedEdited: 1,
      confirmedUnchanged: 1,
      expired: 1,
      proposed: 4,
      rejected: 1,
      share: 0.5,
      writes: { assistant: 2, human: 4 },
    });
  });

  it("is null with no human writes and ignores agent writes", async () => {
    await write(agent, "decision.published");
    const result = await share();
    expect(result.share).toBeNull();
    expect(result.writes).toEqual({ assistant: 0, human: 0 });
  });

  it("lets the clock decide expiry, from the row or proposal time + TTL", async () => {
    // Past the TTL, no row.
    await propose(minutesAgo(31), { row: false });
    // Still pending.
    await propose(minutesAgo(10), { row: false });
    // The row's expires_at wins over proposal time + TTL.
    await propose(minutesAgo(90), { expiresAt: new Date(now.getTime() + 60_000) });
    const result = await share();
    expect(result.proposed).toBe(3);
    expect(result.expired).toBe(1);
  });

  it("counts a failed confirm nowhere", async () => {
    await propose(minutesAgo(60), { status: "failed" });
    expect(await share()).toEqual({
      confirmedEdited: 0,
      confirmedUnchanged: 0,
      expired: 0,
      proposed: 1,
      rejected: 0,
      share: null,
      writes: { assistant: 0, human: 0 },
    });
  });

  it("counts a retried confirm once", async () => {
    const actionId = await propose(minutesAgo(60));
    await confirm(actionId, false);
    await confirm(actionId, false);
    await write(pm, "suggestion.accepted");
    const result = await share();
    expect(result.confirmedUnchanged).toBe(1);
    expect(result.writes).toEqual({ assistant: 1, human: 2 });
    expect(result.share).toBe(0.5);
  });

  it("leaves proposals and writes outside the window out", async () => {
    await confirm(
      await propose(new Date(window.from.getTime() - DAY_MS)),
      false,
      minutesAgo(8 * 24 * 60),
    );
    const result = await share();
    expect(result.proposed).toBe(0);
    expect(result.writes).toEqual({ assistant: 0, human: 0 });
  });
});
