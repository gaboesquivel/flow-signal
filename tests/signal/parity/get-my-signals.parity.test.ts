import assert from "node:assert/strict";

import { signals, trackingLinks } from "../../../lib/db/schema";
import type { SignalDb } from "../../../lib/signal/db";
import { getMySignals } from "../../../lib/signal/operations/get-my-signals";
import { buildPublicNeedsFixture } from "../support/public-needs-fixture";
import { runParityTable } from "./harness";

const LINK_TOKEN = "maya-link-token-0000000001";
const OTHER_LINK_TOKEN = "other-link-token-000000001";
const EARLY_LINK_TOKEN = "early-link-token-000000001";

/**
 * The public board plus My signals links (spec 006 task 02): Maya's link holds two signals; a
 * second link uses the same email (anyone can type any address) and holds one.
 */
const fixture = async (db: SignalDb) => {
  const fx = await buildPublicNeedsFixture(db);
  const { submitterId } = fx.n1.signals[0]!;
  const [link, other] = await db
    .insert(trackingLinks)
    .values([{ token: LINK_TOKEN }, { token: OTHER_LINK_TOKEN }])
    .returning();
  const onLink = (linkId: string, title: string, at: string, needId: string, token: string) => ({
    actorKind: "human" as const,
    attachedTo: "existing" as const,
    body: `${title} body`,
    channel: "web" as const,
    createdAt: new Date(at),
    needId,
    originalNeedId: needId,
    submitterId,
    title,
    trackingLinkId: linkId,
    trackingToken: token,
  });
  const [older, newer, others] = await db
    .insert(signals)
    .values([
      onLink(link!.id, "Older on link", "2026-10-01T10:00:00Z", fx.n2.need.id, LINK_TOKEN),
      onLink(
        link!.id,
        "Newer on link",
        "2026-10-02T10:00:00Z",
        fx.decided.need.id,
        "maya-own-token-0000000002",
      ),
      onLink(
        other!.id,
        "Someone else typed Maya's email",
        "2026-10-03T10:00:00Z",
        fx.n2.need.id,
        OTHER_LINK_TOKEN,
      ),
    ])
    .returning();
  return { ...fx, linked: { newer: newer!, older: older!, others: others! } };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

interface MySignals {
  signals: {
    body: string;
    decisions: { note: string; status: string }[];
    need: { id: string; status: string; supporterCount: number };
    signalId: string;
    title: string;
    useCase: string | null;
  }[];
}
const mine = (output: unknown) => (output as MySignals).signals;

runParityTable<Fixture>({
  cases: [
    {
      check: (output, fx) => {
        const [signal, ...rest] = mine(output);
        assert.equal(rest.length, 0);
        assert.equal(signal!.signalId, fx.n1.signals[0]!.id);
        assert.equal(signal!.title, "Board pack screenshots are painful");
        assert.equal(signal!.useCase, "Acme quarterly board pack");
        assert.equal(signal!.need.id, fx.n1.need.id);
        assert.equal(signal!.need.supporterCount, 11);
        assert.deepEqual(signal!.decisions, []);
        const text = JSON.stringify(output);
        // Only the holder's own words: no email, and no other submitter's text.
        assert.ok(!text.includes("maya@acme.example"));
        assert.ok(!text.includes("Verbatim"));
      },
      input: (fx) => ({ token: fx.n1.signals[0]!.trackingToken }),
      name: "shows the holder's own signal and the need it is on",
    },
    {
      check: (output, fx) => {
        const [signal] = mine(output);
        assert.equal(signal!.need.id, fx.decided.need.id);
        assert.equal(signal!.need.status, "planned");
        assert.deepEqual(signal!.decisions, [
          {
            note: "Shipping in the October release.",
            publishedAt: "2026-09-15T12:00:00.000Z",
            status: "planned",
          },
        ]);
      },
      // The decision predates this signal, so nothing is recorded as seen.
      events: () => [],
      input: (fx) => ({ token: fx.decided.signals[0]!.trackingToken }),
      name: "includes the decision note supporters see",
    },
    {
      check: (output, fx) => {
        assert.deepEqual(
          mine(output).map((signal) => signal.signalId),
          [fx.linked.newer.id, fx.linked.older.id],
        );
        assert.ok(!JSON.stringify(output).includes("Someone else typed"));
      },
      input: () => ({ token: LINK_TOKEN }),
      name: "shows every signal on a link, newest first, never another link's with the same email",
    },
    {
      check: (output, fx) =>
        assert.deepEqual(
          mine(output).map((signal) => signal.signalId),
          [fx.linked.others.id],
        ),
      input: () => ({ token: OTHER_LINK_TOKEN }),
      name: "a second link sharing the email shows only its own signal",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ token: "maya-own-token-0000000002" }),
      name: "a signal's own token on a shared link is not a link",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ token: "no-such-tracking-token-000000" }),
      name: "returns not_found for an unknown token",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ token: "short" }),
      name: "rejects a malformed token",
    },
  ],
  fixture,
  operation: getMySignals,
});

/**
 * Close-the-loop rate: a link holding a signal filed before the decided need's decision. Reading
 * it records `signal.decision_seen`, so every surface starts from a fresh fixture.
 */
const seenFixture = async (db: SignalDb) => {
  const fx = await buildPublicNeedsFixture(db);
  const [link] = await db.insert(trackingLinks).values({ token: EARLY_LINK_TOKEN }).returning();
  const [signal] = await db
    .insert(signals)
    .values({
      actorKind: "human",
      attachedTo: "existing",
      body: "Filed before the decision body",
      channel: "web",
      createdAt: new Date("2026-09-01T10:00:00Z"),
      needId: fx.decided.need.id,
      originalNeedId: fx.decided.need.id,
      submitterId: fx.n1.signals[0]!.submitterId,
      title: "Filed before the decision",
      trackingLinkId: link!.id,
      trackingToken: EARLY_LINK_TOKEN,
    })
    .returning();
  return { signal: signal! };
};

runParityTable<Awaited<ReturnType<typeof seenFixture>>>({
  cases: [
    {
      check: (output, fx) => {
        const [signal, ...rest] = mine(output);
        assert.equal(rest.length, 0);
        assert.equal(signal!.signalId, fx.signal.id);
        assert.equal(signal!.decisions.length, 1);
      },
      events: () => ["signal.decision_seen"],
      input: () => ({ token: EARLY_LINK_TOKEN }),
      name: "records that the holder saw a decision published after their signal",
    },
  ],
  fixture: seenFixture,
  mutates: true,
  operation: getMySignals,
});
