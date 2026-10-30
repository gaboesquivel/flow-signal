import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import { signals, trackingLinks } from "../../../lib/db/schema";
import { createFakeAi } from "../../../lib/signal/ai/fakes";
import type { Actor } from "../../../lib/signal/context";
import { getMySignals } from "../../../lib/signal/domain/my-signals";
import { submitSignal } from "../../../lib/signal/domain/submissions";
import type { SubmitInput } from "../../../lib/signal/domain/submissions";
import { insertNeed, insertSubmitter } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

/**
 * My signals links that carry forward (spec 006 → Implementation Decisions 1–2, decision 0005):
 * a holder's next signal joins the link they already hold; legacy per-signal tokens are adopted
 * on first use; nothing is ever grouped or looked up by email.
 */

const human: Actor = { kind: "human", ref: "web" };
const LEGACY_TOKEN = "legacy-tracking-token-0001";

const tokenOf = (trackingUrl: string) => trackingUrl.split("/my/")[1]!;

describeWithDatabase("tracking links", () => {
  const harness = useTestDatabase();
  let tick = 0;
  beforeEach(async () => {
    tick = 0;
    await resetDatabase(harness.db);
  });

  /** Each submission happens a minute after the previous one, so "newest first" is observable. */
  const submit = (overrides: Partial<SubmitInput> & Pick<SubmitInput, "target">) => {
    tick += 1;
    const now = new Date(Date.UTC(2026, 9, 30, 12, tick));
    return submitSignal(
      { actor: human, ai: createFakeAi(), clock: { now: () => now }, db: harness.db },
      {
        body: `Body ${tick}`,
        email: "maya@acme.example",
        idempotencyKey: `key-${String(tick).padStart(4, "0")}`,
        title: `Title ${tick}`,
        ...overrides,
      },
    );
  };

  const links = () => harness.db.select().from(trackingLinks);
  const signalRow = async (id: string) =>
    (await harness.db.select().from(signals).where(eq(signals.id, id)))[0]!;

  /** A signal filed before links existed: its own token, no link. */
  const insertLegacy = async (needId: string, token = LEGACY_TOKEN, email?: string) => {
    const submitter = await insertSubmitter(harness.db, email ? { email } : {});
    const [row] = await harness.db
      .insert(signals)
      .values({
        actorKind: "human",
        attachedTo: "existing",
        body: "Legacy words",
        channel: "web",
        createdAt: new Date("2026-09-01T10:00:00Z"),
        needId,
        originalNeedId: needId,
        submitterId: submitter.id,
        title: "Legacy title",
        trackingToken: token,
      })
      .returning();
    return row!;
  };

  it("issues a new link when no token is given; the link's token is the signal's own", async () => {
    const { need } = await insertNeed(harness.db);
    const result = await submit({ target: { needId: need.id } });

    expect(result.linkReused).toBe(false);
    const [link] = await links();
    expect(tokenOf(result.trackingUrl)).toBe(link!.token);
    const row = await signalRow(result.signalId);
    expect(row.trackingLinkId).toBe(link!.id);
    expect(row.trackingToken).toBe(link!.token);
  });

  it("joins an existing link; every signal on it shows on one page, newest first", async () => {
    const { need } = await insertNeed(harness.db);
    const first = await submit({ target: { needId: need.id } });
    const second = await submit({
      target: { newNeed: { statement: "Admins need audit logs so that access reviews are fast" } },
      trackingToken: tokenOf(first.trackingUrl),
    });

    expect(second.linkReused).toBe(true);
    expect(second.trackingUrl).toBe(first.trackingUrl);
    expect(await links()).toHaveLength(1);
    // Each signal keeps its own unique per-signal token.
    const [a, b] = [await signalRow(first.signalId), await signalRow(second.signalId)];
    expect(a.trackingLinkId).toBe(b.trackingLinkId);
    expect(a.trackingToken).not.toBe(b.trackingToken);

    const mine = await getMySignals(harness.db, tokenOf(first.trackingUrl));
    expect(mine?.signals.map((signal) => signal.signalId)).toEqual([
      second.signalId,
      first.signalId,
    ]);
  });

  it("issues a fresh link for an unknown token, never one with the caller's token", async () => {
    const { need } = await insertNeed(harness.db);
    const unknown = "no-such-link-token-000000";
    const result = await submit({ target: { needId: need.id }, trackingToken: unknown });

    expect(result.linkReused).toBe(false);
    expect(tokenOf(result.trackingUrl)).not.toBe(unknown);
    expect((await links()).map((link) => link.token)).toEqual([tokenOf(result.trackingUrl)]);
    expect(await getMySignals(harness.db, unknown)).toBeUndefined();
  });

  it("adopts a legacy token passed to submit: same URL, both signals on it", async () => {
    const { need } = await insertNeed(harness.db);
    const legacy = await insertLegacy(need.id);
    const result = await submit({ target: { needId: need.id }, trackingToken: LEGACY_TOKEN });

    expect(result.linkReused).toBe(true);
    expect(tokenOf(result.trackingUrl)).toBe(LEGACY_TOKEN);
    const [link] = await links();
    expect(link!.token).toBe(LEGACY_TOKEN);
    expect((await signalRow(legacy.id)).trackingLinkId).toBe(link!.id);
    const mine = await getMySignals(harness.db, LEGACY_TOKEN);
    expect(mine?.signals.map((signal) => signal.signalId)).toEqual([result.signalId, legacy.id]);
  });

  it("adopts a legacy token the first time My signals reads it, once", async () => {
    const { need } = await insertNeed(harness.db);
    const legacy = await insertLegacy(need.id);

    const first = await getMySignals(harness.db, LEGACY_TOKEN);
    const again = await getMySignals(harness.db, LEGACY_TOKEN);
    expect(first?.signals.map((signal) => signal.signalId)).toEqual([legacy.id]);
    expect(again).toEqual(first);
    const [link, ...rest] = await links();
    expect(rest).toEqual([]);
    expect(link!.token).toBe(LEGACY_TOKEN);
    expect((await signalRow(legacy.id)).trackingLinkId).toBe(link!.id);
  });

  it("adopts a legacy token once under concurrent first use", async () => {
    const { need } = await insertNeed(harness.db);
    await insertLegacy(need.id);
    await Promise.all([0, 1, 2].map(() => getMySignals(harness.db, LEGACY_TOKEN)));
    expect(await links()).toHaveLength(1);
  });

  it("a signal's own token on a shared link is not a link and shows nothing", async () => {
    const { need } = await insertNeed(harness.db);
    const first = await submit({ target: { needId: need.id } });
    const second = await submit({
      target: { needId: need.id },
      trackingToken: tokenOf(first.trackingUrl),
    });
    const ownToken = (await signalRow(second.signalId)).trackingToken;
    expect(await getMySignals(harness.db, ownToken)).toBeUndefined();
  });

  it("a replayed idempotencyKey returns the original result, link included", async () => {
    const { need } = await insertNeed(harness.db);
    const first = await submit({ target: { needId: need.id } });
    const joined = await submit({
      idempotencyKey: "joined-0001",
      target: { needId: need.id },
      trackingToken: tokenOf(first.trackingUrl),
    });
    // The retry omits the token (or names another link): the stored result wins.
    const retried = await submit({
      body: "Body 2",
      idempotencyKey: "joined-0001",
      target: { needId: need.id },
      title: "Title 2",
    });
    expect(retried).toEqual({ ...joined, replayed: true });
    expect(retried.linkReused).toBe(true);

    const fresh = await submit({
      body: "Body 1",
      idempotencyKey: "key-0001",
      target: { needId: need.id },
      title: "Title 1",
    });
    expect(fresh).toEqual({ ...first, replayed: true });
    expect(await links()).toHaveLength(1);
  });

  it("two links sharing an email never see each other's signals", async () => {
    const { need } = await insertNeed(harness.db);
    const legacy = await insertLegacy(need.id, LEGACY_TOKEN, "maya@acme.example");
    const mine = await submit({ target: { needId: need.id } });
    const theirs = await submit({ target: { needId: need.id } });
    expect(mine.trackingUrl).not.toBe(theirs.trackingUrl);

    const read = async (url: string) =>
      (await getMySignals(harness.db, tokenOf(url)))?.signals.map((signal) => signal.signalId);
    expect(await read(mine.trackingUrl)).toEqual([mine.signalId]);
    expect(await read(theirs.trackingUrl)).toEqual([theirs.signalId]);
    expect(await read(`/my/${LEGACY_TOKEN}`)).toEqual([legacy.id]);
  });
});
