import assert from "node:assert/strict";

import { getMySignals } from "../../../lib/signal/operations/get-my-signals";
import { buildPublicNeedsFixture } from "../support/public-needs-fixture";
import type { PublicNeedsFixture } from "../support/public-needs-fixture";
import { runParityTable } from "./harness";

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

runParityTable<PublicNeedsFixture>({
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
      input: (fx) => ({ token: fx.decided.signals[0]!.trackingToken }),
      name: "includes the decision note supporters see",
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
  fixture: buildPublicNeedsFixture,
  operation: getMySignals,
});
