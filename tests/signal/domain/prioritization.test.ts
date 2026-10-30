import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { events, priorityCriteria, priorityScores, suggestions } from "../../../lib/db/schema";
import { createUnavailableAi } from "../../../lib/signal/ai/fakes";
import {
  criteriaWeightsSchema,
  defaultCriteria,
  readCriteria,
  writeCriteria,
} from "../../../lib/signal/domain/criteria";
import { demandSummary } from "../../../lib/signal/domain/demand";
import { trendOf } from "../../../lib/signal/domain/need-facts";
import {
  applyPrioritySuggestion,
  suggestPriorityScores,
} from "../../../lib/signal/domain/priority";
import type { SignalDb } from "../../../lib/signal/db";
import { getPublicNeed } from "../../../lib/signal/domain/public-needs";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";
import {
  buildPrioritizationFixture,
  daysAgo,
  fakeReasoningAi,
  NOW,
} from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";

describe("trendOf", () => {
  it("is rising above +20%, falling below −20%, otherwise steady", () => {
    expect(trendOf(13, 10)).toBe("rising");
    expect(trendOf(12, 10)).toBe("steady");
    expect(trendOf(8, 10)).toBe("steady");
    expect(trendOf(7, 10)).toBe("falling");
    expect(trendOf(1, 0)).toBe("rising");
    expect(trendOf(0, 0)).toBe("steady");
  });
});

describe("criteriaWeightsSchema", () => {
  it("needs every key, each 0–1, summing to 1 (with float tolerance)", () => {
    const ok = { business_value: 0.2, demand: 0.1, effort: 0.4, strategic_fit: 0.3 };
    expect(criteriaWeightsSchema.safeParse(ok).success).toBe(true);
    expect(criteriaWeightsSchema.safeParse({ ...ok, demand: 0.2 }).success).toBe(false);
    expect(criteriaWeightsSchema.safeParse({ ...ok, demand: undefined }).success).toBe(false);
    expect(criteriaWeightsSchema.safeParse({ ...ok, other: 0 }).success).toBe(false);
    expect(
      criteriaWeightsSchema.safeParse({
        business_value: 0,
        demand: 1.5,
        effort: -0.5,
        strategic_fit: 0,
      }).success,
    ).toBe(false);
  });
});

const scoresOf = (db: SignalDb, needId: string) =>
  db
    .select({
      criterion: priorityScores.criterion,
      reason: priorityScores.reason,
      score: priorityScores.score,
      source: priorityScores.source,
    })
    .from(priorityScores)
    .where(eq(priorityScores.needId, needId))
    .orderBy(priorityScores.criterion);

describeWithDatabase("prioritization", () => {
  const harness = useTestDatabase();
  let fx: PrioritizationFixture;
  const context = () => ({ ai: fakeReasoningAi(), db: harness.db, now: NOW });

  beforeEach(async () => {
    await resetDatabase(harness.db);
    fx = await buildPrioritizationFixture(harness.db);
  });

  describe("criteria", () => {
    it("falls back to the default criteria when none are stored", async () => {
      await harness.db.delete(priorityCriteria);
      expect((await readCriteria(harness.db)).criteria).toEqual(defaultCriteria);
    });

    it("stores new weights and reads them back exactly, keeping descriptions", async () => {
      const weights = { business_value: 0.35, demand: 0.35, effort: 0.1, strategic_fit: 0.2 };
      const result = await writeCriteria(harness.db, weights);
      expect(Object.fromEntries(result.criteria.map((row) => [row.key, row.weight]))).toEqual(
        weights,
      );
      expect(result.criteria[0]!.description).toBe("Supporters, weighted by account.");
      expect(await readCriteria(harness.db)).toEqual(result);
    });
  });

  describe("AI priority scoring", () => {
    it("files a pending priority suggestion with a score and reason per criterion", async () => {
      const { refreshed, suggestion } = await suggestPriorityScores(context(), fx.n3.need.id);
      expect(refreshed).toBe(false);
      expect(suggestion).toMatchObject({
        kind: "priority",
        model: "fake/reasoner",
        needId: fx.n3.need.id,
        status: "pending",
      });
      expect(suggestion.payload).toEqual({
        reason: "Business value raised: Acme Corp (ARR $480,000) joined.",
        reasons: {
          business_value: "Acme Corp ARR $480,000 asks for it.",
          demand: "Six supporters, rising.",
          effort: "Moderate.",
          strategic_fit: "Reporting is a focus theme.",
        },
        scores: { business_value: 5, demand: 4, effort: 2, strategic_fit: 4 },
      });
      const created = await harness.db
        .select()
        .from(events)
        .where(eq(events.suggestionId, suggestion.id));
      expect(created).toMatchObject([
        { actorKind: "agent", payload: { kind: "priority" }, type: "suggestion.created" },
      ]);
      // Nothing is scored until a PM resolves it.
      const scores = await harness.db
        .select()
        .from(priorityScores)
        .where(eq(priorityScores.needId, fx.n3.need.id));
      expect(scores).toEqual([]);
    });

    it("refreshes the pending suggestion instead of adding a second one", async () => {
      const first = await suggestPriorityScores(context(), fx.n3.need.id);
      const second = await suggestPriorityScores(context(), fx.n3.need.id);
      expect(second).toMatchObject({ refreshed: true, suggestion: { id: first.suggestion.id } });
      const rows = await harness.db
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.needId, fx.n3.need.id), eq(suggestions.kind, "priority")));
      expect(rows).toHaveLength(1);
    });

    it("gives the facts the model needs to cite accounts and revenue", async () => {
      let prompt = "";
      const ai = fakeReasoningAi();
      const { reasoner } = ai;
      ai.reasoner = {
        generate: (input) => {
          ({ prompt } = input);
          return reasoner.generate(input);
        },
      };
      await suggestPriorityScores({ ai, db: harness.db, now: NOW }, fx.n1.need.id);
      expect(prompt).toContain("Acme Corp (Enterprise): ARR $480,000, open deals $120,000");
      expect(prompt).toContain("Supporters: 6 people");
      expect(prompt).toContain('"monthly board deck"');
      expect(prompt).not.toContain("maya@acme.example");
      expect(prompt).not.toContain("Maya Lindqvist");
      expect(prompt).toContain("Strategy: none written yet");
    });

    it("fails with ai_unavailable and writes nothing when the model is unreachable", async () => {
      await expect(
        suggestPriorityScores(
          { ai: createUnavailableAi(), db: harness.db, now: NOW },
          fx.n3.need.id,
        ),
      ).rejects.toMatchObject({ code: "ai_unavailable" });
      expect(await harness.db.select().from(suggestions)).toEqual([]);
    });

    it("refuses to score a merged need", async () => {
      await expect(suggestPriorityScores(context(), fx.merged.need.id)).rejects.toMatchObject({
        code: "conflict",
      });
    });
  });

  describe("applyPrioritySuggestion", () => {
    it("accepting stores every AI score with its reason and source ai", async () => {
      const { suggestion } = await suggestPriorityScores(context(), fx.n3.need.id);
      const applied = await harness.db.transaction((tx) =>
        applyPrioritySuggestion(tx, { now: NOW, suggestion }),
      );
      expect(applied.scores.every((score) => score.source === "ai")).toBe(true);
      expect(await scoresOf(harness.db, fx.n3.need.id)).toEqual([
        { criterion: "demand", reason: "Six supporters, rising.", score: 4, source: "ai" },
        {
          criterion: "business_value",
          reason: "Acme Corp ARR $480,000 asks for it.",
          score: 5,
          source: "ai",
        },
        {
          criterion: "strategic_fit",
          reason: "Reporting is a focus theme.",
          score: 4,
          source: "ai",
        },
        { criterion: "effort", reason: "Moderate.", score: 2, source: "ai" },
      ]);
      // The need is now scored: 0.4·4 + 0.3·5 + 0.2·4 + 0.1·2 = 4.1 → high demand band.
      expect((await getPublicNeed(harness.db, fx.n3.need.id))?.demandBand).toBe("high");
    });

    it("an edit stores the PM's scores with source pm (overriding earlier scores)", async () => {
      const { suggestion } = await suggestPriorityScores(context(), fx.n1.need.id);
      await harness.db.transaction((tx) =>
        applyPrioritySuggestion(tx, {
          edit: {
            reasons: { effort: "Needs a rendering service." },
            scores: { business_value: 3, effort: 1 },
          },
          now: NOW,
          suggestion,
        }),
      );
      const rows = await scoresOf(harness.db, fx.n1.need.id);
      expect(rows.find((row) => row.criterion === "effort")).toEqual({
        criterion: "effort",
        reason: "Needs a rendering service.",
        score: 1,
        source: "pm",
      });
      expect(rows.find((row) => row.criterion === "business_value")).toMatchObject({
        reason: "Set by PM (AI suggested 5).",
        score: 3,
        source: "pm",
      });
      expect(rows.find((row) => row.criterion === "demand")).toMatchObject({ source: "ai" });
    });

    it("rejects a malformed edit and a merged need", async () => {
      const { suggestion } = await suggestPriorityScores(context(), fx.n1.need.id);
      await expect(
        applyPrioritySuggestion(harness.db, {
          edit: { scores: { demand: 9 } },
          now: NOW,
          suggestion,
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
      await expect(
        applyPrioritySuggestion(harness.db, {
          now: NOW,
          suggestion: { ...suggestion, needId: fx.merged.need.id },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        applyPrioritySuggestion(harness.db, {
          now: NOW,
          suggestion: { ...suggestion, kind: "theme" },
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    });
  });

  describe("demand summary", () => {
    const filter = { limit: 10, since: daysAgo(90), until: NOW };

    it("returns the numbers with summary null and ai unavailable when the model is down", async () => {
      const result = await demandSummary({ ai: createUnavailableAi(), db: harness.db }, filter);
      expect(result.ai).toBe("unavailable");
      expect(result.summary).toBeNull();
      expect(result.needs.map((need) => [need.needId, need.supporters, need.trend])).toEqual([
        [fx.n1.need.id, 6, "rising"],
        [fx.n2.need.id, 5, "falling"],
        [fx.n3.need.id, 4, "steady"],
      ]);
    });

    it("scores with the current weights and breaks ties by supporters", async () => {
      // All weight on effort: N1 and N2 both score 2, so supporters break the tie (N1 has more).
      await writeCriteria(harness.db, {
        business_value: 0,
        demand: 0,
        effort: 1,
        strategic_fit: 0,
      });
      const result = await demandSummary({ ai: fakeReasoningAi(), db: harness.db }, filter);
      expect(result.needs.map((need) => need.priorityScore)).toEqual([2, 2, null]);
      expect(result.ai).toBe("ok");
    });

    it("leaves out merged, shipped, and declined needs", async () => {
      const result = await demandSummary({ ai: fakeReasoningAi(), db: harness.db }, filter);
      const ids = result.needs.map((need) => need.needId);
      for (const excluded of [fx.merged, fx.declined, fx.outage])
        expect(ids).not.toContain(excluded.need.id);
    });
  });
});
