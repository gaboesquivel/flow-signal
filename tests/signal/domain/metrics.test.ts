import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Actor } from "../../../lib/signal/context";
import { recordEvent } from "../../../lib/signal/events";
import type { SignalEvent } from "../../../lib/signal/events";
import { computeMetrics, DAY_MS, resolveMetricsWindow } from "../../../lib/signal/metrics";
import { seedDemoWorkspace } from "../../../lib/signal/seed/demo-workspace";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

// a Friday; its ISO week starts 2026-10-26
const now = new Date("2026-10-30T09:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
const thisWeek = { from: new Date("2026-10-26T00:00:00Z"), to: now };

const human: Actor = { kind: "human", ref: "web" };
const agent: Actor = { client: "support-copilot", kind: "agent", ref: "mcp:support-copilot" };
const operator: Actor = { kind: "human", ref: "operator" };

/** Match exposure as `submit_signal` records it for a shown preview (spec 012). */
const shownTo = (chosenRank: number | null, shownNeedIds = [randomUUID(), randomUUID()]) => ({
  chosenRank,
  kind: "shown",
  previewId: `pv_${randomUUID()}`,
  shownNeedIds,
});

describeWithDatabase("metrics from the event log", () => {
  const harness = useTestDatabase();
  const record = (event: SignalEvent) => recordEvent(harness.db, event);
  const metrics = (window = thisWeek) => computeMetrics(harness.db, window);

  /** A signal as `submit_signal` records it; returns its need id. */
  const signal = async (
    attachedTo: "existing" | "draft",
    options: { actor?: Actor; at?: Date; key?: string; needId?: string; useCase?: boolean } = {},
  ) => {
    const needId = options.needId ?? randomUUID();
    const signalId = randomUUID();
    const actor = options.actor ?? human;
    const at = options.at ?? daysAgo(1);
    if (attachedTo === "draft")
      await record({ actor, needId, occurredAt: at, signalId, type: "need.created" });
    await record({
      actor,
      dedupeKey: options.key,
      needId,
      occurredAt: at,
      payload: {
        attachedTo,
        ...(options.useCase === undefined ? {} : { hasUseCase: options.useCase }),
      },
      signalId,
      type: "signal.created",
    });
    return needId;
  };

  const merge = async (needId: string, at = daysAgo(1)) => {
    const mergeId = randomUUID();
    await record({
      actor: operator,
      needId,
      occurredAt: at,
      payload: { intoNeedId: randomUUID(), mergeId },
      type: "need.merged",
    });
    return mergeId;
  };

  const undo = (needId: string, mergeId: string, at = daysAgo(0.5)) =>
    record({ actor: operator, needId, occurredAt: at, payload: { mergeId }, type: "merge.undone" });

  const created = (needId: string, at: Date) =>
    record({ actor: human, needId, occurredAt: at, type: "need.created" });

  const decide = (needId: string, at: Date, actor: Actor = operator) =>
    record({
      actor,
      needId,
      occurredAt: at,
      payload: { decisionId: randomUUID(), status: "planned" },
      type: "decision.published",
    });

  const publish = (
    status: string,
    recommendedStatus: string | null | undefined,
    options: { actor?: Actor; at?: Date; decisionId?: string; key?: string } = {},
  ) =>
    record({
      actor: options.actor ?? operator,
      dedupeKey: options.key,
      needId: randomUUID(),
      occurredAt: options.at ?? daysAgo(1),
      payload: {
        decisionId: options.decisionId ?? randomUUID(),
        status,
        ...(recommendedStatus === undefined
          ? {}
          : { briefSuggestionId: recommendedStatus ? randomUUID() : null, recommendedStatus }),
      },
      type: "decision.published",
    });

  const ready = (needId: string, at: Date) =>
    record({
      actor: { kind: "agent", ref: "signal:readiness" },
      dedupeKey: `need.ready:${needId}`,
      needId,
      occurredAt: at,
      payload: { arrCents: 30_000_000, strategyVersion: 1, supporters: 3 },
      type: "need.ready",
    });

  const suggestion = async (
    kind: string,
    resolution?: {
      actor?: Actor;
      at?: Date;
      status: "accepted" | "edited" | "rejected" | "superseded";
    },
    createdAt = daysAgo(3),
  ) => {
    const suggestionId = randomUUID();
    await record({
      actor: { kind: "agent", ref: "signal:ai" },
      occurredAt: createdAt,
      payload: { kind },
      suggestionId,
      type: "suggestion.created",
    });
    if (resolution)
      await record({
        actor: resolution.actor ?? operator,
        occurredAt: resolution.at ?? daysAgo(1),
        payload: { kind },
        suggestionId,
        type: `suggestion.${resolution.status}`,
      });
    return suggestionId;
  };

  /** Close-the-loop rate: a signal filed on `needId` at `at`; returns its id. */
  const filed = async (needId: string, at: Date, attachedTo: "existing" | "draft" = "existing") => {
    const signalId = randomUUID();
    await record({
      actor: human,
      needId,
      occurredAt: at,
      payload: { attachedTo },
      signalId,
      type: "signal.created",
    });
    return signalId;
  };
  const decideOn = async (needId: string, at: Date, key?: string) => {
    const decisionId = randomUUID();
    await record({
      actor: operator,
      dedupeKey: key,
      needId,
      occurredAt: at,
      payload: { decisionId, status: "planned" },
      type: "decision.published",
    });
    return decisionId;
  };
  /** `signal.decision_seen` as `get_my_signals` records it; no dedupe key unless given. */
  const seen = (signalId: string, needId: string, decisionId: string, at: Date, key?: string) =>
    record({
      actor: human,
      dedupeKey: key,
      needId,
      occurredAt: at,
      payload: { decisionId, status: "planned" },
      signalId,
      type: "signal.decision_seen",
    });
  const closeTheLoop = async (window = thisWeek) => (await metrics(window)).closeTheLoopRate;

  beforeEach(() => resetDatabase(harness.db));

  describe("prevention rate", () => {
    it("divides signals attached to existing needs by those plus merged drafts", async () => {
      await signal("existing");
      await signal("existing");
      await signal("existing");
      await merge(await signal("draft"));
      // a draft never merged is a new need, not a missed duplicate
      await signal("draft");
      const { preventionRate } = await metrics();
      expect(preventionRate.overall.all).toEqual({
        attachedToExisting: 3,
        mergedDrafts: 1,
        rate: 0.75,
      });
    });

    it("reports human and agent signals separately", async () => {
      await signal("existing", { actor: human });
      await signal("existing", { actor: agent });
      await signal("existing", { actor: agent });
      await merge(await signal("draft", { actor: agent }));
      const { overall } = (await metrics()).preventionRate;
      expect(overall.human).toEqual({ attachedToExisting: 1, mergedDrafts: 0, rate: 1 });
      expect(overall.agent).toEqual({
        attachedToExisting: 2,
        mergedDrafts: 1,
        rate: 0.6667,
      });
      expect(overall.all.attachedToExisting).toBe(3);
    });

    it("counts a retried submission once", async () => {
      const needId = randomUUID();
      await signal("existing", { key: "signal:retry-1", needId });
      await signal("existing", { key: "signal:retry-1", needId });
      expect((await metrics()).preventionRate.overall.all.attachedToExisting).toBe(1);
    });

    it("counts the same signal recorded twice once", async () => {
      const signalId = randomUUID();
      for (const _ of [1, 2])
        await record({
          actor: human,
          needId: randomUUID(),
          occurredAt: daysAgo(1),
          payload: { attachedTo: "existing" },
          signalId,
          type: "signal.created",
        });
      expect((await metrics()).preventionRate.overall.all.attachedToExisting).toBe(1);
    });

    it("excludes failed requests", async () => {
      await signal("existing");
      await expect(
        harness.db.transaction(async (tx) => {
          await recordEvent(tx, {
            actor: human,
            needId: randomUUID(),
            occurredAt: daysAgo(1),
            payload: { attachedTo: "existing" },
            signalId: randomUUID(),
            type: "signal.created",
          });
          throw new Error("validation failed after the insert");
        }),
      ).rejects.toThrow("validation failed");
      expect((await metrics()).preventionRate.overall.all.attachedToExisting).toBe(1);
    });

    it("no longer counts a draft as a duplicate once its merge is undone", async () => {
      await signal("existing");
      const draftNeed = await signal("draft");
      const mergeId = await merge(draftNeed, daysAgo(1));
      expect((await metrics()).preventionRate.overall.all.mergedDrafts).toBe(1);

      await undo(draftNeed, mergeId, daysAgo(0.5));
      expect((await metrics()).preventionRate.overall.all).toEqual({
        attachedToExisting: 1,
        mergedDrafts: 0,
        rate: 1,
      });

      // merged again, not undone
      await merge(draftNeed, daysAgo(0.25));
      expect((await metrics()).preventionRate.overall.all.mergedDrafts).toBe(1);
    });

    it("judges merges as of the window end", async () => {
      const draftNeed = await signal("draft", { at: daysAgo(10) });
      await merge(draftNeed, daysAgo(2));
      const before = { from: daysAgo(14), to: daysAgo(3) };
      expect((await metrics(before)).preventionRate.overall.all.mergedDrafts).toBe(0);
      expect((await metrics({ from: daysAgo(14), to: now })).preventionRate.overall.all).toEqual({
        attachedToExisting: 0,
        mergedDrafts: 1,
        rate: 0,
      });
    });

    it("buckets signals by ISO week, including empty weeks", async () => {
      await signal("existing", { at: new Date("2026-10-27T10:00:00Z") });
      await signal("existing", { actor: agent, at: new Date("2026-10-13T10:00:00Z") });
      // outside the window
      await signal("existing", { at: new Date("2026-09-01T10:00:00Z") });
      const { weeks } = (await metrics({ from: new Date("2026-10-10T00:00:00Z"), to: now }))
        .preventionRate;
      expect(weeks.map((week) => week.weekStart)).toEqual([
        "2026-10-05",
        "2026-10-12",
        "2026-10-19",
        "2026-10-26",
      ]);
      expect(weeks.map((week) => week.all.attachedToExisting)).toEqual([0, 1, 0, 1]);
      expect(weeks[1]?.agent.attachedToExisting).toBe(1);
      expect(weeks[3]?.human.attachedToExisting).toBe(1);
      expect(weeks[0]?.all.rate).toBeNull();
    });
  });

  describe("decision latency", () => {
    it("takes the median days from first signal to first decision, by publisher", async () => {
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      await created(a, daysAgo(12));
      // 10 days
      await decide(a, daysAgo(2));
      await created(b, daysAgo(24));
      // 20 days
      await decide(b, daysAgo(4));
      // a later decision does not count again
      await decide(b, daysAgo(1));
      await created(c, daysAgo(9));
      // 6 days, by an agent
      await decide(c, daysAgo(3), agent);
      const { decided } = (await metrics({ from: daysAgo(7), to: now })).decisionLatency;
      expect(decided.all).toEqual({ decisions: 3, medianDays: 10 });
      expect(decided.human).toEqual({ decisions: 2, medianDays: 15 });
      expect(decided.agent).toEqual({ decisions: 1, medianDays: 6 });
    });

    it("counts a need only when its first decision falls in the window", async () => {
      const need = randomUUID();
      await created(need, daysAgo(60));
      await decide(need, daysAgo(40));
      await decide(need, daysAgo(2));
      const { decided } = (await metrics()).decisionLatency;
      expect(decided.all).toEqual({ decisions: 0, medianDays: null });
    });

    it("reports undecided needs open past 30 days separately", async () => {
      const [old, older, young, decided, merged] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await created(old, daysAgo(40));
      await created(older, daysAgo(50));
      // open, but not past 30 days
      await created(young, daysAgo(10));
      await created(decided, daysAgo(45));
      await decide(decided, daysAgo(2));
      await created(merged, daysAgo(70));
      await merge(merged, daysAgo(20));
      const { decisionLatency } = await metrics();
      expect(decisionLatency.openPast30Days).toEqual({ medianAgeDays: 45, needs: 2 });
      expect(decisionLatency.decided.all).toEqual({ decisions: 1, medianDays: 43 });
    });

    it("counts a need whose merge was undone as open again", async () => {
      const need = randomUUID();
      await created(need, daysAgo(40));
      await undo(need, await merge(need, daysAgo(20)), daysAgo(10));
      expect((await metrics()).decisionLatency.openPast30Days.needs).toBe(1);
    });
  });

  describe("direction accuracy", () => {
    it("matches the published status against the brief's recommendation, by publisher", async () => {
      await publish("planned", "planned");
      await publish("declined", "planned");
      await publish("planned", "planned", { actor: agent });
      // outside the window
      await publish("planned", "declined", { at: daysAgo(10) });
      const { directionAccuracy } = await metrics();
      expect(directionAccuracy).toEqual({
        byActorKind: { agent: { matched: 1, total: 1 }, human: { matched: 1, total: 2 } },
        matched: 2,
        rate: 0.6667,
        total: 3,
      });
    });

    it("leaves out decisions published without a brief", async () => {
      await publish("planned", "planned");
      await publish("planned", null);
      await publish("declined", undefined);
      const { directionAccuracy } = await metrics();
      expect(directionAccuracy.total).toBe(1);
      expect(directionAccuracy.rate).toBe(1);
    });

    it("counts a retried publish once", async () => {
      const decisionId = randomUUID();
      for (const _ of [1, 2])
        await publish("planned", "planned", { decisionId, key: `decision:${decisionId}` });
      // the same decision recorded twice without a dedupe key
      const other = randomUUID();
      for (const _ of [1, 2]) await publish("declined", "planned", { decisionId: other });
      expect((await metrics()).directionAccuracy).toMatchObject({ matched: 1, total: 2 });
    });

    it("is null with no recommended decisions", async () => {
      await publish("planned", null);
      expect((await metrics()).directionAccuracy).toEqual({
        byActorKind: { agent: { matched: 0, total: 0 }, human: { matched: 0, total: 0 } },
        matched: 0,
        rate: null,
        total: 0,
      });
    });
  });

  describe("readiness lead time", () => {
    it("takes the median days from ready to first decision in the window", async () => {
      const [a, b, c, early, notReady] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await ready(a, daysAgo(3));
      // 2 days
      await decide(a, daysAgo(1));
      // a retried need.ready is recorded once
      await ready(a, daysAgo(3));
      await ready(b, daysAgo(10));
      // 4 days
      await decide(b, daysAgo(6), agent);
      // a later decision does not count again
      await decide(b, daysAgo(0.5));
      await ready(c, daysAgo(20));
      // 15 days
      await decide(c, daysAgo(5));
      // decided before it was ready: no lead time
      await decide(early, daysAgo(4));
      await ready(early, daysAgo(2));
      // decided, never ready
      await decide(notReady, daysAgo(2));
      const { readinessLeadTime } = await metrics({ from: daysAgo(7), to: now });
      expect(readinessLeadTime).toEqual({
        decided: 3,
        medianDays: 4,
        readyUndecidedOver30Days: 0,
      });
    });

    it("counts ready needs undecided after 30 days separately", async () => {
      const [old, young, decided, merged] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await ready(old, daysAgo(40));
      await ready(young, daysAgo(10));
      await ready(decided, daysAgo(45));
      await decide(decided, daysAgo(35));
      await ready(merged, daysAgo(50));
      await merge(merged, daysAgo(20));
      expect((await metrics()).readinessLeadTime).toEqual({
        decided: 0,
        medianDays: null,
        readyUndecidedOver30Days: 1,
      });
    });
  });

  describe("suggestion acceptance", () => {
    it("reports accepted, edited, and rejected per kind and resolver", async () => {
      await suggestion("priority", { status: "accepted" });
      await suggestion("decision_brief", { status: "accepted" });
      await suggestion("public_summary", { status: "edited" });
      await suggestion("merge", { status: "rejected" });
      await suggestion("merge", { actor: agent, status: "accepted" });
      // pending
      await suggestion("theme");
      // earlier
      await suggestion("priority", { at: daysAgo(10), status: "rejected" }, daysAgo(12));
      const { byKind, overall } = (await metrics()).suggestionAcceptance;
      expect(overall.all).toEqual({ acceptanceRate: 0.6, accepted: 3, edited: 1, rejected: 1 });
      expect(overall.human).toEqual({
        acceptanceRate: 0.5,
        accepted: 2,
        edited: 1,
        rejected: 1,
      });
      expect(overall.agent).toEqual({ acceptanceRate: 1, accepted: 1, edited: 0, rejected: 0 });
      expect(byKind.map((row) => [row.kind, row.all.acceptanceRate])).toEqual([
        ["decision_brief", 1],
        ["merge", 0.5],
        ["priority", 1],
        ["public_summary", 0],
      ]);
      expect(byKind.find((row) => row.kind === "merge")?.agent.accepted).toBe(1);
    });

    it("counts a retried resolution once", async () => {
      const suggestionId = await suggestion("priority");
      for (const _ of [1, 2])
        await record({
          actor: operator,
          dedupeKey: `suggestion.resolve:${suggestionId}`,
          occurredAt: daysAgo(1),
          payload: { kind: "priority" },
          suggestionId,
          type: "suggestion.accepted",
        });
      expect((await metrics()).suggestionAcceptance.overall.all.accepted).toBe(1);
    });
  });

  describe("supporting counts", () => {
    it("computes context rate, time to triage, review load, and unmerge rate", async () => {
      await signal("existing", { useCase: true });
      await signal("existing", { useCase: false });
      await signal("existing", { actor: agent, useCase: true });
      // reports no use-case field: left out of the rate
      await signal("existing");

      // 24 h
      await suggestion("priority", { at: daysAgo(1), status: "accepted" }, daysAgo(2));
      // 48 h
      await suggestion("theme", { at: daysAgo(1), status: "rejected" }, daysAgo(3));
      // pending
      await suggestion("public_summary", undefined, daysAgo(2));
      // pending, created before the window
      await suggestion("merge", undefined, daysAgo(20));

      const kept = randomUUID();
      const undone = randomUUID();
      await merge(kept, daysAgo(2));
      await undo(undone, await merge(undone, daysAgo(2)), daysAgo(1));

      const { supporting, unsupported } = await metrics();
      expect(supporting.contextRate.all).toEqual({ rate: 0.6667, signals: 3, withUseCase: 2 });
      expect(supporting.contextRate.agent).toEqual({ rate: 1, signals: 1, withUseCase: 1 });
      expect(supporting.timeToTriage).toEqual({ medianHours: 36, resolved: 2 });
      expect(supporting.reviewLoad).toEqual({ created: 3, pendingAtEnd: 2, resolved: 2 });
      expect(supporting.unmergeRate).toEqual({ merges: 2, rate: 0.5, undone: 1 });
      expect(unsupported).toEqual([]);
    });

    it("a superseded brief is no longer pending and is not a resolution", async () => {
      await suggestion("decision_brief", { at: daysAgo(1), status: "accepted" }, daysAgo(2));
      // The duplicate brief closed when the decision was published.
      await suggestion("decision_brief", { at: daysAgo(1), status: "superseded" }, daysAgo(2));
      const { suggestionAcceptance, supporting } = await metrics();
      expect(supporting.reviewLoad).toEqual({ created: 2, pendingAtEnd: 0, resolved: 1 });
      expect(suggestionAcceptance.overall.all).toMatchObject({ accepted: 1, rejected: 0 });
    });
  });

  /** A signal as `submit_signal` records it with match exposure (spec 012); returns its ids. */
  const exposed = async (
    exposure: Record<string, unknown>,
    options: {
      actor?: Actor;
      at?: Date;
      attachedTo?: "existing" | "draft";
      previewId?: string;
    } = {},
  ) => {
    const needId = randomUUID();
    const signalId = randomUUID();
    const actor = options.actor ?? human;
    const at = options.at ?? daysAgo(1);
    const attachedTo =
      options.attachedTo ??
      ("chosenRank" in exposure && exposure.chosenRank !== null ? "existing" : "draft");
    if (attachedTo === "draft")
      await record({ actor, needId, occurredAt: at, signalId, type: "need.created" });
    await record({
      actor,
      dedupeKey: `signal.created:${signalId}`,
      needId,
      occurredAt: at,
      payload: {
        attachedTo,
        exposure,
        hasUseCase: false,
        ...(options.previewId ? { previewId: options.previewId } : {}),
      },
      signalId,
      type: "signal.created",
    });
    return { needId, signalId };
  };
  const mergeInto = async (needId: string, intoNeedId: string, at = daysAgo(0.8)) => {
    const mergeId = randomUUID();
    await record({
      actor: operator,
      needId,
      occurredAt: at,
      payload: { intoNeedId, mergeId },
      type: "need.merged",
    });
    return mergeId;
  };
  const previewShown = (previewId: string, matches: number, at = daysAgo(2)) =>
    record({
      actor: human,
      dedupeKey: `preview.shown:${previewId}`,
      occurredAt: at,
      payload: {
        additionalAsks: 0,
        ai: "ok",
        matches: Array.from({ length: matches }, (_, index) => ({
          needId: randomUUID(),
          probability: 0.9,
          rank: index + 1,
        })),
        previewId,
      },
      type: "preview.shown",
    });

  /** Writes `count` shown submissions; the first `taken` picked a shown need. */
  const shownBatch = async (
    count: number,
    taken: number,
    actor: Actor = human,
    at = daysAgo(1),
  ) => {
    for (let index = 0; index < count; index += 1)
      await exposed(shownTo(index < taken ? 1 : null), { actor, at });
  };

  describe("match exposure (spec 012)", () => {
    it("computes take-up and chosen ranks, split human vs. agent", async () => {
      await exposed(shownTo(1));
      await exposed(shownTo(2));
      await exposed(shownTo(null));
      await exposed(shownTo(null));
      await exposed(shownTo(3), { actor: agent });
      await exposed({ kind: "skipped" }, { attachedTo: "existing" });
      await exposed({ kind: "none_shown", previewId: "pv_none" });
      await exposed({ kind: "unknown", previewId: "pv_forged" }, { actor: agent });
      await signal("existing");

      const { exposure } = await metrics();
      expect(exposure.submissions.human).toMatchObject({
        chosenRank: { 1: 1, 2: 1, 3: 0 },
        noneShown: 1,
        shown: 4,
        skipped: 1,
        takeUpRate: 0.5,
        taken: 2,
        unknown: 0,
      });
      expect(exposure.submissions.agent).toMatchObject({
        chosenRank: { 1: 0, 2: 0, 3: 1 },
        shown: 1,
        takeUpRate: 1,
        unknown: 1,
      });
      expect(exposure.submissions.all).toMatchObject({ shown: 5, takeUpRate: 0.6, taken: 3 });
    });

    it("counts a retry once and leaves out signals outside the window", async () => {
      const { needId, signalId } = await exposed(shownTo(1));
      await record({
        actor: human,
        needId,
        occurredAt: daysAgo(1),
        payload: { attachedTo: "existing", exposure: shownTo(1) },
        signalId,
        type: "signal.created",
      });
      await exposed(shownTo(1), { at: daysAgo(10) });
      expect((await metrics()).exposure.submissions.all).toMatchObject({ shown: 1, taken: 1 });
    });

    it("splits filed-new-despite-match by what the PM later did, and an undone merge returns it", async () => {
      const shownNeed = randomUUID();
      const intoShown = await exposed(shownTo(null, [shownNeed]));
      const elsewhere = await exposed(shownTo(null));
      await exposed(shownTo(null));
      const mergeId = await mergeInto(intoShown.needId, shownNeed);
      await mergeInto(elsewhere.needId, randomUUID());

      expect((await metrics()).exposure.submissions.all.filedNewDespiteMatch).toEqual({
        mergedElsewhere: 1,
        mergedIntoShown: 1,
        total: 3,
        unmerged: 1,
      });

      await undo(intoShown.needId, mergeId);
      expect((await metrics()).exposure.submissions.all.filedNewDespiteMatch).toEqual({
        mergedElsewhere: 1,
        mergedIntoShown: 0,
        total: 3,
        unmerged: 2,
      });
    });

    it("counts taken matches a PM later split off their need", async () => {
      const moved = await exposed(shownTo(1));
      await exposed(shownTo(2));
      await record({
        actor: operator,
        needId: moved.needId,
        occurredAt: daysAgo(0.5),
        payload: { newNeedId: randomUUID(), signalIds: [moved.signalId] },
        type: "need.split",
      });
      expect((await metrics()).exposure.submissions.all.movedOffTakenMatch).toEqual({
        moved: 1,
        rate: 0.5,
      });
    });

    it("follows merge chains on both sides when splitting filed-new-despite-match", async () => {
      // Shown N1 later merged into N3; the draft merged into N3.
      const n1 = randomUUID();
      const n3 = randomUUID();
      const viaShownSuccessor = await exposed(shownTo(null, [n1]));
      await mergeInto(n1, n3, daysAgo(0.9));
      await mergeInto(viaShownSuccessor.needId, n3);

      // The draft merged into N4, then N4 merged into shown N2.
      const n2 = randomUUID();
      const n4 = randomUUID();
      const viaDraftSuccessor = await exposed(shownTo(null, [n2]));
      await mergeInto(viaDraftSuccessor.needId, n4);
      await mergeInto(n4, n2, daysAgo(0.7));

      // An undone link breaks the chain: the draft merged into N5, N5 into shown N6, undone.
      const n5 = randomUUID();
      const n6 = randomUUID();
      const broken = await exposed(shownTo(null, [n6]));
      await mergeInto(broken.needId, n5);
      await undo(n5, await mergeInto(n5, n6, daysAgo(0.7)));

      // A link after `to` doesn't count yet.
      const n7 = randomUUID();
      const n8 = randomUUID();
      const later = await exposed(shownTo(null, [n7]));
      await mergeInto(later.needId, n8);
      await mergeInto(n8, n7, new Date(now.getTime() + DAY_MS));

      expect((await metrics()).exposure.submissions.all.filedNewDespiteMatch).toEqual({
        mergedElsewhere: 2,
        mergedIntoShown: 2,
        total: 4,
        unmerged: 0,
      });
    });

    it("counts a taken match split off the need its need was merged into", async () => {
      const moved = await exposed(shownTo(1));
      await exposed(shownTo(2));
      const successor = randomUUID();
      await mergeInto(moved.needId, successor);
      await record({
        actor: operator,
        needId: successor,
        occurredAt: daysAgo(0.5),
        payload: { newNeedId: randomUUID(), signalIds: [moved.signalId] },
        type: "need.split",
      });
      expect((await metrics()).exposure.submissions.all.movedOffTakenMatch).toEqual({
        moved: 1,
        rate: 0.5,
      });
    });

    it("counts previews with matches that no submission followed within 24 hours", async () => {
      await previewShown("pv_abandoned", 2);
      await previewShown("pv_empty", 0);
      await previewShown("pv_submitted", 1);
      await exposed(shownTo(1), { at: daysAgo(1.5), previewId: "pv_submitted" });
      await previewShown("pv_late", 1, daysAgo(4));
      await exposed(shownTo(1), { at: daysAgo(1), previewId: "pv_late" });
      // Its submit window closes exactly at `to`: counted.
      await previewShown("pv_closed", 1, daysAgo(1));
      // Still open at `to`: not counted yet.
      await previewShown("pv_open", 1, new Date(daysAgo(1).getTime() + 1));
      await previewShown("pv_recent", 1, daysAgo(0.2));

      expect((await metrics()).exposure.previewsWithoutSubmission).toEqual({
        agent: 0,
        all: 3,
        human: 3,
      });
    });
  });

  describe("kill criterion (spec 012)", () => {
    it("reports insufficient data under 200 shown submissions, ignoring the window start", async () => {
      await shownBatch(150, 150, human, daysAgo(120));
      await shownBatch(49, 49);
      const { killCriterion } = await metrics();
      expect(killCriterion.populations.all).toMatchObject({
        shownSubmissions: 199,
        verdict: "insufficient_data",
      });
      expect(killCriterion.minShownSubmissions).toBe(200);
    });

    it("passes at 200 with enough prevention and fails below 30% or above 10% unmerges", async () => {
      await shownBatch(200, 60);
      let { killCriterion } = await metrics();
      expect(killCriterion.populations.all.preventionRate.rate).toBe(1);
      expect(killCriterion.populations.all.verdict).toBe("pass");
      expect(killCriterion.populations.agent.verdict).toBe("insufficient_data");

      // Unmerged drafts stay out of the denominator; one merged draft makes it 60 / 61.
      const { needId } = await exposed(shownTo(null));
      await mergeInto(needId, randomUUID());
      ({ killCriterion } = await metrics());
      expect(killCriterion.populations.all.verdict).toBe("pass");

      const mergeId = await mergeInto(randomUUID(), randomUUID());
      await undo(randomUUID(), mergeId);
      ({ killCriterion } = await metrics());
      expect(killCriterion.unmergeRate).toEqual({ merges: 2, rate: 0.5, undone: 1 });
      expect(killCriterion.populations.all.verdict).toBe("fail");
    });

    it("passes at exactly 30% prevention and exactly 10% unmerges", async () => {
      await shownBatch(200, 60);
      const drafts = await harness.db.execute(sql`
        SELECT need_id FROM events
        WHERE type = 'signal.created' AND payload->>'attachedTo' = 'draft'
      `);
      const rows = (
        Array.isArray(drafts) ? drafts : (drafts as { rows: { need_id: string }[] }).rows
      ) as { need_id: string }[];
      const merges: [string, string][] = [];
      for (const row of rows)
        merges.push([row.need_id, await mergeInto(row.need_id, randomUUID())]);
      let { killCriterion } = await metrics();
      expect(killCriterion.populations.all.preventionRate.rate).toBe(0.3);
      expect(killCriterion.populations.all.verdict).toBe("pass");

      // 14 of 140 merges undone is exactly 10%.
      for (const [needId, mergeId] of merges.slice(0, 14)) await undo(needId, mergeId);
      ({ killCriterion } = await metrics());
      expect(killCriterion.unmergeRate.rate).toBe(0.1);
      expect(killCriterion.populations.all.verdict).toBe("pass");
    });

    it("fails when prevention over shown submissions is under 30%", async () => {
      await shownBatch(200, 50);
      const drafts = await harness.db.execute(sql`
        SELECT need_id FROM events
        WHERE type = 'signal.created' AND payload->>'attachedTo' = 'draft'
      `);
      const rows = (
        Array.isArray(drafts) ? drafts : (drafts as { rows: { need_id: string }[] }).rows
      ) as {
        need_id: string;
      }[];
      for (const row of rows) await mergeInto(row.need_id, randomUUID());
      const { killCriterion } = await metrics();
      expect(killCriterion.populations.all.preventionRate).toEqual({
        attachedToExisting: 50,
        mergedDrafts: 150,
        rate: 0.25,
      });
      expect(killCriterion.populations.all.verdict).toBe("fail");
    });
  });

  describe("close-the-loop rate", () => {
    it("divides signals whose holder saw the decision by signals on the decided need", async () => {
      const needId = randomUUID();
      const maya = await filed(needId, daysAgo(10));
      await filed(needId, daysAgo(9));
      const decision = await decideOn(needId, daysAgo(2));
      await seen(maya, needId, decision, daysAgo(1));
      // recorded twice without a dedupe key: still one
      await seen(maya, needId, decision, daysAgo(0.5));

      expect(await closeTheLoop()).toEqual({ decidedSignals: 2, rate: 0.5, seen: 1 });
    });

    it("counts a signal again for a later decision on its need", async () => {
      const needId = randomUUID();
      const maya = await filed(needId, daysAgo(10));
      const first = await decideOn(needId, daysAgo(3));
      await seen(maya, needId, first, daysAgo(2.5));
      await decideOn(needId, daysAgo(2));

      expect(await closeTheLoop()).toEqual({ decidedSignals: 2, rate: 0.5, seen: 1 });
    });

    it("leaves out signals filed after the decision and decisions outside the window", async () => {
      const needId = randomUUID();
      const early = await filed(needId, daysAgo(10));
      const older = await decideOn(needId, daysAgo(8));
      await seen(early, needId, older, daysAgo(7));
      const decision = await decideOn(needId, daysAgo(2));
      const late = await filed(needId, daysAgo(1));
      await seen(late, needId, decision, daysAgo(0.5));

      expect(await closeTheLoop()).toEqual({ decidedSignals: 1, rate: 0, seen: 0 });
    });

    it("counts a retried decision once and a view after the window not at all", async () => {
      const needId = randomUUID();
      const maya = await filed(needId, daysAgo(10));
      const decision = await decideOn(needId, daysAgo(2), "publish-1");
      await decideOn(needId, daysAgo(2), "publish-1");
      await seen(maya, needId, decision, new Date(now.getTime() + DAY_MS));

      expect(await closeTheLoop()).toEqual({ decidedSignals: 1, rate: 0, seen: 0 });
    });

    it("counts merged duplicates on the need they moved to, unless the merge was undone", async () => {
      const needId = randomUUID();
      const kept = randomUUID();
      const undone = randomUUID();
      const keptSignal = await filed(kept, daysAgo(10), "draft");
      await filed(undone, daysAgo(10), "draft");
      for (const draft of [kept, undone])
        await record({
          actor: operator,
          needId: draft,
          occurredAt: daysAgo(5),
          payload: { intoNeedId: needId, mergeId: draft },
          type: "need.merged",
        });
      await undo(undone, undone, daysAgo(4));
      const decision = await decideOn(needId, daysAgo(2));
      await seen(keptSignal, needId, decision, daysAgo(1));

      expect(await closeTheLoop()).toEqual({ decidedSignals: 1, rate: 1, seen: 1 });
    });

    it("follows a split signal to its new need", async () => {
      const from = randomUUID();
      const to = randomUUID();
      const moved = await filed(from, daysAgo(10));
      await filed(from, daysAgo(10));
      await record({
        actor: operator,
        needId: from,
        occurredAt: daysAgo(5),
        payload: { newNeedId: to, signalIds: [moved] },
        type: "need.split",
      });
      const decision = await decideOn(to, daysAgo(2));
      await seen(moved, to, decision, daysAgo(1));

      expect(await closeTheLoop()).toEqual({ decidedSignals: 1, rate: 1, seen: 1 });
    });

    it("is null with no decided signals", async () => {
      expect(await closeTheLoop()).toEqual({ decidedSignals: 0, rate: null, seen: 0 });
    });
  });

  describe("window", () => {
    it("defaults to the 28 days before now", () => {
      expect(resolveMetricsWindow({}, now)).toEqual({ from: daysAgo(28), to: now });
      expect(resolveMetricsWindow({ from: "2026-10-01", to: "2026-10-08" }, now)).toEqual({
        from: new Date("2026-10-01T00:00:00Z"),
        to: new Date("2026-10-08T00:00:00Z"),
      });
    });
  });

  describe("seeded history", () => {
    it("produces values for all three metrics in the default window", async () => {
      await seedDemoWorkspace(harness.db, { now });
      const result = await computeMetrics(harness.db, resolveMetricsWindow({}, now));
      expect(result.preventionRate.overall.all.rate).not.toBeNull();
      expect(result.preventionRate.overall.human.rate).not.toBeNull();
      expect(result.preventionRate.overall.agent.rate).not.toBeNull();
      expect(result.decisionLatency.decided.all.medianDays).not.toBeNull();
      expect(result.decisionLatency.openPast30Days.needs).toBeGreaterThan(0);
      expect(result.suggestionAcceptance.overall.all.acceptanceRate).not.toBeNull();
      // Seeded history carries no exposure, so it never counts toward the kill criterion.
      expect(result.killCriterion.populations.all.shownSubmissions).toBe(0);
      expect(result.suggestionAcceptance.byKind.length).toBeGreaterThan(0);
      expect(result.supporting.contextRate.all.rate).not.toBeNull();
    });

    it("includes merged drafts over the full 90-day history", async () => {
      await seedDemoWorkspace(harness.db, { now });
      const result = await computeMetrics(harness.db, { from: daysAgo(90), to: now });
      expect(result.preventionRate.overall.all.mergedDrafts).toBe(2);
      const rate = result.preventionRate.overall.all.rate!;
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThan(1);
    });
  });
});
