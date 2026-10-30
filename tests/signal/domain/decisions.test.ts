import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import { decisions, events, needs, suggestions } from "../../../lib/db/schema";
import { createUnavailableAi } from "../../../lib/signal/ai/fakes";
import {
  applyDecisionBriefSuggestion,
  decisionBriefSuggestionSchema,
  draftDecisionBrief,
  publishDecision,
} from "../../../lib/signal/domain/decisions";
import { setStrategy } from "../../../lib/signal/domain/strategy";
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
    expect(brief.payload.recommendation).toEqual({
      capacityNote: "Takes one slot of this quarter's capacity.",
      confidence: 0.7,
      note: "Targeting Q1",
      status: "planned",
      strategyFit: { inFocus: true, reason: "Serves the strategy's focus themes." },
    });
    expect(brief.payload.strategyVersion).toBeNull();
    expect(brief.payload.markdown).toContain("- No strategy written yet.");
    expect(brief.payload.markdown).toContain("`planned` (confidence 70%)");
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

  it("drafts against the current strategy and records its version (spec 007)", async () => {
    await setStrategy(
      harness.db,
      pm,
      {
        capacityPerQuarter: 3,
        focusThemeIds: [fx.reporting.id],
        readinessArrCents: 25_000_000,
        readinessSupporters: 5,
        revenueFocus: "mid-market retention",
      },
      NOW,
    );
    let prompt = "";
    let system = "";
    const ai = fakeReasoningAi();
    const { reasoner } = ai;
    ai.reasoner = {
      generate: (input) => {
        ({ prompt } = input);
        system = input.system ?? "";
        return reasoner.generate(input);
      },
    };
    const brief = await draftDecisionBrief({ ai, db: harness.db, now: NOW }, fx.n1.need.id);
    expect(prompt).toContain("Strategy (version 1):");
    expect(prompt).toContain("- Focus themes: Reporting");
    expect(prompt).toContain("- Revenue focus: mid-market retention");
    expect(prompt).toContain("- Capacity: 3 needs per quarter");
    expect(system).toMatch(/calibrated confidence/u);
    expect(brief.payload.strategyVersion).toBe(1);
    expect(brief.payload.markdown).toContain(
      "- Strategy version 1: in focus. Serves the strategy's focus themes.",
    );
    expect(brief.payload.markdown).toContain("- Capacity: Takes one slot");
  });

  it("still reads briefs stored before spec 007", () => {
    const old = decisionBriefSuggestionSchema.parse({
      createdAt: NOW.toISOString(),
      id: "00000000-0000-4000-8000-000000000001",
      kind: "decision_brief",
      model: "anthropic/claude-sonnet-5.5",
      needId: "00000000-0000-4000-8000-000000000002",
      payload: {
        facts: {
          accounts: [],
          businessValueCents: 0,
          priorityScore: null,
          signalCount: 1,
          supporters: 1,
          supportersLast30Days: 1,
          trend: "steady",
        },
        markdown: "# Decision brief",
        options: [
          { rationale: "a", status: "planned", tradeoffs: "b" },
          { rationale: "c", status: "declined", tradeoffs: "d" },
        ],
        reason: "x",
        recommendation: { note: "Targeting Q1", status: "planned" },
      },
      status: "accepted",
    });
    expect(old.payload.recommendation).toEqual({ note: "Targeting Q1", status: "planned" });
    expect(old.payload.strategyVersion).toBeUndefined();
  });

  it("returns the need's pending brief instead of filing a second one", async () => {
    const first = await draftDecisionBrief(context(), fx.n1.need.id);
    // An Operator call right after readiness auto-drafted one (acceptance run 2026-10-30).
    const again = await draftDecisionBrief(context(), fx.n1.need.id);
    expect(again).toEqual(first);
    // Two calls racing, as readiness and an agent did 33 ms apart.
    const raced = await Promise.all([
      draftDecisionBrief(context(), fx.n2.need.id),
      draftDecisionBrief(context(), fx.n2.need.id),
    ]);
    expect(raced[1].id).toBe(raced[0].id);
    const briefs = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.kind, "decision_brief"));
    expect(briefs).toHaveLength(2);
    const created = await harness.db
      .select()
      .from(events)
      .where(eq(events.type, "suggestion.created"));
    expect(created).toHaveLength(2);
  });

  it("drafts a new brief once the pending one is resolved", async () => {
    const first = await draftDecisionBrief(context(), fx.n1.need.id);
    await harness.db
      .update(suggestions)
      .set({ resolvedAt: NOW, resolvedByKind: "human", status: "rejected" })
      .where(eq(suggestions.id, first.id));
    const second = await draftDecisionBrief(context(), fx.n1.need.id);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
  });

  it("publishing supersedes the need's remaining pending briefs and records suggestion.superseded", async () => {
    const accepted = await draftDecisionBrief(context(), fx.n1.need.id);
    await harness.db
      .update(suggestions)
      .set({ resolvedAt: NOW, resolvedByKind: "agent", status: "accepted" })
      .where(eq(suggestions.id, accepted.id));
    // A leftover pending brief on the same need, and one on another need that must stay pending.
    const leftover = await draftDecisionBrief(context(), fx.n1.need.id);
    const other = await draftDecisionBrief(context(), fx.n2.need.id);

    const decision = await publishDecision(
      { actor: pmAgent, db: harness.db, now: NOW },
      { needId: fx.n1.need.id, note: "Targeting Q1", status: "planned" },
    );

    const rows = await harness.db
      .select({
        id: suggestions.id,
        resolvedAt: suggestions.resolvedAt,
        status: suggestions.status,
      })
      .from(suggestions)
      .where(eq(suggestions.kind, "decision_brief"));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [accepted.id]: "accepted",
      [leftover.id]: "superseded",
      [other.id]: "pending",
    });
    expect(rows.find((row) => row.id === leftover.id)!.resolvedAt).toEqual(NOW);
    const superseded = await harness.db
      .select()
      .from(events)
      .where(eq(events.type, "suggestion.superseded"));
    expect(superseded).toMatchObject([
      {
        actorKind: "agent",
        needId: fx.n1.need.id,
        occurredAt: NOW,
        payload: { decisionId: decision.id, kind: "decision_brief" },
        suggestionId: leftover.id,
      },
    ]);
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
      { needId: fx.n1.need.id, note: "Not this year", status: "declined" },
    );
    expect(decision.briefMarkdown).toBe("# Edited brief");
    // Direction accuracy reads the brief's recommendation from the event log (spec 007).
    const [published] = await harness.db
      .select()
      .from(events)
      .where(eq(events.type, "decision.published"));
    expect(published!.payload).toEqual({
      briefSuggestionId: brief.id,
      decisionId: decision.id,
      recommendedStatus: "planned",
      status: "declined",
    });
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
        payload: {
          briefSuggestionId: null,
          client: "pm-copilot",
          decisionId: decision.id,
          recommendedStatus: null,
          status: "planned",
        },
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
