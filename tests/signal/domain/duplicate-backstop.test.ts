import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { events, mergeChecks, needs, signals, suggestions } from "../../../lib/db/schema";
import { createFakeAi, createUnavailableAi, fakeReasoner } from "../../../lib/signal/ai/fakes";
import type { SignalAi } from "../../../lib/signal/ai/ports";
import type { Actor } from "../../../lib/signal/context";
import {
  answerSuggestedMatch,
  checkDraftForDuplicates,
  sweepDuplicates,
} from "../../../lib/signal/domain/duplicate-backstop";
import { embedMissingNeeds, embedNeeds } from "../../../lib/signal/domain/embeddings";
import { getMySignals } from "../../../lib/signal/domain/my-signals";
import { submitSignal } from "../../../lib/signal/domain/submissions";
import { SignalError } from "../../../lib/signal/errors";
import { recordEvent } from "../../../lib/signal/events";
import { insertNeed, insertSubmitter } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

/** Spec 009: merge checks with memory, the duplicate sweep, and the submitter follow-up. */

const now = new Date("2026-10-30T09:00:00Z");
const clock = { now: () => now };
const human: Actor = { kind: "human", ref: "web" };

const N1 =
  "Executives need to share dashboard snapshots so that board meetings use current numbers";
const N2 = "Board members need monthly dashboard snapshots so that board packs stay current";
const DRAFT = "Executives need dashboard snapshots so that board meetings use current numbers";

/**
 * A merge judge that picks the first numbered line containing one of `keywords`, in keyword
 * order, and counts its calls and prompts.
 */
const countingJudge = (keywords: string[]) => {
  const prompts: string[] = [];
  const reasoner = fakeReasoner({
    merge: ({ prompt }) => {
      prompts.push(prompt);
      const lines = prompt.split("\n").filter((line) => /^\d+\./u.test(line));
      for (const keyword of keywords) {
        const line = lines.find((candidate) => candidate.includes(keyword));
        if (line) return { candidate: Number(line.split(".")[0]), reason: `Shares ${keyword}.` };
      }
      return { candidate: null, reason: "No duplicate." };
    },
  });
  return { ai: createFakeAi({ reasoner }), prompts };
};

const tokenOf = (trackingUrl: string) => trackingUrl.split("/my/")[1]!;

/** A submission for `submit_signal`'s own check. */
const submission = (key: string, previewId?: string) => ({
  body: "The board wants dashboard snapshots every month.",
  email: "agent-user@example.test",
  idempotencyKey: key,
  ...(previewId ? { previewId } : {}),
  target: { newNeed: { statement: DRAFT } },
  title: "Dashboard snapshots for the board",
});

const fakeJudgeFor = (byId: Record<string, number>) => ({
  judge: ({ candidates }: { candidates: { needId: string }[] }) =>
    Promise.resolve(
      candidates.map(({ needId }) => ({
        needId,
        probability: byId[needId] ?? 0.1,
        reason: "r",
      })),
    ),
  model: "fake/judge",
});

describeWithDatabase("duplicate backstop", () => {
  const harness = useTestDatabase();
  const deps = (ai: SignalAi) => ({ ai, clock, db: harness.db });

  beforeEach(() => resetDatabase(harness.db));

  const build = async () => {
    const n1 = await insertNeed(harness.db, { signals: [{}], statement: N1 });
    const n2 = await insertNeed(harness.db, { signals: [{}], statement: N2 });
    const draft = await insertNeed(harness.db, {
      approvedAt: null,
      createdAt: new Date("2026-10-29T09:00:00Z"),
      signals: [{ attachedTo: "draft" }],
      statement: DRAFT,
      status: "draft",
    });
    await embedNeeds(harness.db, createFakeAi().embedder, [n1.need.id, n2.need.id, draft.need.id]);
    return { draft, n1, n2 };
  };

  const addSupporter = async (needId: string) => {
    const submitter = await insertSubmitter(harness.db);
    await harness.db.insert(signals).values({
      actorKind: "human",
      attachedTo: "existing",
      body: "Me too",
      channel: "web",
      needId,
      originalNeedId: needId,
      submitterId: submitter.id,
      title: "Me too",
      trackingToken: randomUUID(),
    });
  };

  const mergeRows = () =>
    harness.db.select().from(suggestions).where(eq(suggestions.kind, "merge"));

  it("proposes up to two merges per check and records what it saw", async () => {
    const f = await build();
    const { ai, prompts } = countingJudge(["Executives need to share", "Board members"]);
    const checked = await checkDraftForDuplicates(deps(ai), f.draft.need.id);
    expect(checked.status).toBe("checked");
    expect(checked.proposed.map((p) => p.intoNeedId)).toEqual([f.n1.need.id, f.n2.need.id]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("Executives need to share");

    const rows = await mergeRows();
    expect(rows.map((r) => r.relatedNeedId).toSorted()).toEqual(
      [f.n1.need.id, f.n2.need.id].toSorted(),
    );
    const created = await harness.db
      .select()
      .from(events)
      .where(eq(events.type, "suggestion.created"));
    expect(created).toHaveLength(2);
    const [check] = await harness.db.select().from(mergeChecks);
    expect(check).toMatchObject({ draftSupporters: 1, needId: f.draft.need.id });
  });

  it("re-asks the judge only when the draft, its candidates, or their supporters change", async () => {
    const f = await build();
    const { ai, prompts } = countingJudge([]);
    expect((await checkDraftForDuplicates(deps(ai), f.draft.need.id)).status).toBe("checked");
    expect(prompts).toHaveLength(1);

    // Nothing changed: no model call.
    expect((await checkDraftForDuplicates(deps(ai), f.draft.need.id)).status).toBe("not_due");
    expect(prompts).toHaveLength(1);

    // A candidate gained a supporter.
    await addSupporter(f.n1.need.id);
    expect((await checkDraftForDuplicates(deps(ai), f.draft.need.id)).status).toBe("checked");
    expect(prompts).toHaveLength(2);

    // The draft gained a supporter.
    await addSupporter(f.draft.need.id);
    expect((await checkDraftForDuplicates(deps(ai), f.draft.need.id)).status).toBe("checked");
    expect(prompts).toHaveLength(3);

    // A new candidate appeared.
    const n3 = await insertNeed(harness.db, {
      statement: "Executives need dashboard exports so that board meetings run on time",
    });
    await embedNeeds(harness.db, createFakeAi().embedder, [n3.need.id]);
    expect((await checkDraftForDuplicates(deps(ai), f.draft.need.id)).status).toBe("checked");
    expect(prompts).toHaveLength(4);
  });

  it("never re-proposes a rejected or pending target", async () => {
    const f = await build();
    const first = countingJudge(["Executives need to share"]);
    await checkDraftForDuplicates(deps(first.ai), f.draft.need.id);
    const [proposal] = await mergeRows();
    await harness.db
      .update(suggestions)
      .set({ status: "rejected" })
      .where(eq(suggestions.id, proposal!.id));

    // A new candidate makes the draft due; the rejected N1 is not shown to the judge again.
    const n3 = await insertNeed(harness.db, {
      statement: "Executives need dashboard exports so that board meetings run on time",
    });
    await embedNeeds(harness.db, createFakeAi().embedder, [n3.need.id]);
    const again = countingJudge(["Executives need to share", "Board members"]);
    const checked = await checkDraftForDuplicates(deps(again.ai), f.draft.need.id);
    expect(again.prompts.every((p) => !p.includes("Executives need to share"))).toBe(true);
    expect(checked.proposed.map((p) => p.intoNeedId)).toEqual([f.n2.need.id]);
  });

  it("checks a draft filed while the embedder was down once it can be embedded", async () => {
    const n1 = await insertNeed(harness.db, { signals: [{}], statement: N1 });
    await embedNeeds(harness.db, createFakeAi().embedder, [n1.need.id]);
    const draft = await insertNeed(harness.db, {
      approvedAt: null,
      signals: [{ attachedTo: "draft" }],
      statement: DRAFT,
      status: "draft",
    });

    const down = await sweepDuplicates(deps(createUnavailableAi()));
    expect(down).toMatchObject({ checked: [], unavailable: 1 });
    expect(await harness.db.select().from(mergeChecks)).toEqual([]);

    await embedMissingNeeds(harness.db, createFakeAi().embedder);
    const { ai } = countingJudge(["Executives need to share"]);
    const swept = await sweepDuplicates(deps(ai));
    expect(swept.checked).toEqual([
      {
        needId: draft.need.id,
        proposed: [{ intoNeedId: n1.need.id, suggestionId: expect.any(String) }],
      },
    ]);
  });

  it("embeds a draft with no vector during its check", async () => {
    const n1 = await insertNeed(harness.db, { signals: [{}], statement: N1 });
    await embedNeeds(harness.db, createFakeAi().embedder, [n1.need.id]);
    const draft = await insertNeed(harness.db, {
      approvedAt: null,
      signals: [{ attachedTo: "draft" }],
      statement: DRAFT,
      status: "draft",
    });
    const { ai } = countingJudge(["Executives need to share"]);
    const checked = await checkDraftForDuplicates(deps(ai), draft.need.id);
    expect(checked.proposed).toHaveLength(1);
    const [row] = await harness.db.select().from(needs).where(eq(needs.id, draft.need.id));
    expect(row!.embedding).not.toBeNull();
  });

  it("brings two back-to-back drafts together exactly once", async () => {
    const d3 = await insertNeed(harness.db, {
      approvedAt: null,
      createdAt: new Date("2026-10-30T08:00:00Z"),
      signals: [{ attachedTo: "draft" }],
      statement: DRAFT,
      status: "draft",
    });
    await embedNeeds(harness.db, createFakeAi().embedder, [d3.need.id]);
    const { ai } = countingJudge(["Executives need dashboard snapshots"]);
    // D3's first check runs before D4 exists.
    expect((await checkDraftForDuplicates(deps(ai), d3.need.id)).proposed).toEqual([]);

    const d4 = await insertNeed(harness.db, {
      approvedAt: null,
      createdAt: new Date("2026-10-30T08:00:05Z"),
      signals: [{ attachedTo: "draft" }],
      statement: DRAFT,
      status: "draft",
    });
    await embedNeeds(harness.db, createFakeAi().embedder, [d4.need.id]);

    await sweepDuplicates(deps(ai), { checks: 5 });
    await sweepDuplicates(deps(ai), { checks: 5 });
    const rows = await mergeRows();
    expect(rows).toHaveLength(1);
    expect([rows[0]!.needId, rows[0]!.relatedNeedId].toSorted()).toEqual(
      [d3.need.id, d4.need.id].toSorted(),
    );
  });

  it("stops a sweep after its check budget and skips drafts older than 30 days", async () => {
    const n1 = await insertNeed(harness.db, { signals: [{}], statement: N1 });
    const drafts = await Promise.all(
      [1, 2, 3].map((n) =>
        insertNeed(harness.db, {
          approvedAt: null,
          createdAt: new Date(`2026-10-2${n}T09:00:00Z`),
          signals: [{ attachedTo: "draft" }],
          statement: `${DRAFT} ${n}`,
          status: "draft",
        }),
      ),
    );
    const old = await insertNeed(harness.db, {
      approvedAt: null,
      createdAt: new Date("2026-09-01T09:00:00Z"),
      signals: [{ attachedTo: "draft" }],
      statement: DRAFT,
      status: "draft",
    });
    await embedNeeds(harness.db, createFakeAi().embedder, [
      n1.need.id,
      old.need.id,
      ...drafts.map((d) => d.need.id),
    ]);
    const { ai } = countingJudge([]);
    const first = await sweepDuplicates(deps(ai));
    expect(first.checked.map((c) => c.needId)).toEqual([drafts[2]!.need.id, drafts[1]!.need.id]);
    const second = await sweepDuplicates(deps(ai), { checks: 5 });
    expect(second.checked.map((c) => c.needId)).toEqual([drafts[0]!.need.id]);
    expect(second.examined).toBe(3);
  });

  const submitDraft = (ai: SignalAi, key: string) =>
    submitSignal(
      { actor: human, ai, clock, db: harness.db },
      {
        body: "The board wants dashboard snapshots every month.",
        email: "maya@acme.example",
        idempotencyKey: key,
        previewId: "pv_seen_a_preview_000000",
        target: { newNeed: { statement: DRAFT } },
        title: "Dashboard snapshots for the board",
      },
    );

  const followUpFixture = async () => {
    const n1 = await insertNeed(harness.db, { signals: [{}], statement: N1 });
    await embedNeeds(harness.db, createFakeAi().embedder, [n1.need.id]);
    const submitted = await submitDraft(createFakeAi(), "follow-up-0001");
    const { ai } = countingJudge(["Executives need to share"]);
    const checked = await checkDraftForDuplicates(deps(ai), submitted.needId);
    const { suggestionId } = checked.proposed[0]!;
    return { n1, submitted, suggestionId, token: tokenOf(submitted.trackingUrl) };
  };

  it("offers a pending merge on My signals and joins it on request", async () => {
    const f = await followUpFixture();
    const mine = await getMySignals(harness.db, f.token);
    expect(mine!.signals[0]!.suggestedMatches).toEqual([
      {
        need: expect.objectContaining({ id: f.n1.need.id, statement: N1 }),
        suggestionId: f.suggestionId,
      },
    ]);

    const answered = await answerSuggestedMatch(
      { actor: human, ai: createFakeAi(), clock, db: harness.db },
      { answer: "join", suggestionId: f.suggestionId, token: f.token },
    );
    expect(answered).toEqual({ answer: "join", needId: f.n1.need.id });
    const [draft] = await harness.db.select().from(needs).where(eq(needs.id, f.submitted.needId));
    expect(draft).toMatchObject({ mergedIntoId: f.n1.need.id, status: "merged" });
    const [suggestion] = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, f.suggestionId));
    expect(suggestion).toMatchObject({ resolvedByKind: "human", status: "accepted" });
    const types = (await harness.db.select().from(events)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["need.merged", "suggestion.accepted", "follow_up.answered"]),
    );
    const accepted = (await harness.db.select().from(events)).find(
      (e) => e.type === "suggestion.accepted",
    );
    expect(accepted!.payload).toMatchObject({ kind: "merge", via: "submitter" });

    const after = await getMySignals(harness.db, f.token);
    expect(after!.signals[0]!.need.id).toBe(f.n1.need.id);
    expect(after!.signals[0]!.suggestedMatches).toEqual([]);
  });

  it("a decline keeps the draft, marks the suggestion for the PM, and hides it", async () => {
    const f = await followUpFixture();
    const answered = await answerSuggestedMatch(
      { actor: human, ai: createFakeAi(), clock, db: harness.db },
      { answer: "decline", suggestionId: f.suggestionId, token: f.token },
    );
    expect(answered).toEqual({ answer: "decline", needId: f.submitted.needId });
    const [suggestion] = await harness.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, f.suggestionId));
    expect(suggestion).toMatchObject({ payload: { submitterDeclined: true }, status: "pending" });
    const mine = await getMySignals(harness.db, f.token);
    expect(mine!.signals[0]!.suggestedMatches).toEqual([]);
  });

  it("refuses another link's suggestion and a draft someone else supports", async () => {
    const f = await followUpFixture();
    const ctx = { actor: human, ai: createFakeAi(), clock, db: harness.db };
    const other = await submitSignal(ctx, {
      body: "Something else entirely.",
      email: "dana@example.test",
      idempotencyKey: "follow-up-other-0001",
      target: { newNeed: { statement: "Admins need single sign-on so that access is managed" } },
      title: "SSO",
    });
    await expect(
      answerSuggestedMatch(ctx, {
        answer: "join",
        suggestionId: f.suggestionId,
        token: tokenOf(other.trackingUrl),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      answerSuggestedMatch(ctx, {
        answer: "join",
        suggestionId: f.suggestionId,
        token: "no-such-link-token-000000001",
      }),
    ).rejects.toBeInstanceOf(SignalError);

    // Dana adds her voice to Maya's draft: it is no longer Maya's alone.
    await submitSignal(ctx, {
      body: "Same here.",
      email: "dana@example.test",
      idempotencyKey: "follow-up-dana-0001",
      target: { needId: f.submitted.needId },
      title: "Me too",
    });
    const mine = await getMySignals(harness.db, f.token);
    expect(mine!.signals[0]!.suggestedMatches).toEqual([]);
    await expect(
      answerSuggestedMatch(ctx, { answer: "join", suggestionId: f.suggestionId, token: f.token }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  describe("submit_signal's own check (no usable preview)", () => {
    const agent: Actor = { client: "parity", kind: "agent", ref: "mcp:parity" };
    const judged = (ai = createFakeAi()) => ({
      ...ai,
      judge: fakeJudgeFor({ [n1Id]: 0.9 }),
    });
    let n1Id = "";

    beforeEach(async () => {
      const n1 = await insertNeed(harness.db, { signals: [{}], statement: N1 });
      await embedNeeds(harness.db, createFakeAi().embedder, [n1.need.id]);
      n1Id = n1.need.id;
    });

    it("returns possible duplicates for a skipped or unknown preview, and the same on replay", async () => {
      const ctx = { actor: agent, ai: judged(), clock, db: harness.db };
      const skipped = await submitSignal(ctx, submission("skip-check-0001"));
      expect(skipped.possibleDuplicates).toEqual([
        { needId: n1Id, probability: 0.9, statement: N1, status: "open", supporterCount: 1 },
      ]);
      const replay = await submitSignal(ctx, submission("skip-check-0001"));
      expect(replay.possibleDuplicates).toEqual(skipped.possibleDuplicates);
      const unknown = await submitSignal(ctx, submission("skip-check-0002", "pv_forged"));
      expect(unknown.possibleDuplicates.map((d) => d.needId)).toEqual([n1Id]);
      const [created] = await harness.db
        .select()
        .from(events)
        .where(and(eq(events.signalId, skipped.signalId), eq(events.type, "signal.created")));
      expect(created!.payload.possibleDuplicates).toEqual([{ needId: n1Id, probability: 0.9 }]);
    });

    it("runs no check after a shown preview, for an existing target, or with AI down", async () => {
      const ctx = { actor: agent, ai: judged(), clock, db: harness.db };
      await recordEvent(harness.db, {
        actor: agent,
        dedupeKey: "preview.shown:pv_seen_000000000000000000",
        occurredAt: now,
        payload: {
          additionalAsks: 0,
          ai: "ok",
          matches: [],
          previewId: "pv_seen_000000000000000000",
        },
        type: "preview.shown",
      });
      const seen = await submitSignal(ctx, submission("seen-0001", "pv_seen_000000000000000000"));
      expect(seen.possibleDuplicates).toEqual([]);
      const joined = await submitSignal(ctx, {
        ...submission("joined-0001"),
        target: { needId: n1Id },
      });
      expect(joined.possibleDuplicates).toEqual([]);
      const down = await submitSignal(
        { ...ctx, ai: createUnavailableAi() },
        submission("down-0001"),
      );
      expect(down.possibleDuplicates).toEqual([]);
      expect(down.attachedTo).toBe("draft");
    });
  });
});
