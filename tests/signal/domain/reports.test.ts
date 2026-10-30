import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { events, reports } from "../../../lib/db/schema";
import type { Actor } from "../../../lib/signal/context";
import type { DatasetResult } from "../../../lib/signal/domain/report-datasets";
import type { ReportSpec } from "../../../lib/signal/domain/report-spec";
import {
  getReport,
  getSharedReport,
  listReports,
  saveReport,
  shareReport,
} from "../../../lib/signal/domain/reports";
import type { ReportDeps, RunDataset } from "../../../lib/signal/domain/reports";
import { computeMetrics, DAY_MS } from "../../../lib/signal/metrics";
import { SignalError } from "../../../lib/signal/errors";
import { insertAccount, insertSubmitter } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

const start = new Date("2026-10-01T09:00:00Z");
const human: Actor = { kind: "human", ref: "web" };
const agent: Actor = { client: "digest-bot", kind: "agent", ref: "mcp:digest-bot" };

const spec: ReportSpec = {
  blocks: [
    { kind: "heading", text: "Demand by theme" },
    {
      chart: "bar",
      dataset: "d1",
      kind: "chart",
      title: "ARR by theme",
      x: "theme",
      y: ["arrCents"],
    },
    { columns: ["statement", "arrCents"], dataset: "d1", kind: "table", title: "Top needs" },
  ],
  datasets: [{ id: "d1", name: "needs", params: {} }],
  title: "Weekly demand",
  version: 1,
};

const needsColumns: DatasetResult["columns"] = [
  { key: "statement", label: "Need", type: "string" },
  { key: "theme", label: "Theme", type: "string" },
  { key: "arrCents", label: "ARR", type: "number", unit: "cents" },
];

/** A stub dataset runner whose rows the test controls; counts its calls. */
const stubDatasets = () => {
  const state = {
    calls: 0,
    rows: [{ arrCents: 100, statement: "Export to CSV", theme: "Reporting" }] as Record<
      string,
      string | number | null
    >[],
  };
  const run: RunDataset = () => {
    state.calls += 1;
    return Promise.resolve({ columns: needsColumns, rows: [...state.rows], truncated: false });
  };
  return { run, state };
};

const reuseWindow = { from: start, to: new Date(start.getTime() + 60 * DAY_MS) };

const errorCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SignalError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("Expected a SignalError.");
};

describeWithDatabase("saved reports and sharing", () => {
  const harness = useTestDatabase();
  let stub = stubDatasets();
  let now = start;
  const deps = (actor: Actor = human): ReportDeps => ({
    actor,
    db: harness.db,
    now,
    runDataset: stub.run,
  });
  const at = (days: number) => {
    now = new Date(start.getTime() + days * DAY_MS);
  };
  const reportEvents = () =>
    harness.db
      .select()
      .from(events)
      .orderBy(asc(events.occurredAt))
      .then((rows) => rows.filter((row) => row.type.startsWith("report.")));
  const save = (input: Partial<Parameters<typeof saveReport>[1]> = {}, actor?: Actor) =>
    saveReport(deps(actor), { prompt: "ARR by theme", spec, title: "Weekly demand", ...input });

  const reuse = async () => (await computeMetrics(harness.db, reuseWindow)).reportReuse;

  beforeEach(async () => {
    await resetDatabase(harness.db);
    stub = stubDatasets();
    now = start;
  });

  describe("save_report", () => {
    it("stores the server's rows, never data the client sent", async () => {
      const withClientData = { ...spec, data: { d1: { rows: [{ arrCents: 999_999 }] } } };
      const saved = await save({ spec: withClientData });
      expect(saved.created).toBe(true);
      const [row] = await harness.db.select().from(reports).where(eq(reports.id, saved.reportId));
      expect(row?.snapshot).toMatchObject({
        data: { d1: { rows: [{ arrCents: 100, statement: "Export to CSV" }] } },
        title: "Weekly demand",
      });
      expect(JSON.stringify(row?.snapshot)).not.toContain("999999");
      expect(JSON.stringify(row?.spec)).not.toContain("999999");
      expect(row?.createdByKind).toBe("human");
      expect(await reportEvents()).toMatchObject([
        { payload: { created: true, reportId: saved.reportId }, type: "report.saved" },
      ]);
    });

    it("updates a report in place, keeping its id", async () => {
      const first = await save();
      at(1);
      const second = await save({ reportId: first.reportId, title: "Weekly demand v2" });
      expect(second).toMatchObject({ created: false, reportId: first.reportId });
      expect(await listReports(harness.db)).toEqual([
        {
          reportId: first.reportId,
          sharedAt: null,
          title: "Weekly demand v2",
          updatedAt: now.toISOString(),
        },
      ]);
      expect((await reportEvents()).map((event) => event.payload.created)).toEqual([true, false]);
    });

    it("records one report.saved for a retry with the same idempotency key", async () => {
      const first = await save({ idempotencyKey: "save-weekly-0001" });
      const retry = await save({ idempotencyKey: "save-weekly-0001" });
      expect(retry).toEqual(first);
      expect(await harness.db.select().from(reports)).toHaveLength(1);
      expect(await reportEvents()).toHaveLength(1);
    });

    it("rejects an invalid spec with its issues and writes nothing", async () => {
      const invalid = {
        ...spec,
        blocks: [
          { chart: "donut", dataset: "d9", kind: "chart", title: "x", x: "theme", y: ["a", "b"] },
        ],
      };
      const failure = await errorCode(save({ spec: invalid }));
      expect(failure.code).toBe("validation_failed");
      expect(failure.message).toContain('Unknown dataset "d9"');
      expect(failure.message).toContain("exactly one y");
      expect(stub.state.calls).toBe(0);
      expect(await harness.db.select().from(reports)).toHaveLength(0);
      expect(await reportEvents()).toHaveLength(0);
    });

    it("is not_found for an unknown reportId", async () => {
      expect((await errorCode(save({ reportId: randomUUID() }))).code).toBe("not_found");
      expect(await reportEvents()).toHaveLength(0);
    });
  });

  describe("list_reports and get_report", () => {
    it("lists newest first and re-runs the queries on open", async () => {
      const older = await save({ title: "Older" });
      at(1);
      const newer = await save({ title: "Newer" });
      expect((await listReports(harness.db)).map((report) => report.reportId)).toEqual([
        newer.reportId,
        older.reportId,
      ]);

      stub.state.rows = [{ arrCents: 250, statement: "Export to CSV", theme: "Reporting" }];
      at(2);
      const opened = await getReport(deps(), older.reportId);
      expect(opened).toMatchObject({
        asOf: now.toISOString(),
        data: { d1: { rows: [{ arrCents: 250 }] } },
        prompt: "ARR by theme",
        share: null,
        spec,
        title: "Older",
      });
      expect((await reportEvents()).at(-1)).toMatchObject({
        payload: { reportId: older.reportId, via: "console" },
        type: "report.viewed",
      });
      expect((await errorCode(getReport(deps(), randomUUID()))).code).toBe("not_found");
    });
  });

  describe("share_report and get_shared_report", () => {
    it("flags names without acknowledgement and changes nothing", async () => {
      await insertAccount(harness.db, { name: "Globex Corp" });
      await insertSubmitter(harness.db, { email: "maya@globex.test", name: "Maya Chen" });
      stub.state.rows = [
        { arrCents: 100, statement: "Globex wants CSV export", theme: "Reporting" },
      ];
      const { reportId } = await save({
        spec: { ...spec, blocks: [...spec.blocks, { kind: "text", markdown: "Ask Maya Chen." }] },
      });
      const before = await reportEvents();

      const result = await shareReport(deps(), { action: "share", reportId });
      expect(result).toEqual({
        flags: [
          { kind: "person", match: "Maya Chen" },
          { kind: "account", match: "Globex" },
        ],
        status: "needs_acknowledgement",
      });
      const [row] = await harness.db.select().from(reports).where(eq(reports.id, reportId));
      expect(row?.shareToken).toBeNull();
      expect(await reportEvents()).toEqual(before);

      const shared = await shareReport(deps(), {
        acknowledgeFlags: true,
        action: "share",
        reportId,
      });
      expect(shared).toMatchObject({ status: "shared" });
      expect((await reportEvents()).at(-1)).toMatchObject({
        payload: { action: "share", reportId },
        type: "report.shared",
      });
    });

    it("shares a snapshot, refreshes it, and revokes the link", async () => {
      const { reportId } = await save();
      at(1);
      const shared = await shareReport(deps(), { action: "share", reportId });
      if (shared.status !== "shared") throw new Error("expected shared");
      expect(shared.path).toMatch(/^\/r\/[\w-]{43}$/u);
      expect(shared.snapshotAt).toBe(now.toISOString());
      const token = shared.path.slice(3);

      // New data does not reach the link until a refresh.
      stub.state.rows = [{ arrCents: 500, statement: "Export to CSV", theme: "Reporting" }];
      at(2);
      const viewed = await getSharedReport(deps(), token);
      expect(viewed).toMatchObject({
        data: { d1: { rows: [{ arrCents: 100 }] } },
        snapshotAt: shared.snapshotAt,
        spec,
        title: "Weekly demand",
      });
      expect((await reportEvents()).at(-1)).toMatchObject({
        payload: { reportId, via: "link" },
        type: "report.viewed",
      });

      // Saving an update leaves the shared snapshot alone.
      await save({ reportId, title: "Renamed" });
      expect((await getSharedReport(deps(), token)).title).toBe("Weekly demand");

      at(3);
      const refreshed = await shareReport(deps(), { action: "refresh", reportId });
      expect(refreshed).toEqual({
        path: shared.path,
        snapshotAt: now.toISOString(),
        status: "shared",
      });
      expect(await getSharedReport(deps(), token)).toMatchObject({
        data: { d1: { rows: [{ arrCents: 500 }] } },
        title: "Renamed",
      });
      expect((await getReport(deps(), reportId)).share).toEqual({
        path: shared.path,
        sharedAt: shared.snapshotAt,
        snapshotAt: now.toISOString(),
      });

      expect(await shareReport(deps(), { action: "revoke", reportId })).toEqual({
        status: "revoked",
      });
      expect((await errorCode(getSharedReport(deps(), token))).code).toBe("not_found");
      expect((await listReports(harness.db))[0]?.sharedAt).toBeNull();
      expect(
        (await reportEvents())
          .filter((event) => event.type === "report.shared")
          .map((event) => event.payload.action),
      ).toEqual(["share", "refresh", "revoke"]);
    });

    it("is not_found for an unknown token or report", async () => {
      expect((await errorCode(getSharedReport(deps(), "x".repeat(43)))).code).toBe("not_found");
      expect((await errorCode(getSharedReport(deps(), "short"))).code).toBe("not_found");
      expect(
        (await errorCode(shareReport(deps(), { action: "share", reportId: randomUUID() }))).code,
      ).toBe("not_found");
    });
  });

  describe("report reuse metric", () => {
    it("counts a view on day 13 and not one on day 15", async () => {
      const early = await save({ title: "Viewed day 13" });
      const late = await save({ title: "Viewed day 15" });
      at(13);
      await getReport(deps(), early.reportId);
      at(15);
      await getReport(deps(), late.reportId);
      expect((await reuse()).human).toEqual({ rate: 0.5, reused: 1, saved: 2 });
    });

    it("does not count the first save itself, but counts a later save or a share", async () => {
      await save({ title: "Saved once" });
      const resaved = await save({ title: "Saved again" });
      const shared = await save({ title: "Shared" });
      at(2);
      await save({ reportId: resaved.reportId, title: "Saved again v2" });
      await shareReport(deps(), { action: "share", reportId: shared.reportId });
      expect((await reuse()).human).toEqual({ rate: 0.6667, reused: 2, saved: 3 });
    });

    it("splits by who first saved the report", async () => {
      const byAgent = await save({ title: "Agent digest" }, agent);
      await save({ title: "PM report" });
      at(1);
      // A human opening the agent's report counts for the agent's report.
      await getReport(deps(), byAgent.reportId);
      expect(await reuse()).toEqual({
        agent: { rate: 1, reused: 1, saved: 1 },
        human: { rate: 0, reused: 0, saved: 1 },
      });
    });

    it("writes no event for a failed save", async () => {
      await errorCode(save({ spec: { ...spec, datasets: [] } }));
      expect(await reuse()).toEqual({
        agent: { rate: null, reused: 0, saved: 0 },
        human: { rate: null, reused: 0, saved: 0 },
      });
    });
  });
});
