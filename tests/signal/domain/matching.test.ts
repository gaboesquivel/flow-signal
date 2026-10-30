import { once } from "node:events";

import { beforeEach, expect, it } from "vitest";

import {
  createFakeAi,
  createUnavailableAi,
  fakeEmbedder,
  fakeEmbedding,
  fakeExtractor,
  fakeJudge,
} from "../../../lib/signal/ai/fakes";
import type { SignalAi } from "../../../lib/signal/ai/ports";
import { embedMissingNeeds } from "../../../lib/signal/domain/embeddings";
import { events } from "../../../lib/db/schema";
import type { Actor } from "../../../lib/signal/context";
import { MATCH_THRESHOLD, previewSubmission } from "../../../lib/signal/domain/matching";
import { SignalError } from "../../../lib/signal/errors";
import { insertNeed, supporters } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

const submission = { body: "Our CEO wants the KPI dashboard in the board deck.", title: "PDF" };
const draft = {
  additionalAsks: [],
  statement: "Executives need dashboard snapshots for the board",
};

const human: Actor = { kind: "human", ref: "web" };
const clock = { now: () => new Date("2026-10-30T12:00:00Z") };

const embedded = (statement: string) => ({ embedding: fakeEmbedding(statement), statement });

describeWithDatabase("preview matching (extract → retrieve → judge)", () => {
  const harness = useTestDatabase();
  beforeEach(() => resetDatabase(harness.db));

  const preview = (ai: Partial<SignalAi>) =>
    previewSubmission(
      {
        actor: human,
        ai: createFakeAi({ extractor: fakeExtractor({ PDF: draft }), ...ai }),
        clock,
        db: harness.db,
      },
      submission,
    );

  it("judges candidates while the need is still being extracted (one model call of latency)", async () => {
    const { need } = await insertNeed(harness.db, {
      ...embedded("Executives need dashboard snapshots for the board deck"),
      signals: supporters(2),
    });
    const gate = new EventTarget();
    const extractionGate = once(gate, "release");
    let judgedBeforeExtraction = false;
    let extracted = false;
    const result = await preview({
      extractor: {
        extract: async () => {
          await extractionGate;
          extracted = true;
          return draft;
        },
      },
      judge: {
        judge: ({ candidates }) => {
          judgedBeforeExtraction = !extracted;
          gate.dispatchEvent(new Event("release"));
          return Promise.resolve(
            candidates.map(({ needId }) => ({ needId, probability: 0.9, reason: "Same need." })),
          );
        },
        model: "fake",
      },
    });

    expect(judgedBeforeExtraction).toBe(true);
    expect(result.draftNeed.statement).toBe(draft.statement);
    expect(result.matches.map((match) => match.needId)).toEqual([need.id]);
  });

  it("returns at most 3 matches at or above the threshold, most probable first", async () => {
    const needs = await Promise.all(
      [0.95, 0.7, MATCH_THRESHOLD, 0.59, 0.8].map((_, index) =>
        insertNeed(harness.db, {
          ...embedded(`Executives need dashboard snapshots variant ${index}`),
          signals: supporters(index),
        }),
      ),
    );
    const probabilities = [0.95, 0.7, MATCH_THRESHOLD, 0.59, 0.8];
    const judge = fakeJudge(
      Object.fromEntries(
        needs.map(({ need }, index) => [
          need.id,
          { probability: probabilities[index]!, reason: `reason ${index}` },
        ]),
      ),
    );

    const result = await preview({ judge });

    expect(result.ai).toBe("ok");
    expect(result.draftNeed).toEqual(draft);
    expect(result.matches.map((match) => match.needId)).toEqual([
      needs[0]!.need.id,
      needs[4]!.need.id,
      needs[1]!.need.id,
    ]);
    expect(result.matches[0]).toMatchObject({
      demandBand: "low",
      probability: 0.95,
      reason: "reason 0",
      status: "open",
      supporterCount: 0,
    });
  });

  it("includes draft needs as candidates, shown as new", async () => {
    const { need } = await insertNeed(harness.db, {
      ...embedded(draft.statement),
      status: "draft",
    });
    const result = await preview({
      judge: fakeJudge({ [need.id]: { probability: 0.9, reason: "Same need." } }),
    });
    expect(result.matches).toMatchObject([{ needId: need.id, status: "new" }]);
  });

  it("never returns merged needs or needs without an embedding until they are backfilled", async () => {
    const live = await insertNeed(harness.db, { statement: draft.statement });
    const merged = await insertNeed(harness.db, { ...embedded(draft.statement), status: "merged" });
    const judge = fakeJudge({
      [live.need.id]: { probability: 0.9, reason: "Same need." },
      [merged.need.id]: { probability: 0.9, reason: "Same need." },
    });

    expect((await preview({ judge })).matches).toEqual([]);

    await embedMissingNeeds(harness.db, fakeEmbedder());
    expect((await preview({ judge })).matches.map((match) => match.needId)).toEqual([live.need.id]);
  });

  it("passes additional asks through so the submitter can split them", async () => {
    const result = await previewSubmission(
      {
        actor: human,
        ai: createFakeAi({
          extractor: fakeExtractor({
            PDF: { ...draft, additionalAsks: ["Admins need SSO so that access is central"] },
          }),
        }),
        clock,
        db: harness.db,
      },
      submission,
    );
    expect(result.draftNeed.additionalAsks).toEqual(["Admins need SSO so that access is central"]);
  });

  it.each([
    ["extractor", { extractor: createUnavailableAi().extractor }],
    ["embedder", { embedder: createUnavailableAi().embedder }],
    ["judge", { judge: createUnavailableAi().judge }],
  ] as const)("degrades to ai: unavailable when the %s is down", async (_step, ai) => {
    await insertNeed(harness.db, embedded(draft.statement));
    const result = await preview(ai);
    expect(result.ai).toBe("unavailable");
    expect(result.matches).toEqual([]);
    expect(result.draftNeed.statement).toBeTruthy();
    expect(result.previewId).toMatch(/^pv_/u);
  });

  it("records preview.shown with the shown needs and ranks, never the text (spec 012)", async () => {
    const { need } = await insertNeed(harness.db, embedded(draft.statement));
    const result = await preview({
      judge: fakeJudge({ [need.id]: { probability: 0.9, reason: "Same need." } }),
    });
    const second = await preview({});

    const recorded = await harness.db.select().from(events);
    expect(
      recorded.map(({ actorKind, needId, payload, signalId, type }) => ({
        actorKind,
        needId,
        payload,
        signalId,
        type,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          actorKind: "human",
          needId: null,
          payload: {
            additionalAsks: 0,
            ai: "ok",
            matches: [{ needId: need.id, probability: 0.9, rank: 1 }],
            previewId: result.previewId,
          },
          signalId: null,
          type: "preview.shown",
        },
      ]),
    );
    expect(recorded).toHaveLength(2);
    expect(second.previewId).not.toBe(result.previewId);
    const stored = JSON.stringify(recorded.map((event) => event.payload));
    for (const text of [submission.title, submission.body, draft.statement, "Same need."])
      expect(stored).not.toContain(text);
  });

  it("records preview.shown when AI is unavailable", async () => {
    const result = await preview({ embedder: createUnavailableAi().embedder });
    const [event] = await harness.db.select().from(events);
    expect(event).toMatchObject({
      payload: { additionalAsks: 0, ai: "unavailable", matches: [], previewId: result.previewId },
      type: "preview.shown",
    });
  });

  it("does not hide other failures as AI outages", async () => {
    const broken = { judge: () => Promise.reject(new Error("bug")), model: "x" };
    await insertNeed(harness.db, embedded(draft.statement));
    await expect(preview({ judge: broken })).rejects.toThrow("bug");
    const notAi = {
      judge: () => Promise.reject(new SignalError("not_found", "x")),
      model: "x",
    };
    await expect(preview({ judge: notAi })).rejects.toThrow("x");
  });

  it("ignores judgements for needs that were not candidates", async () => {
    const { need } = await insertNeed(harness.db, embedded(draft.statement));
    const judge = {
      judge: () =>
        Promise.resolve([
          { needId: "4b0e6c1e-8a7d-4f3e-9c2b-1d5a6e7f8a9b", probability: 1, reason: "made up" },
          { needId: need.id, probability: 0.8, reason: "real" },
        ]),
      model: "x",
    };
    expect((await preview({ judge })).matches.map((match) => match.needId)).toEqual([need.id]);
  });
});
