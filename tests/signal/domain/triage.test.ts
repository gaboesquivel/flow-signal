import { asc, eq, inArray } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import {
  events,
  merges,
  needs,
  priorityScores,
  proposedSolutions,
  signals,
  suggestions,
} from "../../../lib/db/schema";
import { createFakeAi } from "../../../lib/signal/ai/fakes";
import type { Actor, OperationContext } from "../../../lib/signal/context";
import { getPublicNeed } from "../../../lib/signal/domain/public-needs";
import { mergeNeeds, undoMerge } from "../../../lib/signal/domain/merges";
import { splitNeed } from "../../../lib/signal/domain/splits";
import { resolveSuggestion } from "../../../lib/signal/domain/suggestions";
import { suggestionKindHandlers } from "../../../lib/signal/domain/suggestion-kinds";
import { insertNeed } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";
import { buildTriageFixture } from "../support/triage-fixture";
import type { TriageFixture } from "../support/triage-fixture";

const pm: Actor = { kind: "human", ref: "operator" };
const copilot: Actor = { client: "pm-copilot", kind: "agent", ref: "mcp:pm-copilot" };
const now = new Date("2026-10-30T09:00:00Z");

describeWithDatabase("PM triage", () => {
  const harness = useTestDatabase();
  let f: TriageFixture;

  const ctx = (actor: Actor = pm): OperationContext => ({
    actor,
    ai: createFakeAi(),
    clock: { now: () => now },
    db: harness.db,
  });
  const needOf = async (id: string) =>
    (await harness.db.select().from(needs).where(eq(needs.id, id)))[0]!;
  const signalNeeds = async (ids: string[]) =>
    Object.fromEntries(
      (
        await harness.db
          .select({ id: signals.id, needId: signals.needId })
          .from(signals)
          .where(inArray(signals.id, ids))
      ).map((row) => [row.id, row.needId]),
    );
  const eventsOf = (type: string) =>
    harness.db.select().from(events).where(eq(events.type, type)).orderBy(asc(events.occurredAt));

  beforeEach(async () => {
    await resetDatabase(harness.db);
    f = await buildTriageFixture(harness.db);
  });

  it("merges every signal and undoes the merge exactly", async () => {
    const source = await insertNeed(harness.db, {
      signals: [{}, {}],
      solutions: [],
      status: "open",
    });
    const [solution] = await harness.db
      .insert(proposedSolutions)
      .values({ needId: source.need.id, sourceSignalId: source.signals[0]!.id, text: "PDF export" })
      .returning();
    const ids = source.signals.map((s) => s.id);
    const total = (await harness.db.select().from(signals)).length;

    const merge = await harness.db.transaction((tx) =>
      mergeNeeds(tx, { actor: pm, fromNeedId: source.need.id, intoNeedId: f.n1.need.id, now }),
    );
    expect(merge.movedSignalIds.toSorted()).toEqual(ids.toSorted());
    expect(Object.values(await signalNeeds(ids))).toEqual([f.n1.need.id, f.n1.need.id]);
    expect(await needOf(source.need.id)).toMatchObject({
      mergedIntoId: f.n1.need.id,
      status: "merged",
    });
    const [moved] = await harness.db
      .select()
      .from(proposedSolutions)
      .where(eq(proposedSolutions.id, solution!.id));
    expect(moved!.needId).toBe(f.n1.need.id);
    const [merged] = await eventsOf("need.merged");
    expect(merged).toMatchObject({
      actorKind: "human",
      needId: source.need.id,
      payload: { intoNeedId: f.n1.need.id, mergeId: merge.mergeId },
    });

    const undone = await harness.db.transaction((tx) =>
      undoMerge(tx, { actor: pm, mergeId: merge.mergeId, now }),
    );
    expect(undone.status).toBe("open");
    expect(Object.values(await signalNeeds(ids))).toEqual([source.need.id, source.need.id]);
    expect(await needOf(source.need.id)).toMatchObject({ mergedIntoId: null, status: "open" });
    const [back] = await harness.db
      .select()
      .from(proposedSolutions)
      .where(eq(proposedSolutions.id, solution!.id));
    expect(back!.needId).toBe(source.need.id);
    const [mergeRow] = await harness.db.select().from(merges).where(eq(merges.id, merge.mergeId));
    expect(mergeRow!.undoneAt).toEqual(now);
    const [undoEvent] = await eventsOf("merge.undone");
    expect(undoEvent).toMatchObject({
      needId: source.need.id,
      payload: { intoNeedId: f.n1.need.id, mergeId: merge.mergeId },
    });
    expect((await harness.db.select().from(signals)).length).toBe(total);
  });

  it("refuses to merge a merged need and to undo out of order", async () => {
    await expect(
      harness.db.transaction((tx) =>
        mergeNeeds(tx, { actor: pm, fromNeedId: f.merged.need.id, intoNeedId: f.n1.need.id, now }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    const first = await harness.db.transaction((tx) =>
      mergeNeeds(tx, { actor: pm, fromNeedId: f.draft.need.id, intoNeedId: f.n2.need.id, now }),
    );
    await harness.db.transaction((tx) =>
      mergeNeeds(tx, { actor: pm, fromNeedId: f.n2.need.id, intoNeedId: f.n1.need.id, now }),
    );
    await expect(
      harness.db.transaction((tx) => undoMerge(tx, { actor: pm, mergeId: first.mergeId, now })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await eventsOf("merge.undone")).toHaveLength(0);
  });

  it("splits signals into a new need and records need.created", async () => {
    const moved = f.n1.signals[2]!.id;
    const result = await harness.db.transaction((tx) =>
      splitNeed(tx, {
        actor: copilot,
        needId: f.n1.need.id,
        now,
        signalIds: [moved],
        statement: "Admins need single sign-on so that access is managed centrally",
      }),
    );
    expect(await signalNeeds([moved])).toEqual({ [moved]: result.needId });
    expect(await needOf(result.needId)).toMatchObject({
      status: "open",
      themeId: f.reporting.id,
    });
    const created = (await eventsOf("need.created")).filter((e) => e.needId === result.needId);
    expect(created).toEqual([expect.objectContaining({ actorKind: "agent", signalId: moved })]);
    const [split] = await eventsOf("need.split");
    expect(split).toMatchObject({
      needId: f.n1.need.id,
      payload: { newNeedId: result.needId, signalIds: [moved] },
    });
  });

  it("records each resolution with the resolver's actor kind", async () => {
    await resolveSuggestion(ctx(pm), { action: "accept", id: f.suggestions.merge.id });
    await resolveSuggestion(ctx(copilot), {
      action: "edit",
      edit: { summary: "Leaders bring current numbers to board meetings." },
      id: f.suggestions.summary.id,
    });
    await resolveSuggestion(ctx(pm), { action: "reject", id: f.suggestions.theme.id });

    const resolutions = (await harness.db.select().from(events)).filter((e) =>
      ["suggestion.accepted", "suggestion.edited", "suggestion.rejected"].includes(e.type),
    );
    expect(
      resolutions
        .map((e) => [e.type, e.actorKind, e.suggestionId, e.payload.kind])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["suggestion.accepted", "human", f.suggestions.merge.id, "merge"],
      ["suggestion.edited", "agent", f.suggestions.summary.id, "public_summary"],
      ["suggestion.rejected", "human", f.suggestions.theme.id, "theme"],
    ]);
    const [edited] = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, f.suggestions.summary.id));
    expect(edited).toMatchObject({ resolvedAt: now, resolvedByKind: "agent", status: "edited" });
    expect(edited!.payload.edit).toEqual({
      summary: "Leaders bring current numbers to board meetings.",
    });
    expect(await needOf(f.draft.need.id)).toMatchObject({ status: "merged" });
    await expect(
      resolveSuggestion(ctx(pm), { action: "accept", id: f.suggestions.merge.id }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("never shows a public summary until a PM approves it", async () => {
    await harness.db
      .update(needs)
      .set({ publicSummary: "Acme's board meets monthly", publicSummaryStatus: "pending" })
      .where(eq(needs.id, f.n1.need.id));
    expect((await getPublicNeed(harness.db, f.n1.need.id))!.publicSummary).toBeNull();

    await resolveSuggestion(ctx(), { action: "reject", id: f.suggestions.summary.id });
    expect((await getPublicNeed(harness.db, f.n1.need.id))!.publicSummary).toBeNull();
    expect(await needOf(f.n1.need.id)).toMatchObject({ publicSummaryStatus: "none" });
  });

  it("publishes an accepted public summary", async () => {
    await resolveSuggestion(ctx(), { action: "accept", id: f.suggestions.summary.id });
    expect((await getPublicNeed(harness.db, f.n1.need.id))!.publicSummary).toBe(
      "Leaders bring current KPI snapshots into recurring board meetings.",
    );
  });

  it("rolls back the resolution when applying the suggestion fails", async () => {
    await harness.db.transaction((tx) =>
      mergeNeeds(tx, { actor: pm, fromNeedId: f.n1.need.id, intoNeedId: f.n2.need.id, now }),
    );
    await expect(
      resolveSuggestion(ctx(), { action: "accept", id: f.suggestions.merge.id }),
    ).rejects.toMatchObject({ code: "conflict" });
    const [row] = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, f.suggestions.merge.id));
    expect(row!.status).toBe("pending");
    expect(await eventsOf("suggestion.accepted")).toHaveLength(0);
  });

  it("approves a draft need with an edited statement and assigns themes", async () => {
    const draft = await resolveSuggestion(ctx(), {
      action: "edit",
      edit: {
        statement: "Board members need offline dashboards so that they prepare for meetings",
      },
      id: f.suggestions.draftNeed.id,
    });
    expect(draft.result).toMatchObject({ needId: f.draft.need.id, status: "open" });
    const need = await needOf(f.draft.need.id);
    expect(need.statement).toBe(
      "Board members need offline dashboards so that they prepare for meetings",
    );
    expect(need.approvedAt).toEqual(now);
    expect(need.embedding).not.toBeNull();

    await resolveSuggestion(ctx(), {
      action: "edit",
      edit: { themeName: "Compliance" },
      id: f.suggestions.theme.id,
    });
    const n2 = await needOf(f.n2.need.id);
    expect(n2.themeId).not.toBe(f.reporting.id);
    expect(n2.themeId).not.toBeNull();
  });

  it("resolves task 05's priority and decision_brief kinds through the same path", async () => {
    await resolveSuggestion(ctx(pm), { action: "accept", id: f.suggestions.priority.id });
    const scores = await harness.db
      .select()
      .from(priorityScores)
      .where(eq(priorityScores.needId, f.n2.need.id));
    expect(scores.map((s) => [s.criterion, s.score, s.source]).toSorted()).toEqual([
      ["business_value", 2, "ai"],
      ["demand", 1, "ai"],
    ]);
    await resolveSuggestion(ctx(copilot), {
      action: "edit",
      edit: { markdown: "Plan for Q1." },
      id: f.suggestions.brief.id,
    });
    const [brief] = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, f.suggestions.brief.id));
    expect(brief).toMatchObject({
      payload: { edit: { markdown: "Plan for Q1." }, markdown: "Plan for Q1." },
      resolvedByKind: "agent",
      status: "edited",
    });
    const kinds = (await harness.db.select().from(events))
      .filter((e) => e.type === "suggestion.accepted" || e.type === "suggestion.edited")
      .map((e) => [e.type, e.payload.kind, e.actorKind])
      .toSorted();
    expect(kinds).toEqual([
      ["suggestion.accepted", "priority", "human"],
      ["suggestion.edited", "decision_brief", "agent"],
    ]);
    expect(suggestionKindHandlers.decision_brief?.edit).toBeDefined();
    await expect(
      resolveSuggestion(ctx(), { action: "edit", edit: { x: 1 }, id: f.suggestions.split.id }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
