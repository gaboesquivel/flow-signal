import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Actor } from "../../../lib/signal/context";
import type { SignalDb } from "../../../lib/signal/db";
import { recordEvent } from "../../../lib/signal/events";
import type { Metrics } from "../../../lib/signal/metrics";
import { getMetrics } from "../../../lib/signal/operations/get-metrics";
import { configureSignalRuntime } from "../../../lib/signal/runtime";
import { runParityTable } from "./harness";

const now = new Date("2026-10-30T09:00:00Z");
const at = (iso: string) => new Date(iso);

const human: Actor = { kind: "human", ref: "web" };
const agent: Actor = { client: "support-copilot", kind: "agent", ref: "mcp:support-copilot" };
const operator: Actor = { kind: "human", ref: "operator" };

/**
 * A week of history: Maya's human signal and an agent's signal attach to N1, a draft need is
 * merged into it, N1 gets a decision from an agent, and the PM resolves three suggestions.
 */
const buildFixture = async (db: SignalDb) => {
  configureSignalRuntime({ clock: { now: () => now } });
  const n1 = randomUUID();
  const draft = randomUUID();
  await recordEvent(db, {
    actor: human,
    needId: n1,
    occurredAt: at("2026-10-02T10:00:00Z"),
    type: "need.created",
  });
  for (const [actor, when] of [
    [human, "2026-10-27T10:00:00Z"],
    [agent, "2026-10-28T10:00:00Z"],
  ] as const)
    await recordEvent(db, {
      actor,
      needId: n1,
      occurredAt: at(when),
      payload: { attachedTo: "existing", hasUseCase: true },
      signalId: randomUUID(),
      type: "signal.created",
    });
  const draftSignal = randomUUID();
  await recordEvent(db, {
    actor: human,
    needId: draft,
    occurredAt: at("2026-10-27T12:00:00Z"),
    signalId: draftSignal,
    type: "need.created",
  });
  await recordEvent(db, {
    actor: human,
    needId: draft,
    occurredAt: at("2026-10-27T12:00:00Z"),
    payload: { attachedTo: "draft", hasUseCase: false },
    signalId: draftSignal,
    type: "signal.created",
  });
  await recordEvent(db, {
    actor: operator,
    needId: draft,
    occurredAt: at("2026-10-29T10:00:00Z"),
    payload: { intoNeedId: n1, mergeId: randomUUID() },
    type: "need.merged",
  });
  await recordEvent(db, {
    actor: agent,
    needId: n1,
    occurredAt: at("2026-10-29T12:00:00Z"),
    payload: { decisionId: randomUUID(), status: "planned" },
    type: "decision.published",
  });
  for (const [kind, status] of [
    ["priority", "accepted"],
    ["decision_brief", "accepted"],
    ["public_summary", "edited"],
  ] as const) {
    const suggestionId = randomUUID();
    await recordEvent(db, {
      actor: { kind: "agent", ref: "signal:ai" },
      needId: n1,
      occurredAt: at("2026-10-28T09:00:00Z"),
      payload: { kind },
      suggestionId,
      type: "suggestion.created",
    });
    await recordEvent(db, {
      actor: operator,
      needId: n1,
      occurredAt: at("2026-10-29T09:00:00Z"),
      payload: { kind },
      suggestionId,
      type: `suggestion.${status}`,
    });
  }
  return { n1 };
};

const thisWeek = { from: "2026-10-26", to: now.toISOString() };

runParityTable({
  cases: [
    {
      check: (output) => {
        const metrics = output as Metrics;
        assert.deepEqual(metrics.window, {
          from: "2026-10-26T00:00:00.000Z",
          to: "2026-10-30T09:00:00.000Z",
        });
        assert.deepEqual(metrics.preventionRate.overall, {
          agent: { attachedToExisting: 1, mergedDrafts: 0, rate: 1 },
          all: { attachedToExisting: 2, mergedDrafts: 1, rate: 0.6667 },
          human: { attachedToExisting: 1, mergedDrafts: 1, rate: 0.5 },
        });
        assert.deepEqual(
          metrics.preventionRate.weeks.map((week) => week.weekStart),
          ["2026-10-26"],
        );
        assert.deepEqual(metrics.decisionLatency.decided.agent, {
          decisions: 1,
          medianDays: 27.08,
        });
        assert.deepEqual(metrics.decisionLatency.decided.human, {
          decisions: 0,
          medianDays: null,
        });
        assert.deepEqual(metrics.suggestionAcceptance.overall.all, {
          acceptanceRate: 0.6667,
          accepted: 2,
          edited: 1,
          rejected: 0,
        });
        assert.deepEqual(
          metrics.suggestionAcceptance.byKind.map((row) => row.kind),
          ["decision_brief", "priority", "public_summary"],
        );
        assert.deepEqual(metrics.supporting.contextRate.all, {
          rate: 0.6667,
          signals: 3,
          withUseCase: 2,
        });
        assert.deepEqual(metrics.supporting.timeToTriage, { medianHours: 24, resolved: 3 });
      },
      input: () => thisWeek,
      name: "reads this week's metrics, split human vs. agent",
    },
    {
      check: (output) => {
        const metrics = output as Metrics;
        assert.deepEqual(metrics.window, {
          from: "2026-10-02T09:00:00.000Z",
          to: "2026-10-30T09:00:00.000Z",
        });
        assert.equal(metrics.preventionRate.weeks.length, 5);
        assert.equal(metrics.decisionLatency.openPast30Days.needs, 0);
      },
      input: () => ({}),
      name: "defaults to the 28 days before now",
    },
    {
      check: (output) => {
        const metrics = output as Metrics;
        assert.equal(metrics.preventionRate.overall.all.rate, null);
        assert.equal(metrics.suggestionAcceptance.overall.all.acceptanceRate, null);
        assert.deepEqual(metrics.suggestionAcceptance.byKind, []);
      },
      input: () => ({ from: "2026-09-01", to: "2026-09-08" }),
      name: "returns null rates for an empty window",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ from: "2026-10-30", to: "2026-10-26" }),
      name: "rejects a window that ends before it starts",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ from: "2025-01-01", to: "2026-10-26" }),
      name: "rejects a window longer than 366 days",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ from: "last week" }),
      name: "rejects a malformed date",
    },
  ],
  fixture: buildFixture,
  operation: getMetrics,
});
