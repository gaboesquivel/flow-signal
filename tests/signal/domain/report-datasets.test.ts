import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { accounts, decisions } from "../../../lib/db/schema";
import type { Actor } from "../../../lib/signal/context";
import {
  datasetColumns,
  datasetNames,
  MAX_DATASET_ROWS,
  runReportDataset,
} from "../../../lib/signal/domain/report-datasets";
import type { DatasetName } from "../../../lib/signal/domain/report-datasets";
import { SignalError } from "../../../lib/signal/errors";
import { recordEvent } from "../../../lib/signal/events";
import { computeMetrics, DAY_MS } from "../../../lib/signal/metrics";
import {
  insertAccount,
  insertCriteria,
  insertNeed,
  insertSubmitter,
  insertTheme,
} from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

// a Friday; its ISO week starts 2026-10-26
const NOW = new Date("2026-10-30T09:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const iso = (date: Date) => date.toISOString();

const human: Actor = { kind: "human", ref: "web" };
const agent: Actor = { client: "support-copilot", kind: "agent", ref: "mcp:support-copilot" };

const USE_CASE = "Our monthly board deck needs it";

/**
 * - N1 (Reporting, open, score 4.1): Maya (Acme, 3 days ago), a Globex person (agent, 10 days
 *   ago), an anonymous draft signal 40 days ago → 3 people, 2 accounts, rising.
 * - N2 (Compliance, open, score 2.0, ready 5 days ago): an Acme auditor (50 days) and an anonymous
 *   person (45 days) → falling.
 * - A merged-away need with one Globex signal (60 days ago).
 * - Decided (Compliance, planned): one signal 20 days ago, `need.created` then, a decision 2 days
 *   ago whose `decision.published` recommended `planned`.
 * - Old (shipped): one signal 410 days ago, a decision 400 days ago, no events.
 * - A Starter account with no signals.
 */
const buildWorkspace = async (db: Parameters<typeof insertCriteria>[0]) => {
  await insertCriteria(db);
  const reporting = await insertTheme(db, { name: "Reporting" });
  const compliance = await insertTheme(db, { name: "Compliance" });
  const acme = await insertAccount(db, {
    arrCents: 48_000_000,
    name: "Acme Corp",
    openDealCents: 12_000_000,
    plan: "Enterprise",
  });
  const globex = await insertAccount(db, { arrCents: 6_000_000, name: "Globex", plan: "Growth" });
  const starter = await insertAccount(db, { arrCents: 100_000, name: "Tiny Co", plan: "Starter" });
  const maya = await insertSubmitter(db, {
    accountId: acme.id,
    email: "maya@acme.example",
    name: "Maya Lindqvist",
  });
  const auditor = await insertSubmitter(db, {
    accountId: acme.id,
    email: "auditor@acme.example",
    name: "Arno Auditor",
  });
  const globexPerson = await insertSubmitter(db, {
    accountId: globex.id,
    email: "gina@globex.example",
    name: "Gina Globex",
  });

  const n1 = await insertNeed(db, {
    createdAt: daysAgo(40),
    scores: { business_value: 5, demand: 4, effort: 2, strategic_fit: 4 },
    signals: [
      { createdAt: daysAgo(3), submitterId: maya.id, useCase: USE_CASE },
      { actorKind: "agent", createdAt: daysAgo(10), submitterId: globexPerson.id },
      { attachedTo: "draft", createdAt: daysAgo(40) },
    ],
    statement: "Executives need to share dashboards so that boards see current numbers",
    themeId: reporting.id,
  });
  const n2 = await insertNeed(db, {
    createdAt: daysAgo(50),
    readyAt: daysAgo(5),
    scores: { business_value: 2, demand: 2, effort: 2, strategic_fit: 2 },
    signals: [{ createdAt: daysAgo(50), submitterId: auditor.id }, { createdAt: daysAgo(45) }],
    statement: "Compliance teams need to archive reports so that audits have a fixed record",
    themeId: compliance.id,
  });
  const merged = await insertNeed(db, {
    mergedIntoId: n1.need.id,
    signals: [{ createdAt: daysAgo(60), submitterId: globexPerson.id }],
    statement: "Board members need dashboard PDFs so that they can read offline",
    status: "merged",
  });
  const decided = await insertNeed(db, {
    createdAt: daysAgo(20),
    decision: { note: "Q1", publishedAt: daysAgo(2), status: "planned" },
    signals: [{ createdAt: daysAgo(20) }],
    statement: "Auditors need exportable logs so that reviews go faster",
    status: "planned",
    themeId: compliance.id,
  });
  const [decision] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(eq(decisions.needId, decided.need.id));
  await recordEvent(db, {
    actor: human,
    needId: decided.need.id,
    occurredAt: daysAgo(20),
    signalId: decided.signals[0]!.id,
    type: "need.created",
  });
  await recordEvent(db, {
    actor: human,
    needId: decided.need.id,
    occurredAt: daysAgo(2),
    payload: { decisionId: decision!.id, recommendedStatus: "planned", status: "planned" },
    type: "decision.published",
  });
  const old = await insertNeed(db, {
    createdAt: daysAgo(410),
    decision: { note: "Done", publishedAt: daysAgo(400), status: "shipped" },
    signals: [{ createdAt: daysAgo(410) }],
    statement: "Admins need SSO so that onboarding is simple",
    status: "shipped",
  });
  return { acme, compliance, decided, globex, merged, n1, n2, old, reporting, starter };
};
type Workspace = Awaited<ReturnType<typeof buildWorkspace>>;

describeWithDatabase("report datasets", () => {
  const harness = useTestDatabase();
  let ws: Workspace;

  beforeEach(async () => {
    await resetDatabase(harness.db);
    ws = await buildWorkspace(harness.db);
  });

  const run = (name: DatasetName, params: Record<string, unknown> = {}) =>
    runReportDataset(harness.db, { name, params }, NOW);
  const column = async (name: DatasetName, key: string, params: Record<string, unknown> = {}) =>
    (await run(name, params)).rows.map((row) => row[key]);
  const ids = (params: Record<string, unknown>) => column("needs", "needId", params);
  /** Signals per group over the default 12 weeks. */
  const totals = async (groupBy: string) => {
    const { rows } = await run("signals_weekly", { groupBy });
    const byGroup: Record<string, number> = {};
    for (const row of rows)
      byGroup[String(row.group)] = (byGroup[String(row.group)] ?? 0) + Number(row.signals);
    return { byGroup, rows };
  };
  const insertAccounts = (count: number) =>
    harness.db
      .insert(accounts)
      .values(Array.from({ length: count }, () => ({ name: randomUUID(), plan: "Starter" })));

  it("returns exactly each dataset's columns, in order", async () => {
    for (const name of datasetNames) {
      const result = await run(name);
      expect(result.columns).toEqual(datasetColumns[name]);
      expect(result.truncated).toBe(false);
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows)
        expect(Object.keys(row)).toEqual(datasetColumns[name].map((col) => col.key));
    }
  });

  it("rejects bad params and an empty window with validation_failed", async () => {
    const failures = [
      run("needs", { groupBy: "theme" }),
      run("needs", { status: ["merged"] }),
      run("accounts", { plan: "Platinum" }),
      run("signals_weekly", { since: "2026-10-30", until: "2026-10-01" }),
      run("metrics_weekly", { actor: "robot" }),
      run("decisions", { since: "not a date" }),
    ];
    for (const failure of failures)
      await expect(failure).rejects.toMatchObject({ code: "validation_failed" });
    await expect(run("needs", { plan: "Platinum" })).rejects.toBeInstanceOf(SignalError);
  });

  describe("needs", () => {
    it("lists live needs by priority with demand, money, trend, and dates; merged-away excluded", async () => {
      const { rows } = await run("needs");
      const needIds = rows.map((row) => row.needId);
      expect(needIds.slice(0, 2)).toEqual([ws.n1.need.id, ws.n2.need.id]);
      expect(needIds.toSorted()).toEqual(
        [ws.n1, ws.n2, ws.decided, ws.old].map((need) => need.need.id).toSorted(),
      );
      expect(needIds).not.toContain(ws.merged.need.id);
      expect(rows[0]).toEqual({
        accounts: 2,
        arrCents: 54_000_000,
        createdAt: iso(daysAgo(40)),
        decidedAt: null,
        needId: ws.n1.need.id,
        openDealCents: 12_000_000,
        people: 3,
        readyAt: null,
        score: 4.1,
        statement: ws.n1.need.statement,
        status: "open",
        theme: "Reporting",
        trend: "rising",
      });
      expect(rows[1]).toMatchObject({
        accounts: 1,
        arrCents: 48_000_000,
        people: 2,
        readyAt: iso(daysAgo(5)),
        score: 2,
        trend: "falling",
      });
      expect(rows.find((row) => row.needId === ws.decided.need.id)).toMatchObject({
        decidedAt: iso(daysAgo(2)),
        score: null,
        status: "planned",
        theme: "Compliance",
      });
      expect(rows.find((row) => row.needId === ws.old.need.id)).toMatchObject({ theme: null });
    });

    it("filters by theme, plan, status, and includeDecided", async () => {
      expect(await ids({ themeId: ws.compliance.id })).toEqual([ws.n2.need.id, ws.decided.need.id]);
      expect(await ids({ plan: "Enterprise" })).toEqual([ws.n1.need.id, ws.n2.need.id]);
      expect(await ids({ plan: "Growth" })).toEqual([ws.n1.need.id]);
      expect(await ids({ plan: "Starter" })).toEqual([]);
      expect(await ids({ status: ["planned", "shipped"] })).toHaveLength(2);
      expect(await ids({ status: ["open"] })).toEqual([ws.n1.need.id, ws.n2.need.id]);
      expect(await ids({ includeDecided: false })).toEqual([ws.n1.need.id, ws.n2.need.id]);
    });

    it("drops an open need with a decision when includeDecided is false", async () => {
      const reopened = await insertNeed(harness.db, {
        decision: { note: "Later", publishedAt: daysAgo(1), status: "planned" },
        statement: "Someone needs a reopened thing so that it shows",
      });
      expect(await column("needs", "needId")).toContain(reopened.need.id);
      expect(await column("needs", "needId", { includeDecided: false })).not.toContain(
        reopened.need.id,
      );
    });
  });

  describe("signals_weekly", () => {
    const window = { from: daysAgo(84), to: NOW };

    it("buckets the last 12 weeks like get_metrics, zero-filled, with attached counts", async () => {
      const metricWeeks = (await computeMetrics(harness.db, window)).preventionRate.weeks.map(
        (week) => week.weekStart,
      );
      const { rows } = await run("signals_weekly");
      expect(rows.map((row) => row.weekStart)).toEqual(metricWeeks);
      expect(metricWeeks.at(-1)).toBe("2026-10-26");
      expect(new Set(rows.map((row) => row.group))).toEqual(new Set(["All"]));
      const sum = (key: string) => rows.reduce((total, row) => total + Number(row[key]), 0);
      expect(sum("signals")).toBe(7);
      expect(sum("attachedDraft")).toBe(1);
      expect(sum("attachedExisting")).toBe(6);
      expect(rows.at(-1)).toEqual({
        attachedDraft: 0,
        attachedExisting: 1,
        group: "All",
        signals: 1,
        weekStart: "2026-10-26",
      });
    });

    it("groups by theme, plan, and actor", async () => {
      const theme = await totals("theme");
      expect(theme.byGroup).toEqual({ Compliance: 3, "No theme": 1, Reporting: 3 });
      expect(theme.rows).toHaveLength(13 * 3);
      expect((await totals("plan")).byGroup).toEqual({
        Enterprise: 2,
        Growth: 2,
        "No account": 3,
      });
      expect((await totals("actor")).byGroup).toEqual({ agent: 1, human: 6 });
    });

    it("filters by since and until", async () => {
      expect((await run("signals_weekly", { since: "2026-10-26", until: iso(NOW) })).rows).toEqual([
        {
          attachedDraft: 0,
          attachedExisting: 1,
          group: "All",
          signals: 1,
          weekStart: "2026-10-26",
        },
      ]);
      const { rows } = await run("signals_weekly", { since: "2026-10-12", until: "2026-10-26" });
      expect(rows.map((row) => [row.weekStart, row.signals])).toEqual([
        ["2026-10-12", 0],
        ["2026-10-19", 1],
      ]);
    });
  });

  describe("accounts", () => {
    it("lists accounts by ARR with live needs supported, signals, and the last signal", async () => {
      const { rows } = await run("accounts");
      expect(rows).toEqual([
        {
          account: "Acme Corp",
          accountId: ws.acme.id,
          arrCents: 48_000_000,
          lastSignalAt: iso(daysAgo(3)),
          needsSupported: 2,
          openDealCents: 12_000_000,
          plan: "Enterprise",
          signals: 2,
        },
        {
          account: "Globex",
          accountId: ws.globex.id,
          arrCents: 6_000_000,
          lastSignalAt: iso(daysAgo(10)),
          needsSupported: 1,
          openDealCents: 0,
          plan: "Growth",
          signals: 2,
        },
        {
          account: "Tiny Co",
          accountId: ws.starter.id,
          arrCents: 100_000,
          lastSignalAt: null,
          needsSupported: 0,
          openDealCents: 0,
          plan: "Starter",
          signals: 0,
        },
      ]);
    });

    it("filters by plan", async () => {
      expect(await column("accounts", "accountId", { plan: "Growth" })).toEqual([ws.globex.id]);
    });

    it(`truncates beyond ${MAX_DATASET_ROWS} rows`, async () => {
      await insertAccounts(MAX_DATASET_ROWS - 3);
      const full = await run("accounts");
      expect(full.rows).toHaveLength(MAX_DATASET_ROWS);
      expect(full.truncated).toBe(false);
      await insertAccounts(1);
      const over = await run("accounts");
      expect(over.rows).toHaveLength(MAX_DATASET_ROWS);
      expect(over.truncated).toBe(true);
      expect(over.rows[0]?.accountId).toBe(ws.acme.id);
    });
  });

  describe("decisions", () => {
    it("lists decisions of the last 180 days with latency and the recommended status", async () => {
      expect((await run("decisions")).rows).toEqual([
        {
          latencyDays: 18,
          needId: ws.decided.need.id,
          publishedAt: iso(daysAgo(2)),
          recommendedStatus: "planned",
          statement: ws.decided.need.statement,
          status: "planned",
          theme: "Compliance",
        },
      ]);
    });

    it("filters by since, until, and theme, newest first; latency falls back to the first signal", async () => {
      const all = await run("decisions", { since: iso(daysAgo(500)) });
      expect(all.rows.map((row) => row.needId)).toEqual([ws.decided.need.id, ws.old.need.id]);
      expect(all.rows[1]).toMatchObject({ latencyDays: 10, recommendedStatus: null, theme: null });
      expect(
        await column("decisions", "needId", { since: iso(daysAgo(500)), until: iso(daysAgo(10)) }),
      ).toEqual([ws.old.need.id]);
      expect(await column("decisions", "needId", { themeId: ws.reporting.id })).toEqual([]);
      expect(await column("decisions", "needId", { themeId: ws.compliance.id })).toEqual([
        ws.decided.need.id,
      ]);
    });
  });

  describe("metrics_weekly", () => {
    beforeEach(async () => {
      const signal = async (actor: Actor, attachedTo: "existing" | "draft", at: Date) => {
        const needId = randomUUID();
        await recordEvent(harness.db, {
          actor,
          needId,
          occurredAt: at,
          payload: { attachedTo },
          signalId: randomUUID(),
          type: "signal.created",
        });
        return needId;
      };
      await signal(human, "existing", daysAgo(3));
      await signal(agent, "existing", daysAgo(3));
      const draft = await signal(human, "draft", daysAgo(10));
      await recordEvent(harness.db, {
        actor: human,
        needId: draft,
        occurredAt: daysAgo(9),
        payload: { mergeId: randomUUID() },
        type: "need.merged",
      });
    });

    it("is get_metrics' weekly prevention series, per actor", async () => {
      const window = { from: daysAgo(84), to: NOW };
      const { weeks } = (await computeMetrics(harness.db, window)).preventionRate;
      for (const actor of ["all", "human", "agent"] as const) {
        const { rows } = await run("metrics_weekly", { actor });
        expect(rows.map((row) => row.weekStart)).toEqual(weeks.map((week) => week.weekStart));
        expect(
          rows.map(({ attachedExisting, mergedLater, preventionRate, weekStart }) => ({
            attachedExisting,
            mergedLater,
            preventionRate,
            weekStart,
          })),
        ).toEqual(
          weeks.map((week) => ({
            attachedExisting: week[actor].attachedToExisting,
            mergedLater: week[actor].mergedDrafts,
            preventionRate: week[actor].rate,
            weekStart: week.weekStart,
          })),
        );
      }
      const all = await run("metrics_weekly");
      expect(all.rows.slice(-2)).toEqual([
        {
          attachedExisting: 0,
          mergedLater: 1,
          preventionRate: 0,
          signals: 1,
          weekStart: "2026-10-19",
        },
        {
          attachedExisting: 2,
          mergedLater: 0,
          preventionRate: 1,
          signals: 2,
          weekStart: "2026-10-26",
        },
      ]);
      const humans = await run("metrics_weekly", { actor: "human", since: "2026-10-26" });
      expect(humans.rows).toEqual([
        {
          attachedExisting: 1,
          mergedLater: 0,
          preventionRate: 1,
          signals: 1,
          weekStart: "2026-10-26",
        },
      ]);
    });
  });

  it("never returns submitter names, emails, or signal text", async () => {
    const forbidden = [
      "maya@acme.example",
      "auditor@acme.example",
      "gina@globex.example",
      "@example.test",
      "Maya Lindqvist",
      "Arno Auditor",
      "Gina Globex",
      "Person ",
      "Verbatim",
      USE_CASE,
    ];
    const queries: [DatasetName, Record<string, unknown>][] = [
      ["needs", {}],
      ["accounts", {}],
      ["decisions", { since: iso(daysAgo(500)) }],
      ["metrics_weekly", {}],
      ...(["none", "theme", "plan", "actor"] as const).map(
        (groupBy): [DatasetName, Record<string, unknown>] => ["signals_weekly", { groupBy }],
      ),
    ];
    for (const [name, params] of queries) {
      const text = JSON.stringify(await run(name, params));
      for (const value of forbidden) expect(text).not.toContain(value);
    }
  });
});
