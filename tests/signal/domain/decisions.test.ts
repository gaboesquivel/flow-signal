import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import { decisions, events, needs, suggestions } from "../../../lib/db/schema";
import { createUnavailableAi } from "../../../lib/signal/ai/fakes";
import {
  applyDecisionBriefSuggestion,
  draftDecisionBrief,
  publishDecision,
} from "../../../lib/signal/domain/decisions";
import { getMySignals } from "../../../lib/signal/domain/my-signals";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";
import {
  buildPrioritizationFixture,
  fakeReasoningAi,
  NOW,
} from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";

const pm = { kind: "human" as const, ref: "operator" };
const pmAgent = { client: "pm-copilot", kind: "agent" as const, ref: "mcp:pm-copilot" };

describeWithDatabase("decision briefs and decisions", () => {
  const harness = useTestDatabase();
  let fx: PrioritizationFixture;
  const context = () => ({ ai: fakeReasoningAi(), db: harness.db, now: NOW });

  beforeEach(async () => {
    await resetDatabase(harness.db);
    fx = await buildPrioritizationFixture(harness.db);
  });

  it("drafts a brief from database facts plus the model's options, as a pending suggestion", async () => {
    const brief = await draftDecisionBrief(context(), fx.n1.need.id);
    expect(brief).toMatchObject({
      kind: "decision_brief",
      needId: fx.n1.need.id,
      status: "pending",
    });
    expect(brief.payload.facts).toMatchObject({
      businessValueCents: 66_000_000,
      priorityScore: 4.1,
      supporters: 6,
      supportersLast30Days: 4,
      trend: "rising",
    });
    expect(brief.payload.recommendation).toEqual({ note: "Targeting Q1", status: "planned" });
    expect(brief.payload.markdown).toContain("6 supporters (6 signals); 4 new in the last 30 days");
    expect(brief.payload.markdown).toContain("- Globex (Growth): ARR $60,000");
    expect(brief.payload.markdown).toContain("Combined ARR and open deals: $660,000");
    expect(brief.payload.markdown).toContain("**Plan it** (`planned`)");
    const created = await harness.db.select().from(events).where(eq(events.suggestionId, brief.id));
    expect(created).toMatchObject([
      { payload: { kind: "decision_brief" }, type: "suggestion.created" },
    ]);
    // A brief never publishes anything by itself.
    expect(
      await harness.db.select().from(decisions).where(eq(decisions.needId, fx.n1.need.id)),
    ).toEqual([]);
  });

  it("writes nothing when the model is unreachable", async () => {
    await expect(
      draftDecisionBrief({ ai: createUnavailableAi(), db: harness.db, now: NOW }, fx.n1.need.id),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
    expect(await harness.db.select().from(suggestions)).toEqual([]);
  });

  it("applies an edited brief and attaches the latest resolved brief to the published decision", async () => {
    const brief = await draftDecisionBrief(context(), fx.n1.need.id);
    const [row] = await harness.db.select().from(suggestions).where(eq(suggestions.id, brief.id));
    const applied = await harness.db.transaction((tx) =>
      applyDecisionBriefSuggestion(tx, { edit: { markdown: "# Edited brief" }, suggestion: row! }),
    );
    expect(applied).toEqual({ markdown: "# Edited brief", needId: fx.n1.need.id });
    // What resolve_suggestion does after the apply hook.
    await harness.db
      .update(suggestions)
      .set({ resolvedAt: NOW, resolvedByKind: "human", status: "edited" })
      .where(eq(suggestions.id, brief.id));
    const [stored] = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, brief.id));
    expect(stored!.payload).toMatchObject({
      markdown: "# Edited brief",
      originalMarkdown: brief.payload.markdown,
    });

    const decision = await publishDecision(
      { actor: pm, db: harness.db, now: NOW },
      { needId: fx.n1.need.id, note: "Targeting Q1", status: "planned" },
    );
    expect(decision.briefMarkdown).toBe("# Edited brief");
  });

  it("accepting a brief changes nothing but returns its markdown; a bad edit is rejected", async () => {
    const brief = await draftDecisionBrief(context(), fx.n1.need.id);
    const [row] = await harness.db.select().from(suggestions).where(eq(suggestions.id, brief.id));
    await expect(applyDecisionBriefSuggestion(harness.db, { suggestion: row! })).resolves.toEqual({
      markdown: brief.payload.markdown,
      needId: fx.n1.need.id,
    });
    await expect(
      applyDecisionBriefSuggestion(harness.db, { edit: { markdown: "" }, suggestion: row! }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("publishing sets the need status, writes the decision, and records decision.published by actor kind", async () => {
    const decision = await publishDecision(
      { actor: pmAgent, db: harness.db, now: NOW },
      { needId: fx.n1.need.id, note: "Targeting Q1", status: "planned" },
    );
    expect(decision).toMatchObject({ publishedByKind: "agent", status: "planned" });
    const [need] = await harness.db.select().from(needs).where(eq(needs.id, fx.n1.need.id));
    expect(need!.status).toBe("planned");
    const published = await harness.db
      .select()
      .from(events)
      .where(eq(events.type, "decision.published"));
    expect(published).toMatchObject([
      {
        actorKind: "agent",
        actorRef: "mcp:pm-copilot",
        needId: fx.n1.need.id,
        occurredAt: NOW,
        payload: { client: "pm-copilot", decisionId: decision.id, status: "planned" },
      },
    ]);
  });

  it("a draft need is approved when a decision is published on it", async () => {
    const [draft] = await harness.db
      .insert(needs)
      .values({ statement: "Teams need X so that Y", status: "draft" })
      .returning();
    await publishDecision(
      { actor: pm, db: harness.db, now: NOW },
      { needId: draft!.id, note: "Not now.", status: "declined" },
    );
    const [after] = await harness.db.select().from(needs).where(eq(needs.id, draft!.id));
    expect(after).toMatchObject({ approvedAt: NOW, status: "declined" });
  });

  it("a failed publish writes no decision and no event", async () => {
    await expect(
      publishDecision(
        { actor: pm, db: harness.db, now: NOW },
        { needId: fx.merged.need.id, note: "x", status: "planned" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await harness.db.select().from(decisions)).toEqual([]);
    expect(
      await harness.db.select().from(events).where(eq(events.type, "decision.published")),
    ).toEqual([]);
  });

  it("the note reaches every supporter through get_my_signals", async () => {
    await publishDecision(
      { actor: pm, db: harness.db, now: NOW },
      { needId: fx.n1.need.id, note: "Targeting Q1", status: "planned" },
    );
    expect(fx.n1.signals).toHaveLength(6);
    for (const signal of fx.n1.signals) {
      const mine = await getMySignals(harness.db, signal.trackingToken);
      expect(mine?.signals).toHaveLength(1);
      const [view] = mine!.signals;
      expect(view!.need).toMatchObject({ id: fx.n1.need.id, status: "planned" });
      expect(view!.decisions).toEqual([
        { note: "Targeting Q1", publishedAt: NOW.toISOString(), status: "planned" },
      ]);
    }
  });
});
