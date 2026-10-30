import { randomBytes } from "node:crypto";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { events, reports } from "@/lib/db/schema";

import type { Actor, OperationContext } from "../context";
import type { SignalDb, SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { findIdentifyingText, loadIdentifyingCandidates } from "./public-text";
import type { PublicTextFinding } from "./public-text";
import { runReportDataset } from "./report-datasets";
import type { DatasetQuery, DatasetResult } from "./report-datasets";
import { pruneReportData, reportSpecSchema, validateReportSpec } from "./report-spec";
import type { ReportData, ReportSpec } from "./report-spec";

/**
 * Saved reports and share links (spec 013 → Saved reports and sharing).
 *
 * - Saving validates the spec and re-runs every dataset on the server: rows a client sends are
 *   never stored. A report's `snapshot` is a frozen `{ title, spec, data }` as of `snapshot_at`.
 * - While a report is shared, saving an update leaves the snapshot alone, so the link keeps
 *   showing exactly what passed the identifying-text check until the PM refreshes it.
 * - Opening a report in the console re-runs its queries now (no model call); the link shows the
 *   snapshot. Every action records a `report.*` event in the same transaction.
 */

export type RunDataset = (query: Pick<DatasetQuery, "name" | "params">) => Promise<DatasetResult>;

export interface ReportDeps {
  actor: Actor;
  db: SignalDb;
  now: Date;
  /** Runs one dataset query; production passes `runReportDataset(db, query, now)`. */
  runDataset: RunDataset;
}

/** Production dependencies: datasets run against the operation's database at its clock. */
export const reportDepsFor = ({ actor, clock, db }: OperationContext): ReportDeps => {
  const now = clock.now();
  return { actor, db, now, runDataset: (query) => runReportDataset(db, query, now) };
};

export const reportIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\w.:-]+$/u, "Use letters, digits, and . _ : - only.");

export const shareTokenSchema = z.string().min(1).max(128);

const TOKEN_PATTERN = /^[\w-]{16,128}$/u;

/** A share token: 32 random bytes, base64url (like My signals links). */
const newShareToken = () => randomBytes(32).toString("base64url");

export const sharePath = (token: string) => `/r/${token}`;

interface Snapshot {
  data: ReportData;
  spec: ReportSpec;
  title: string;
}

type ReportRow = typeof reports.$inferSelect;

const parseSpec = (value: unknown): ReportSpec => {
  const parsed = reportSpecSchema.safeParse(value);
  if (!parsed.success)
    throw new SignalError(
      "validation_failed",
      `Invalid report spec: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "spec"} ${issue.message}`)
        .join("; ")}`,
    );
  const issues = validateReportSpec(parsed.data);
  if (issues.length > 0)
    throw new SignalError(
      "validation_failed",
      `Invalid report spec: ${issues
        .map((issue) =>
          issue.block === null ? issue.message : `block ${issue.block}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  return parsed.data;
};

/** Runs every dataset of a spec, keyed by its id. */
const runAll = async (spec: ReportSpec, runDataset: RunDataset): Promise<ReportData> =>
  Object.fromEntries(
    await Promise.all(
      spec.datasets.map(
        async (query) =>
          [query.id, await runDataset({ name: query.name, params: query.params })] as const,
      ),
    ),
  );

const findReport = async (db: SignalQueryable, reportId: string) => {
  const [row] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
  return row;
};

const requireReport = async (db: SignalQueryable, reportId: string) => {
  const row = await findReport(db, reportId);
  if (!row) throw new SignalError("not_found", `No report with id ${reportId}.`);
  return row;
};

const savedKey = (idempotencyKey: string) => `report.saved:${idempotencyKey}`;

export interface SaveReportInput {
  idempotencyKey?: string;
  prompt: string;
  reportId?: string;
  spec: unknown;
  title: string;
}

export interface SaveReportResult {
  created: boolean;
  reportId: string;
  snapshotAt: string;
  title: string;
  updatedAt: string;
}

const toSaveResult = (row: ReportRow, created: boolean): SaveReportResult => ({
  created,
  reportId: row.id,
  snapshotAt: row.snapshotAt.toISOString(),
  title: row.title,
  updatedAt: row.updatedAt.toISOString(),
});

/** The stored result of an earlier save with this key, if any. */
const findReplay = async (db: SignalQueryable, idempotencyKey: string) => {
  const [event] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.dedupeKey, savedKey(idempotencyKey)))
    .limit(1);
  if (!event) return;
  const { created, reportId } = event.payload as { created?: unknown; reportId?: unknown };
  if (typeof reportId !== "string") return;
  const row = await findReport(db, reportId);
  return row ? toSaveResult(row, created === true) : undefined;
};

/** Raised inside the transaction when a concurrent request already saved with this key. */
class DuplicateSaveError extends Error {
  constructor() {
    super("A concurrent request already saved with this idempotencyKey.");
    this.name = "DuplicateSaveError";
  }
}

/**
 * Creates a report, or updates `reportId`. The snapshot is re-run here from the spec. A retry
 * with the same `idempotencyKey` returns the first result and records nothing.
 */
export const saveReport = async (
  { actor, db, now, runDataset }: ReportDeps,
  input: SaveReportInput,
): Promise<SaveReportResult> => {
  const spec = parseSpec(input.spec);
  if (input.idempotencyKey) {
    const replay = await findReplay(db, input.idempotencyKey);
    if (replay) return replay;
  }
  if (input.reportId) await requireReport(db, input.reportId);

  const snapshot: Snapshot = { data: await runAll(spec, runDataset), spec, title: input.title };
  const created = !input.reportId;
  try {
    return await db.transaction(async (tx) => {
      let row: ReportRow | undefined;
      if (input.reportId) {
        const existing = await requireReport(tx, input.reportId);
        // A live link keeps the snapshot that passed the identifying-text check.
        const keepSnapshot = existing.shareToken !== null;
        [row] = await tx
          .update(reports)
          .set({
            prompt: input.prompt,
            spec,
            title: input.title,
            updatedAt: now,
            ...(keepSnapshot ? {} : { snapshot: { ...snapshot }, snapshotAt: now }),
          })
          .where(eq(reports.id, input.reportId))
          .returning();
      } else
        [row] = await tx
          .insert(reports)
          .values({
            createdAt: now,
            createdByKind: actor.kind,
            prompt: input.prompt,
            snapshot: { ...snapshot },
            snapshotAt: now,
            spec,
            title: input.title,
            updatedAt: now,
          })
          .returning();
      if (!row) throw new Error("Report write returned no row.");
      const recorded = await recordEvent(tx, {
        actor,
        dedupeKey: input.idempotencyKey ? savedKey(input.idempotencyKey) : undefined,
        occurredAt: now,
        payload: { created, reportId: row.id },
        type: "report.saved",
      });
      if (!recorded) throw new DuplicateSaveError();
      return toSaveResult(row, created);
    });
  } catch (error) {
    if (!(error instanceof DuplicateSaveError) || !input.idempotencyKey) throw error;
    const replay = await findReplay(db, input.idempotencyKey);
    if (!replay) throw error;
    return replay;
  }
};

export interface ReportListItem {
  reportId: string;
  sharedAt: string | null;
  title: string;
  updatedAt: string;
}

/** Saved reports, most recently updated first. */
export const listReports = async (db: SignalQueryable): Promise<ReportListItem[]> => {
  const rows = await db
    .select({
      id: reports.id,
      sharedAt: reports.sharedAt,
      title: reports.title,
      updatedAt: reports.updatedAt,
    })
    .from(reports)
    .orderBy(desc(reports.updatedAt), desc(reports.createdAt), desc(reports.id));
  return rows.map((row) => ({
    reportId: row.id,
    sharedAt: row.sharedAt?.toISOString() ?? null,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  }));
};

const shareOf = (row: ReportRow) =>
  row.shareToken
    ? {
        path: sharePath(row.shareToken),
        sharedAt: (row.sharedAt ?? row.snapshotAt).toISOString(),
        snapshotAt: row.snapshotAt.toISOString(),
      }
    : null;

/**
 * A saved report with its queries re-run now; records `report.viewed` (console) unless
 * `recordView` is false: the page a save lands on is not a reuse.
 */
export const getReport = async (
  { actor, db, now, runDataset }: ReportDeps,
  reportId: string,
  { recordView = true }: { recordView?: boolean } = {},
) => {
  const row = await requireReport(db, reportId);
  const spec = reportSpecSchema.parse(row.spec);
  const data = await runAll(spec, runDataset);
  if (recordView)
    await recordEvent(db, {
      actor,
      occurredAt: now,
      payload: { reportId: row.id, via: "console" },
      type: "report.viewed",
    });
  return {
    asOf: now.toISOString(),
    data,
    prompt: row.prompt,
    reportId: row.id,
    share: shareOf(row),
    spec,
    title: row.title,
  };
};

/** Every piece of text a shared snapshot shows: titles, headings, text, labels, string cells. */
export const snapshotTexts = ({ data, spec, title }: Snapshot): string[] => {
  const texts = [title, spec.title];
  for (const block of spec.blocks) {
    if (block.kind === "heading") texts.push(block.text);
    if (block.kind === "text") texts.push(block.markdown);
    if (block.kind === "kpi") texts.push(...block.items.map((item) => item.label));
    if (block.kind === "chart") texts.push(block.title, block.caption ?? "");
    if (block.kind === "table") texts.push(block.title);
  }
  for (const result of Object.values(data))
    for (const row of result.rows)
      for (const value of Object.values(row)) if (typeof value === "string") texts.push(value);
  return texts.filter((text) => text.length > 0);
};

export type ShareAction = "share" | "refresh" | "revoke";

export type ShareReportResult =
  | { flags: PublicTextFinding[]; status: "needs_acknowledgement" }
  | { path: string; snapshotAt: string; status: "shared" }
  | { status: "revoked" };

/**
 * Share or refresh: re-run the queries into a new snapshot, scan it for names, accounts, and
 * emails, and (when nothing is flagged or the flags are acknowledged) store it behind a link
 * token, keeping an existing token. Revoke clears the token. Records `report.shared`.
 */
export const shareReport = async (
  { actor, db, now, runDataset }: ReportDeps,
  input: { acknowledgeFlags?: boolean; action: ShareAction; reportId: string },
): Promise<ShareReportResult> => {
  const row = await requireReport(db, input.reportId);
  const event = {
    actor,
    occurredAt: now,
    payload: { action: input.action, reportId: row.id },
    type: "report.shared" as const,
  };

  if (input.action === "revoke")
    return db.transaction(async (tx) => {
      await tx
        .update(reports)
        .set({ shareToken: null, sharedAt: null })
        .where(eq(reports.id, row.id));
      await recordEvent(tx, event);
      return { status: "revoked" as const };
    });

  if (input.action === "refresh" && !row.shareToken)
    throw new SignalError("validation_failed", "This report has no live link; share it first.");

  const spec = reportSpecSchema.parse(row.spec);
  // The link carries only what the report shows: unreferenced datasets and columns are dropped.
  const snapshot: Snapshot = {
    data: pruneReportData(spec, await runAll(spec, runDataset)),
    spec,
    title: row.title,
  };
  // One scan over the joined text; blank lines keep matches from spanning two values.
  const flags = findIdentifyingText(
    snapshotTexts(snapshot).join("\n\n"),
    await loadIdentifyingCandidates(db, undefined),
  );
  if (flags.length > 0 && !input.acknowledgeFlags)
    return { flags, status: "needs_acknowledgement" };

  return db.transaction(async (tx) => {
    const current = await requireReport(tx, row.id);
    const token = current.shareToken ?? newShareToken();
    const [updated] = await tx
      .update(reports)
      .set({
        shareToken: token,
        sharedAt: current.sharedAt ?? now,
        snapshot: { ...snapshot },
        snapshotAt: now,
      })
      .where(eq(reports.id, row.id))
      .returning();
    if (!updated) throw new Error("Report share returned no row.");
    await recordEvent(tx, event);
    return {
      path: sharePath(token),
      snapshotAt: updated.snapshotAt.toISOString(),
      status: "shared" as const,
    };
  });
};

/** The snapshot behind a live share link; `not_found` for an unknown or revoked token. */
export const getSharedReport = async (
  { actor, db, now }: Pick<ReportDeps, "actor" | "db" | "now">,
  token: string,
) => {
  const missing = new SignalError("not_found", "This report link does not exist or was revoked.");
  if (!TOKEN_PATTERN.test(token)) throw missing;
  const [row] = await db.select().from(reports).where(eq(reports.shareToken, token)).limit(1);
  if (!row) throw missing;
  const snapshot = row.snapshot as unknown as Snapshot;
  const spec = reportSpecSchema.parse(snapshot.spec);
  // Once per viewer per report per UTC day, so reloads and link-preview bots count once.
  await recordEvent(db, {
    actor,
    dedupeKey: `report.viewed:link:${row.id}:${actor.kind}:${actor.ref}:${now.toISOString().slice(0, 10)}`,
    occurredAt: now,
    payload: { reportId: row.id, via: "link" },
    type: "report.viewed",
  });
  return {
    data: pruneReportData(spec, snapshot.data),
    snapshotAt: row.snapshotAt.toISOString(),
    spec,
    title: snapshot.title,
  };
};
