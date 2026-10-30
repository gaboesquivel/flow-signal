import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import { needs, signalTableNames } from "../../../lib/db/schema";
import { createFakeAi } from "../../../lib/signal/ai/fakes";
import type { Actor, OperationContext } from "../../../lib/signal/context";
import { actionPreviewSchema } from "../../../lib/signal/domain/assistant-actions";
import type { ActionPreview } from "../../../lib/signal/domain/assistant-actions";
import { queryRows } from "../../../lib/signal/domain/need-facts";
import { listOperatorNeeds } from "../../../lib/signal/domain/operator-needs";
import type { ReportSpec } from "../../../lib/signal/domain/report-spec";
import { SignalError } from "../../../lib/signal/errors";
import { mergeNeeds } from "../../../lib/signal/operations/merge-needs";
import { publishDecision } from "../../../lib/signal/operations/publish-decision";
import { resolveSuggestion } from "../../../lib/signal/operations/resolve-suggestion";
import { saveReport } from "../../../lib/signal/operations/save-report";
import { setCriteria } from "../../../lib/signal/operations/set-criteria";
import { setStrategy } from "../../../lib/signal/operations/set-strategy";
import { shareReport } from "../../../lib/signal/operations/share-report";
import { splitNeed } from "../../../lib/signal/operations/split-need";
import type { AnyOperation } from "../../../lib/signal/operations/types";
import { undoMerge } from "../../../lib/signal/operations/undo-merge";
import { insertNeed, supporters } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";
import { buildTriageFixture } from "../support/triage-fixture";
import type { TriageFixture } from "../support/triage-fixture";

/**
 * Spec 014 task 02: each write operation's `preview` matches what `run` then does, reads only
 * (no rows or events change), and throws the same code as `run` for a bad input.
 */

const pm: Actor = { kind: "human", ref: "web" };
const now = new Date("2026-10-30T09:00:00Z");

const lineOf = (preview: ActionPreview, label: string) =>
  preview.lines.find((line) => line.label === label)?.value;

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SignalError) return error.code;
    throw error;
  }
  return "ok";
};

const reportSpec = (markdown = "Weekly look at demand."): ReportSpec => ({
  blocks: [
    { kind: "heading", text: "Demand" },
    { kind: "text", markdown },
    { columns: ["statement", "people"], dataset: "d1", kind: "table", title: "Top needs" },
  ],
  datasets: [{ id: "d1", name: "needs", params: {} }],
  title: "Weekly demand",
  version: 1,
});

describeWithDatabase("assistant action previews", () => {
  const harness = useTestDatabase();
  let f: TriageFixture;

  const ctx = (): OperationContext => ({
    actor: pm,
    ai: createFakeAi(),
    clock: { now: () => now },
    db: harness.db,
  });

  /** Row count and content hash of every Signal table (events included). */
  const databaseState = async () =>
    Object.fromEntries(
      await Promise.all(
        signalTableNames.map(async (table) => {
          const [row] = await queryRows<{ count: number | string; digest: string | null }>(
            harness.db,
            sql.raw(
              `select count(*) as count, md5(string_agg(t::text, '|' order by t::text)) as digest from ${table} t`,
            ),
          );
          return [table, `${row?.count}:${row?.digest}`] as const;
        }),
      ),
    );

  /** Runs the preview, checks it is a valid card and changed nothing, and returns it. */
  const preview = async (operation: AnyOperation, input: Record<string, unknown>) => {
    const parsed = operation.input.parse(input);
    const before = await databaseState();
    const result = await operation.preview!(parsed, ctx());
    expect(await databaseState()).toEqual(before);
    return actionPreviewSchema.parse(result);
  };

  const run = (operation: AnyOperation, input: Record<string, unknown>) =>
    operation.run(operation.input.parse(input), ctx());

  /** The preview and the run throw the same code (and the preview writes nothing). */
  const expectSameError = async (
    operation: AnyOperation,
    input: Record<string, unknown>,
    code: string,
  ) => {
    const parsed = operation.input.parse(input);
    const before = await databaseState();
    expect(await codeOf(operation.preview!(parsed, ctx()))).toBe(code);
    expect(await databaseState()).toEqual(before);
    expect(await codeOf(operation.run(parsed, ctx()))).toBe(code);
  };

  const peopleOn = async (needId: string) => {
    const [row] = await queryRows<{ people: number | string }>(
      harness.db,
      sql`select count(distinct submitter_id) as people from signals where need_id = ${needId}`,
    );
    return Number(row?.people);
  };

  beforeEach(async () => {
    await resetDatabase(harness.db);
    f = await buildTriageFixture(harness.db);
  });

  it("merge_needs previews the signals and people that move", async () => {
    const source = await insertNeed(harness.db, { signals: supporters(7) });
    const card = await preview(mergeNeeds, { id: source.need.id, intoNeedId: f.n1.need.id });
    expect(card.title).toBe("Merge 2 needs");
    expect(card.needs).toEqual([
      { id: source.need.id, role: "source", statement: source.need.statement },
      { id: f.n1.need.id, role: "target", statement: f.n1.need.statement },
    ]);
    expect(lineOf(card, "Signals moving")).toBe("7");
    expect(lineOf(card, "People moving")).toBe("7");
    expect(lineOf(card, "People after")).toBe("10");
    expect(lineOf(card, "Open suggestions affected")).toBe("0");
    expect(card.editable).toEqual([]);

    const result = await run(mergeNeeds, { id: source.need.id, intoNeedId: f.n1.need.id });
    expect(result.movedSignalIds).toHaveLength(7);
    expect(await peopleOn(f.n1.need.id)).toBe(10);
  });

  it("merge_needs counts open suggestions on the merged-away need, and fails like run", async () => {
    const card = await preview(mergeNeeds, { id: f.draft.need.id, intoNeedId: f.n2.need.id });
    expect(lineOf(card, "Open suggestions affected")).toBe("2");
    await expectSameError(
      mergeNeeds,
      { id: f.merged.need.id, intoNeedId: f.n1.need.id },
      "conflict",
    );
    await expectSameError(mergeNeeds, { id: randomUUID(), intoNeedId: f.n1.need.id }, "not_found");
    await expectSameError(
      mergeNeeds,
      { id: f.n1.need.id, intoNeedId: f.n1.need.id },
      "validation_failed",
    );
  });

  it("undo_merge previews the signals returning and the status restored", async () => {
    const source = await insertNeed(harness.db, { signals: supporters(7) });
    const merged = await run(mergeNeeds, { id: source.need.id, intoNeedId: f.n1.need.id });

    const card = await preview(undoMerge, { id: merged.mergeId });
    expect(lineOf(card, "Signals returning")).toBe("7");
    expect(lineOf(card, "Status restored")).toBe("open");
    expect(card.needs.map((need) => [need.id, need.role])).toEqual([
      [source.need.id, "source"],
      [f.n1.need.id, "target"],
    ]);

    const result = await run(undoMerge, { id: merged.mergeId });
    expect(result.restoredSignalIds).toHaveLength(7);
    expect(result.status).toBe("open");
    await expectSameError(undoMerge, { id: merged.mergeId }, "conflict");
    await expectSameError(undoMerge, { id: randomUUID() }, "not_found");
  });

  it("split_need previews the signals leaving and the new statement", async () => {
    const statement = "Admins need single sign-on so that access is managed centrally";
    const input = { id: f.n1.need.id, signalIds: [f.n1.signals[2]!.id], statement };
    const card = await preview(splitNeed, input);
    expect(lineOf(card, "Signals leaving")).toBe("1");
    expect(lineOf(card, "Signals staying")).toBe("2");
    expect(lineOf(card, "New statement")).toBe(statement);
    expect(lineOf(card, "New need status")).toBe("open");
    expect(card.needs).toEqual([
      { id: f.n1.need.id, role: "subject", statement: f.n1.need.statement },
    ]);
    expect(card.editable.map((field) => field.key)).toEqual(["statement"]);

    const result = await run(splitNeed, input);
    expect(result.movedSignalIds).toEqual([f.n1.signals[2]!.id]);
    expect(result).toMatchObject({ statement, status: "open" });

    await expectSameError(
      splitNeed,
      { ...input, signalIds: f.n1.signals.slice(0, 2).map((s) => s.id) },
      "validation_failed",
    );
    await expectSameError(
      splitNeed,
      { ...input, id: f.merged.need.id, signalIds: [randomUUID()] },
      "conflict",
    );
    await expectSameError(splitNeed, { ...input, id: randomUUID() }, "not_found");
  });

  it("resolve_suggestion previews an accepted merge as the merge it performs", async () => {
    const input = { action: "accept", id: f.suggestions.merge.id };
    const card = await preview(resolveSuggestion, input);
    expect(lineOf(card, "Kind")).toBe("merge");
    expect(lineOf(card, "Resolution")).toBe("Accept");
    expect(lineOf(card, "Suggestion")).toBe(`Merge into: ${f.n1.need.statement}`);
    expect(lineOf(card, "Signals moving")).toBe("1");
    expect(card.needs.map((need) => [need.id, need.role])).toEqual([
      [f.draft.need.id, "source"],
      [f.n1.need.id, "target"],
    ]);
    expect(card.editable).toEqual([]);

    const result = await run(resolveSuggestion, input);
    expect(result.result?.movedSignalIds).toHaveLength(1);
  });

  it("resolve_suggestion previews an edit with the edited text, editable", async () => {
    const statement = "Board members need offline dashboards so that they prepare for meetings";
    const input = { action: "edit", edit: { statement }, id: f.suggestions.draftNeed.id };
    const card = await preview(resolveSuggestion, input);
    expect(lineOf(card, "Resolution")).toBe("Edit and accept");
    expect(lineOf(card, "Suggestion")).toBe(
      "Board members need dashboards offline so that they prepare for meetings",
    );
    expect(lineOf(card, "Applied as")).toBe(statement);
    expect(card.editable).toEqual([{ key: "edit.statement", kind: "text", label: "Statement" }]);

    const result = await run(resolveSuggestion, input);
    expect(result.result).toMatchObject({ statement, status: "open" });
    const [need] = await harness.db.select().from(needs).where(eq(needs.id, f.draft.need.id));
    expect(need!.statement).toBe(statement);
  });

  it("resolve_suggestion fails like run, and previews a rejection with its reason", async () => {
    await expectSameError(
      resolveSuggestion,
      { action: "accept", id: f.suggestions.rejected.id },
      "conflict",
    );
    await expectSameError(resolveSuggestion, { action: "accept", id: randomUUID() }, "not_found");
    await expectSameError(
      resolveSuggestion,
      { action: "edit", edit: { statement: "short" }, id: f.suggestions.draftNeed.id },
      "validation_failed",
    );
    // The merge target was merged away meanwhile: applying would conflict.
    await harness.db
      .update(needs)
      .set({ mergedIntoId: f.n2.need.id, status: "merged" })
      .where(eq(needs.id, f.n1.need.id));
    await expectSameError(
      resolveSuggestion,
      { action: "accept", id: f.suggestions.merge.id },
      "conflict",
    );

    const card = await preview(resolveSuggestion, {
      action: "reject",
      id: f.suggestions.theme.id,
      reason: "Not about reporting",
    });
    expect(lineOf(card, "Resolution")).toBe("Reject");
    expect(lineOf(card, "Reason")).toBe("Not about reporting");
    expect(lineOf(card, "Suggestion")).toBe("Theme: Reporting");
  });

  it("set_criteria previews each weight and the top needs re-ranked as run ranks them", async () => {
    const effortOnly = await insertNeed(harness.db, { scores: { effort: 5 } });
    const fitOnly = await insertNeed(harness.db, { scores: { strategic_fit: 4 } });
    const weights = { business_value: 0.1, demand: 0.1, effort: 0.6, strategic_fit: 0.2 };

    const card = await preview(setCriteria, { weights });
    expect(lineOf(card, "Demand weight")).toBe("0.4 → 0.1");
    expect(lineOf(card, "Effort weight")).toBe("0.1 → 0.6");
    expect(card.needs[0]!.id).toBe(effortOnly.need.id);
    expect(lineOf(card, "#1")).toBe(`${effortOnly.need.statement} (3, was #3)`);
    expect(card.editable.map((field) => field.key)).toEqual([
      "weights.demand",
      "weights.business_value",
      "weights.strategic_fit",
      "weights.effort",
    ]);

    await run(setCriteria, { weights });
    const ranked = await listOperatorNeeds(harness.db, { sort: "priority" });
    expect(card.needs.map((need) => need.id)).toEqual(ranked.slice(0, 5).map((need) => need.id));
    expect(ranked.map((need) => need.id).slice(0, 3)).toEqual([
      effortOnly.need.id,
      f.n1.need.id,
      fitOnly.need.id,
    ]);
  });

  it("set_strategy previews the changed fields and the needs that would become ready", async () => {
    const input = {
      capacityPerQuarter: 4,
      focusThemeIds: [f.reporting.id],
      readinessArrCents: 0,
      readinessSupporters: 3,
      revenueFocus: "mid-market retention",
    };
    const card = await preview(setStrategy, input);
    expect(card.title).toBe("Write the strategy");
    expect(lineOf(card, "Focus themes")).toBe("(none) → Reporting");
    expect(lineOf(card, "Readiness ARR")).toBe("$250,000 → $0");
    expect(lineOf(card, "Readiness supporters")).toBe("5 → 3");
    expect(lineOf(card, "Needs becoming ready")).toBe("1");
    expect(card.needs.map((need) => need.id)).toEqual([f.n1.need.id]);
    expect(card.editable.map((field) => field.key)).toEqual(["revenueFocus", "notes"]);

    const result = await run(setStrategy, input);
    expect(result.newlyReady).toBe(1);

    const again = await preview(setStrategy, input);
    expect(again.title).toBe("Update strategy (version 2)");
    expect(lineOf(again, "Needs becoming ready")).toBe("0");
    expect(again.lines.map((line) => line.label)).toEqual(["Needs becoming ready"]);

    await expectSameError(
      setStrategy,
      { ...input, focusThemeIds: [randomUUID()] },
      "validation_failed",
    );
  });

  it("publish_decision previews the status, note, and supporters notified", async () => {
    const input = { id: f.n1.need.id, note: "Planned for next quarter.", status: "planned" };
    const card = await preview(publishDecision, input);
    expect(card.blocks).toEqual([]);
    expect(lineOf(card, "Status")).toBe("open → planned");
    expect(lineOf(card, "Note")).toBe("Planned for next quarter.");
    expect(lineOf(card, "Supporters notified")).toBe("3");
    expect(card.editable.map((field) => field.key)).toEqual(["status", "note"]);
    expect(card.editable[0]!.options).toEqual(["planned", "in_progress", "shipped", "declined"]);

    const result = await run(publishDecision, input);
    expect(result.decision).toMatchObject({ needId: f.n1.need.id, status: "planned" });
    await expectSameError(publishDecision, { ...input, id: f.merged.need.id }, "conflict");
    await expectSameError(publishDecision, { ...input, id: randomUUID() }, "not_found");
  });

  it("publish_decision blocks a note that names an account", async () => {
    const card = await preview(publishDecision, {
      id: f.n1.need.id,
      note: "Acme Corp asked for this; planned.",
      status: "planned",
    });
    expect(card.blocks).toEqual([
      {
        code: "public_text_flagged",
        flags: [{ kind: "account", match: "Acme Corp" }],
        message: expect.stringContaining("Acme Corp"),
      },
    ]);
  });

  it("save_report previews create or update, blocks, and datasets", async () => {
    const input = { prompt: "weekly demand", spec: reportSpec(), title: "Weekly demand" };
    const card = await preview(saveReport, input);
    expect(card.title).toBe("Save a new report");
    expect(lineOf(card, "Action")).toBe("Create");
    expect(lineOf(card, "Blocks")).toBe("3 (1 heading, 1 text, 1 table)");
    expect(lineOf(card, "Datasets")).toBe("needs");
    expect(card.editable.map((field) => field.key)).toEqual(["title"]);

    const saved = await run(saveReport, input);
    expect(saved.created).toBe(true);
    const update = { ...input, reportId: saved.reportId, title: "Demand, weekly" };
    const updateCard = await preview(saveReport, update);
    expect(lineOf(updateCard, "Action")).toBe("Update");
    expect(lineOf(updateCard, "Title before")).toBe("Weekly demand");
    expect((await run(saveReport, update)).created).toBe(false);

    await expectSameError(saveReport, { ...input, reportId: randomUUID() }, "not_found");
    const badSpec = reportSpec();
    badSpec.blocks[2] = { ...badSpec.blocks[2], dataset: "d9" } as ReportSpec["blocks"][number];
    await expectSameError(saveReport, { ...input, spec: badSpec }, "validation_failed");
  });

  it("share_report lists identifying text as notes and stores nothing", async () => {
    const saved = await run(saveReport, {
      prompt: "renewals",
      spec: reportSpec("Acme Corp renews in March."),
      title: "Renewals",
    });
    const input = { action: "share", reportId: saved.reportId };
    const card = await preview(shareReport, input);
    expect(card.blocks).toEqual([]);
    expect(lineOf(card, "Link")).toBe("created");
    expect(lineOf(card, "Identifying text flagged")).toBe("1");
    expect(card.notes).toEqual([
      "Shows account: Acme Corp",
      "Confirming shares it anyway and acknowledges these.",
    ]);

    const unacknowledged = await run(shareReport, input);
    expect(unacknowledged).toEqual({
      flags: [{ kind: "account", match: "Acme Corp" }],
      status: "needs_acknowledgement",
    });
    const shared = await run(shareReport, { ...input, acknowledgeFlags: true });
    expect(shared).toMatchObject({ status: "shared" });

    const refresh = await preview(shareReport, { action: "refresh", reportId: saved.reportId });
    expect(lineOf(refresh, "Link")).toBe("refreshed (same link)");
    const revoke = await preview(shareReport, { action: "revoke", reportId: saved.reportId });
    expect(lineOf(revoke, "Link")).toBe("disabled");
    expect(revoke.notes).toEqual([]);

    await run(shareReport, { action: "revoke", reportId: saved.reportId });
    await expectSameError(
      shareReport,
      { action: "refresh", reportId: saved.reportId },
      "validation_failed",
    );
    await expectSameError(shareReport, { action: "share", reportId: randomUUID() }, "not_found");
  });

  it("previews only exist on the nine proposable write operations", () => {
    for (const operation of [
      mergeNeeds,
      undoMerge,
      splitNeed,
      resolveSuggestion,
      setCriteria,
      setStrategy,
      publishDecision,
      saveReport,
      shareReport,
    ] as AnyOperation[]) {
      expect(operation.effects).toBe("write");
      expect(typeof operation.preview).toBe("function");
    }
  });
});
