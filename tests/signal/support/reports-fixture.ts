import { reports } from "../../../lib/db/schema";
import type { SignalDb } from "../../../lib/signal/db";
import type { ReportData, ReportSpec } from "../../../lib/signal/domain/report-spec";
import { insertAccount } from "./builders";

/** A valid report over the `needs` dataset (spec 013). */
export const reportSpec: ReportSpec = {
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

/** Snapshot rows as stored at share time; deliberately not what the live dataset returns. */
export const snapshotData: ReportData = {
  d1: {
    columns: [
      { key: "statement", label: "Need", type: "string" },
      { key: "theme", label: "Theme", type: "string" },
      { key: "arrCents", label: "ARR", type: "number", unit: "cents" },
    ],
    rows: [{ arrCents: 4_200_000, statement: "Snapshot need", theme: "Reporting" }],
    truncated: false,
  },
};

export const SHARE_TOKEN = "shared-report-token-000000000000000000000001";

/**
 * Two saved reports: `shared` has a live link (token `SHARE_TOKEN`) and a stored snapshot;
 * `revoked` was shared once and revoked. An account name the share check would flag exists.
 */
export const buildReportsFixture = async (db: SignalDb) => {
  const account = await insertAccount(db, { name: "Globex Corp", plan: "Enterprise" });
  const base = {
    createdByKind: "human" as const,
    prompt: "ARR by theme",
    snapshot: { data: snapshotData, spec: reportSpec, title: "Weekly demand" },
    spec: reportSpec,
  };
  const [revoked, shared] = await db
    .insert(reports)
    .values([
      {
        ...base,
        createdAt: new Date("2026-10-01T09:00:00Z"),
        snapshotAt: new Date("2026-10-01T09:00:00Z"),
        title: "Revoked report",
        updatedAt: new Date("2026-10-01T09:00:00Z"),
      },
      {
        ...base,
        createdAt: new Date("2026-10-02T09:00:00Z"),
        shareToken: SHARE_TOKEN,
        sharedAt: new Date("2026-10-03T09:00:00Z"),
        snapshotAt: new Date("2026-10-03T09:00:00Z"),
        title: "Weekly demand",
        updatedAt: new Date("2026-10-02T09:00:00Z"),
      },
    ])
    .returning();
  return { account, revoked: revoked!, shared: shared! };
};
export type ReportsFixture = Awaited<ReturnType<typeof buildReportsFixture>>;
