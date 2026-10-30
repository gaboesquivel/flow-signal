import assert from "node:assert/strict";

import { signals, trackingLinks } from "../../../lib/db/schema";
import type { SignalDb } from "../../../lib/signal/db";
import { submitSignal } from "../../../lib/signal/operations/submit-signal";
import { buildSubmissionFixture, maya } from "../support/submission-fixture";
import { runParityTable } from "./harness";

/** A signal stored earlier with this key, so a retry must return it unchanged. */
const RETRY_KEY = "retry-key-0001";
const HELD_TOKEN = "held-link-token-000000001";
const retried = { body: "Schedule the weekly KPI report.", title: "Weekly report emails" };

const fixture = async (db: SignalDb) => {
  const fx = await buildSubmissionFixture(db);
  const [prior] = await db
    .insert(signals)
    .values({
      actorKind: "agent",
      agentClient: "parity",
      attachedTo: "existing",
      body: retried.body,
      channel: "mcp",
      idempotencyKey: RETRY_KEY,
      needId: fx.decided.need.id,
      originalNeedId: fx.decided.need.id,
      submitterId: fx.n1.signals[0]!.submitterId,
      title: retried.title,
      trackingToken: "prior-tracking-token-0001",
    })
    .returning();
  // A My signals link Maya already holds, with one signal on it (spec 006 task 02).
  const [link] = await db.insert(trackingLinks).values({ token: HELD_TOKEN }).returning();
  await db.insert(signals).values({
    actorKind: "human",
    attachedTo: "existing",
    body: "Held link words",
    channel: "web",
    needId: fx.n2.need.id,
    originalNeedId: fx.n2.need.id,
    submitterId: fx.n1.signals[0]!.submitterId,
    title: "Held link title",
    trackingLinkId: link!.id,
    trackingToken: HELD_TOKEN,
  });
  return { ...fx, link: link!, prior: prior! };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

interface Submitted {
  attachedTo: string;
  linkReused: boolean;
  needId: string;
  signalId: string;
  trackingUrl: string;
}
const submitted = (output: unknown) => output as Submitted;

const base = { body: maya.body, email: maya.email, title: maya.title };

runParityTable<Fixture>({
  cases: [
    {
      check: (output, fx) => {
        const result = submitted(output);
        assert.equal(result.attachedTo, "existing");
        assert.equal(result.needId, fx.n1.need.id);
        assert.match(result.trackingUrl, /\/my\/[\w-]{32}$/u);
        assert.equal(result.linkReused, false);
      },
      input: (fx) => ({
        ...base,
        company: "Acme Corp",
        idempotencyKey: "maya-attach-0001",
        target: { needId: fx.n1.need.id },
        urgency: "high",
        useCase: "monthly board deck",
      }),
      name: "adds a voice to an existing need (acceptance step 2)",
    },
    {
      check: (output, fx) => {
        const result = submitted(output);
        assert.equal(result.attachedTo, "draft");
        assert.ok(
          ![fx.n1, fx.n2, fx.draft, fx.decided, fx.scored, fx.merged].some(
            (row) => row.need.id === result.needId,
          ),
        );
      },
      input: () => ({
        body: "Night shifts strain our eyes.",
        email: "nurse@clinic.example",
        idempotencyKey: "dark-mode-0001",
        previewId: "pv_dark",
        target: {
          newNeed: {
            statement:
              "Night-shift staff need a dark theme so that screens do not strain their eyes",
          },
        },
        title: "Dark mode",
      }),
      name: '"none of these" creates a draft need',
    },
    {
      check: (output, fx) => assert.equal(submitted(output).needId, fx.n1.need.id),
      input: (fx) => ({
        ...base,
        idempotencyKey: "maya-merged-0001",
        target: { needId: fx.merged.need.id },
      }),
      name: "a merged-away target lands on the need it was merged into",
    },
    {
      check: (output, fx) => {
        const result = submitted(output);
        assert.equal(result.signalId, fx.prior.id);
        assert.equal(result.needId, fx.decided.need.id);
        assert.equal(result.attachedTo, "existing");
        assert.ok(result.trackingUrl.endsWith("/my/prior-tracking-token-0001"));
        assert.equal(result.linkReused, false);
      },
      input: (fx) => ({
        ...retried,
        email: "Maya@Acme.example",
        idempotencyKey: RETRY_KEY,
        target: { needId: fx.decided.need.id },
      }),
      name: "a retry with the same idempotencyKey returns the same signal and writes no event",
    },
    {
      check: (output, fx) => {
        const result = submitted(output);
        assert.equal(result.linkReused, true);
        assert.ok(result.trackingUrl.endsWith(`/my/${fx.link.token}`));
      },
      input: (fx) => ({
        ...base,
        idempotencyKey: "maya-held-link-0001",
        target: { needId: fx.n1.need.id },
        trackingToken: HELD_TOKEN,
      }),
      name: "a held trackingToken files onto that link (linkReused)",
    },
    {
      check: (output) => {
        const result = submitted(output);
        assert.equal(result.linkReused, true);
        assert.ok(result.trackingUrl.endsWith("/my/prior-tracking-token-0001"));
      },
      input: (fx) => ({
        ...base,
        idempotencyKey: "maya-legacy-link-0001",
        target: { needId: fx.n1.need.id },
        trackingToken: "prior-tracking-token-0001",
      }),
      name: "a legacy per-signal token is adopted as a link and reused",
    },
    {
      check: (output) => {
        const result = submitted(output);
        assert.equal(result.linkReused, false);
        assert.match(result.trackingUrl, /\/my\/[\w-]{32}$/u);
        assert.ok(!result.trackingUrl.endsWith("/my/no-such-link-token-00001"));
      },
      input: (fx) => ({
        ...base,
        idempotencyKey: "maya-unknown-link-0001",
        target: { needId: fx.n1.need.id },
        trackingToken: "no-such-link-token-00001",
      }),
      name: "an unknown trackingToken issues a new link",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (fx) => ({
        ...base,
        idempotencyKey: "bad-token-0001",
        target: { needId: fx.n1.need.id },
        trackingToken: "not a token!",
      }),
      name: "rejects a malformed trackingToken",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (fx) => ({ ...base, idempotencyKey: RETRY_KEY, target: { needId: fx.n1.need.id } }),
      name: "reusing an idempotencyKey for a different submission is a conflict",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({
        ...base,
        idempotencyKey: "unknown-need-0001",
        target: { needId: "4b0e6c1e-8a7d-4f3e-9c2b-1d5a6e7f8a9b" },
      }),
      name: "an unknown need is not_found and writes nothing",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (fx) => ({ ...base, target: { needId: fx.n1.need.id } }),
      name: "requires an idempotencyKey",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (fx) => ({
        ...base,
        email: "not-an-email",
        idempotencyKey: "bad-email-0001",
        target: { needId: fx.n1.need.id },
      }),
      name: "rejects an invalid email",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (fx) => ({
        ...base,
        idempotencyKey: "both-targets-0001",
        target: { needId: fx.n1.need.id, newNeed: { statement: "Someone needs something" } },
      }),
      name: "takes exactly one target",
    },
  ],
  fixture,
  mutates: true,
  operation: submitSignal,
});
