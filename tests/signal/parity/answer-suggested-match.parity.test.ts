import { suggestions, trackingLinks } from "../../../lib/db/schema";
import type { SignalDb } from "../../../lib/signal/db";
import { answerSuggestedMatch } from "../../../lib/signal/operations/answer-suggested-match";
import { insertNeed } from "../support/builders";
import { runParityTable } from "./harness";

const LINK_TOKEN = "maya-follow-up-link-000001";
const OTHER_TOKEN = "dana-follow-up-link-000001";

/**
 * Spec 009 follow-up: Maya's link alone supports draft D1, which has a pending merge proposal
 * into N1; draft D2 has the same proposal but Dana supports it too.
 */
const fixture = async (db: SignalDb) => {
  const [link, other] = await db
    .insert(trackingLinks)
    .values([{ token: LINK_TOKEN }, { token: OTHER_TOKEN }])
    .returning();
  const n1 = await insertNeed(db, { signals: [{}] });
  const d1 = await insertNeed(db, {
    approvedAt: null,
    signals: [{ attachedTo: "draft", trackingLinkId: link!.id }],
    status: "draft",
  });
  const d2 = await insertNeed(db, {
    approvedAt: null,
    signals: [
      { attachedTo: "draft", trackingLinkId: link!.id },
      { attachedTo: "existing", trackingLinkId: other!.id },
    ],
    status: "draft",
  });
  const proposal = (needId: string) => ({
    kind: "merge" as const,
    model: "fake/reasoner",
    needId,
    payload: { intoNeedId: n1.need.id, reason: "Same outcome.", similarity: 0.9 },
    relatedNeedId: n1.need.id,
  });
  const [s1, s2] = await db
    .insert(suggestions)
    .values([proposal(d1.need.id), proposal(d2.need.id)])
    .returning();
  return { d1, d2, n1, s1: s1!, s2: s2! };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

runParityTable<Fixture>({
  cases: [
    {
      // Same timestamp: the harness orders by type.
      events: () => ["follow_up.answered", "need.merged", "suggestion.accepted"],
      expect: (f) => ({ output: { answer: "join", needId: f.n1.need.id } }),
      input: (f) => ({ answer: "join", suggestionId: f.s1.id, token: LINK_TOKEN }),
      name: "join merges the holder's draft into the suggested need",
    },
    {
      events: () => ["follow_up.answered"],
      expect: (f) => ({ output: { answer: "decline", needId: f.d1.need.id } }),
      input: (f) => ({ answer: "decline", suggestionId: f.s1.id, token: LINK_TOKEN }),
      name: "decline keeps the draft",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (f) => ({ answer: "join", suggestionId: f.s2.id, token: LINK_TOKEN }),
      name: "returns conflict when someone else supports the draft",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: (f) => ({ answer: "join", suggestionId: f.s1.id, token: OTHER_TOKEN }),
      name: "returns not_found for a suggestion not offered on the link",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: (f) => ({
        answer: "join",
        suggestionId: f.s1.id,
        token: "no-such-link-token-00000001",
      }),
      name: "returns not_found for an unknown link",
    },
  ],
  fixture,
  mutates: true,
  operation: answerSuggestedMatch,
});
