import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import { accounts, events, needs, signals, submitters } from "../../../lib/db/schema";
import {
  createFakeAi,
  createUnavailableAi,
  fakeEmbedder,
  fakeEmbedding,
} from "../../../lib/signal/ai/fakes";
import type { SignalAi } from "../../../lib/signal/ai/ports";
import { recordEvent } from "../../../lib/signal/events";
import type { Actor } from "../../../lib/signal/context";
import { embedNeeds, embedMissingNeeds } from "../../../lib/signal/domain/embeddings";
import { EXPOSURE_WINDOW_MS } from "../../../lib/signal/domain/exposure";
import { getMySignals } from "../../../lib/signal/domain/my-signals";
import { submitSignal } from "../../../lib/signal/domain/submissions";
import type { SubmitInput } from "../../../lib/signal/domain/submissions";
import { insertAccount, insertNeed, insertSubmitter } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

const human: Actor = { kind: "human", ref: "web" };
const agent: Actor = { client: "support-copilot", kind: "agent", ref: "mcp:support-copilot" };
const now = new Date("2026-10-30T12:00:00Z");

const input = (overrides: Partial<SubmitInput> & Pick<SubmitInput, "target">): SubmitInput => ({
  body: "Our CEO wants the KPI dashboard in the board deck every month.",
  email: "maya@acme.example",
  idempotencyKey: "key-0001",
  title: "Export dashboards to PDF",
  ...overrides,
});

describeWithDatabase("submit_signal domain", () => {
  const harness = useTestDatabase();
  beforeEach(() => resetDatabase(harness.db));

  const submit = (value: SubmitInput, actor: Actor = human, ai: SignalAi = createFakeAi()) =>
    submitSignal({ actor, ai, clock: { now: () => now }, db: harness.db }, value);

  const allEvents = () => harness.db.select().from(events).orderBy(asc(events.type));
  const allSignals = () => harness.db.select().from(signals);

  it("adds a voice to an existing need, keeping the submitter's words verbatim", async () => {
    const { need } = await insertNeed(harness.db);
    const result = await submit(
      input({
        name: "Maya",
        target: { needId: need.id },
        urgency: "high",
        useCase: "monthly board deck",
      }),
    );

    expect(result).toMatchObject({ attachedTo: "existing", needId: need.id });
    const [signal] = await allSignals();
    expect(signal).toMatchObject({
      actorKind: "human",
      agentClient: null,
      attachedTo: "existing",
      body: "Our CEO wants the KPI dashboard in the board deck every month.",
      channel: "web",
      needId: need.id,
      originalNeedId: need.id,
      title: "Export dashboards to PDF",
      urgency: "high",
      useCase: "monthly board deck",
    });
    expect(result.trackingUrl.endsWith(`/my/${signal!.trackingToken}`)).toBe(true);
    expect(signal!.trackingToken).toMatch(/^[\w-]{32}$/u);

    const recorded = await allEvents();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorKind: "human",
      dedupeKey: "signal.created:key-0001",
      needId: need.id,
      payload: { attachedTo: "existing", hasUseCase: true },
      signalId: result.signalId,
      type: "signal.created",
    });
  });

  it('"none of these" creates an embedded draft need and records need.created', async () => {
    const statement = "Night-shift staff need a dark theme so that screens do not strain eyes";
    const result = await submit(
      input({ previewId: "pv_abc", target: { newNeed: { statement } } }),
      agent,
    );

    expect(result.attachedTo).toBe("draft");
    const [need] = await harness.db.select().from(needs).where(eq(needs.id, result.needId));
    expect(need).toMatchObject({ statement, status: "draft" });
    expect(need!.embedding).toEqual(
      fakeEmbedding(statement).map((value) => expect.closeTo(value, 5)),
    );

    const [signal] = await allSignals();
    expect(signal).toMatchObject({
      actorKind: "agent",
      agentClient: "support-copilot",
      attachedTo: "draft",
      channel: "mcp",
    });
    const recorded = await allEvents();
    expect(recorded.map((event) => [event.type, event.actorKind, event.payload])).toEqual([
      ["need.created", "agent", { client: "support-copilot", source: "submission" }],
      [
        "signal.created",
        "agent",
        {
          attachedTo: "draft",
          client: "support-copilot",
          exposure: { kind: "unknown", previewId: "pv_abc" },
          hasUseCase: false,
          previewId: "pv_abc",
        },
      ],
    ]);
  });

  it("still creates the draft need when the embedder is down, for the backfill to embed", async () => {
    const statement = "Admins need audit logs so that access reviews are fast";
    const result = await submit(
      input({ target: { newNeed: { statement } } }),
      human,
      createUnavailableAi(),
    );
    const [need] = await harness.db.select().from(needs).where(eq(needs.id, result.needId));
    expect(need!.embedding).toBeNull();

    expect(await embedMissingNeeds(harness.db, fakeEmbedder())).toBe(1);
    expect(await embedMissingNeeds(harness.db, fakeEmbedder())).toBe(0);
  });

  it("returns the same signal for a retry and counts it once", async () => {
    const { need } = await insertNeed(harness.db);
    const first = await submit(input({ target: { needId: need.id } }));
    const retry = await submit(input({ email: " MAYA@acme.example", target: { needId: need.id } }));

    expect(first.replayed).toBe(false);
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await allSignals()).toHaveLength(1);
    expect(await allEvents()).toHaveLength(1);
  });

  it("counts concurrent retries once", async () => {
    const statement = "Teams need shared folders so that reports are easy to find";
    const results = await Promise.all(
      [0, 1, 2].map(() => submit(input({ target: { newNeed: { statement } } }))),
    );
    expect(new Set(results.map((result) => result.signalId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await allSignals()).toHaveLength(1);
    expect(await harness.db.select().from(needs)).toHaveLength(1);
    expect((await allEvents()).map((event) => event.type)).toEqual([
      "need.created",
      "signal.created",
    ]);
  });

  it("rejects reusing a key for different content and writes nothing", async () => {
    const { need } = await insertNeed(harness.db);
    await submit(input({ target: { needId: need.id } }));
    await expect(
      submit(input({ body: "Something else", target: { needId: need.id } })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await allEvents()).toHaveLength(1);
  });

  it("writes nothing when the target need does not exist", async () => {
    await expect(
      submit(input({ target: { needId: "4b0e6c1e-8a7d-4f3e-9c2b-1d5a6e7f8a9b" } })),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await allSignals()).toEqual([]);
    expect(await allEvents()).toEqual([]);
    expect(await harness.db.select().from(submitters)).toEqual([]);
  });

  it("follows merges to the live need", async () => {
    const live = await insertNeed(harness.db);
    const middle = await insertNeed(harness.db, { mergedIntoId: live.need.id, status: "merged" });
    const gone = await insertNeed(harness.db, { mergedIntoId: middle.need.id, status: "merged" });
    const result = await submit(input({ target: { needId: gone.need.id } }));
    expect(result.needId).toBe(live.need.id);
  });

  it("reuses the submitter by email and links a known company's account", async () => {
    const acme = await insertAccount(harness.db, { name: "Acme Corp", plan: "Enterprise" });
    const existing = await insertSubmitter(harness.db, { email: "maya@acme.example", name: null });
    const { need } = await insertNeed(harness.db);

    await submit(input({ company: "acme corp", name: "Maya", target: { needId: need.id } }));
    await submit(
      input({
        company: "Another Co",
        idempotencyKey: "key-0002",
        name: "Someone Else",
        target: { needId: need.id },
      }),
    );

    const rows = await harness.db.select().from(submitters);
    expect(rows).toEqual([{ ...existing, accountId: acme.id, name: "Maya" }]);
    expect((await harness.db.select().from(accounts)).map((row) => row.name).toSorted()).toEqual([
      "Acme Corp",
      "Another Co",
    ]);
  });

  it("shows the holder their signal through the tracking token, after a merge too", async () => {
    const live = await insertNeed(harness.db);
    const { need } = await insertNeed(harness.db);
    const result = await submit(input({ target: { needId: need.id } }));
    const [signal] = await allSignals();
    // A PM merges the need (task 04 moves the signals); the link follows the signal.
    await harness.db.update(signals).set({ needId: live.need.id });
    await harness.db
      .update(needs)
      .set({ mergedIntoId: live.need.id, status: "merged" })
      .where(eq(needs.id, need.id));

    const mine = await getMySignals(harness.db, signal!.trackingToken);
    expect(mine?.signals).toHaveLength(1);
    expect(mine?.signals[0]).toMatchObject({
      attachedTo: "existing",
      need: { id: live.need.id, status: "open", supporterCount: 1 },
      signalId: result.signalId,
    });
    expect(await getMySignals(harness.db, "unknown-token-000000000")).toBeUndefined();
  });

  it("re-embeds a need after its statement changes", async () => {
    const { need } = await insertNeed(harness.db, {
      embedding: fakeEmbedding("old words"),
      statement: "old words",
    });
    await harness.db
      .update(needs)
      .set({ statement: "brand new statement" })
      .where(eq(needs.id, need.id));
    expect(await embedNeeds(harness.db, fakeEmbedder(), [need.id])).toBe(1);
    const [row] = await harness.db.select().from(needs).where(eq(needs.id, need.id));
    expect(row!.embedding).toEqual(
      fakeEmbedding("brand new statement").map((value) => expect.closeTo(value, 5)),
    );
  });

  // Match exposure (spec 012).
  const shown = (previewId: string, needIds: string[], occurredAt = now) =>
    recordEvent(harness.db, {
      actor: human,
      dedupeKey: `preview.shown:${previewId}`,
      occurredAt,
      payload: {
        additionalAsks: 0,
        ai: "ok",
        matches: needIds.map((needId, index) => ({ needId, probability: 0.9, rank: index + 1 })),
        previewId,
      },
      type: "preview.shown",
    });

  const exposureOf = async (signalId: string) => {
    const [event] = await harness.db
      .select()
      .from(events)
      .where(and(eq(events.signalId, signalId), eq(events.type, "signal.created")));
    return (event!.payload as { exposure: unknown }).exposure;
  };

  it.each([1, 2, 3])("records rank %i when the submitter picks that shown need", async (rank) => {
    const shownNeeds = [
      await insertNeed(harness.db),
      await insertNeed(harness.db),
      await insertNeed(harness.db),
    ].map(({ need }) => need.id);
    await shown("pv_ranked", shownNeeds);
    const result = await submit(
      input({ previewId: "pv_ranked", target: { needId: shownNeeds[rank - 1]! } }),
    );
    expect(await exposureOf(result.signalId)).toEqual({
      chosenRank: rank,
      kind: "shown",
      previewId: "pv_ranked",
      shownNeedIds: shownNeeds,
    });
  });

  it("records a null rank for a new need and for a need that was not shown", async () => {
    const { need: shownNeed } = await insertNeed(harness.db);
    const { need: elsewhere } = await insertNeed(harness.db);
    await shown("pv_new", [shownNeed.id]);
    const fresh = await submit(
      input({
        previewId: "pv_new",
        target: { newNeed: { statement: "Admins need audit logs so that reviews are fast" } },
      }),
    );
    const other = await submit(
      input({
        idempotencyKey: "key-0002",
        previewId: "pv_new",
        target: { needId: elsewhere.id },
      }),
    );
    for (const signalId of [fresh.signalId, other.signalId])
      expect(await exposureOf(signalId)).toMatchObject({ chosenRank: null, kind: "shown" });
  });

  it("records the rank of the shown need a merged-away target resolves to", async () => {
    const { need: live } = await insertNeed(harness.db);
    const { need: stale } = await insertNeed(harness.db, {
      mergedIntoId: live.id,
      status: "merged",
    });
    await shown("pv_stale_target", [randomUUID(), live.id]);
    const result = await submit(
      input({ previewId: "pv_stale_target", target: { needId: stale.id } }),
    );
    expect(await exposureOf(result.signalId)).toMatchObject({ chosenRank: 2, kind: "shown" });
  });

  it("records none_shown, skipped, and unknown without failing the submission", async () => {
    const { need } = await insertNeed(harness.db);
    await shown("pv_empty", []);
    await shown("pv_stale", [need.id], new Date(now.getTime() - EXPOSURE_WINDOW_MS - 1));
    const cases = [
      ["pv_empty", { kind: "none_shown", previewId: "pv_empty" }],
      [undefined, { kind: "skipped" }],
      ["pv_forged", { kind: "unknown", previewId: "pv_forged" }],
      ["pv_stale", { kind: "unknown", previewId: "pv_stale" }],
    ] as const;
    for (const [index, [previewId, exposure]] of cases.entries()) {
      const result = await submit(
        input({ idempotencyKey: `key-exp-${index}`, previewId, target: { needId: need.id } }),
      );
      expect(await exposureOf(result.signalId)).toEqual(exposure);
    }
  });

  it("a retry keeps one signal.created with the first exposure", async () => {
    const { need } = await insertNeed(harness.db);
    await shown("pv_retry", [need.id]);
    const value = input({ previewId: "pv_retry", target: { needId: need.id } });
    const first = await submit(value);
    const again = await submit(value);
    expect(again.signalId).toBe(first.signalId);
    const created = (await allEvents()).filter((event) => event.type === "signal.created");
    expect(created).toHaveLength(1);
  });
});
