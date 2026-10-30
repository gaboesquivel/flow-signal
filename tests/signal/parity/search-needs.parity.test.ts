import assert from "node:assert/strict";

import { encodeCursor, searchNeeds } from "../../../lib/signal/operations/search-needs";
import { assertNoPrivateData, buildPublicNeedsFixture } from "../support/public-needs-fixture";
import type { PublicNeedsFixture } from "../support/public-needs-fixture";
import { runParityTable } from "./harness";

interface Page {
  needs: { id: string; status: string; theme: { name: string } | null }[];
  nextCursor: string | null;
}
const ids = (output: unknown) => (output as Page).needs.map((need) => need.id);

runParityTable<PublicNeedsFixture>({
  cases: [
    {
      check: (output, fx) => {
        assertNoPrivateData(output, fx);
        assert.deepEqual(ids(output), [
          fx.scored.need.id,
          fx.n1.need.id,
          fx.decided.need.id,
          fx.n2.need.id,
          fx.draft.need.id,
        ]);
        assert.equal((output as Page).nextCursor, null);
      },
      input: () => ({}),
      name: "lists live needs by supporters, never merged-away ones",
    },
    {
      check: (output, fx) => assert.deepEqual(ids(output), [fx.n1.need.id, fx.n2.need.id]),
      input: () => ({ q: "pdf" }),
      name: "finds needs by proposed solution",
    },
    {
      check: (output, fx) => assert.deepEqual(ids(output), [fx.n1.need.id]),
      input: () => ({ q: "KPI snapshots" }),
      name: "searches approved use-case summaries",
    },
    {
      check: (output, fx) => assert.deepEqual(ids(output), [fx.n1.need.id]),
      input: () => ({ q: "PDF export dashboard" }),
      name: "matches every word anywhere in a need, not the exact phrase",
    },
    {
      check: (output, fx) => assert.deepEqual(ids(output), [fx.n2.need.id]),
      input: () => ({ q: "compliance archive monthly reports" }),
      name: "matches a multi-word query across statement and theme",
    },
    {
      expect: () => ({ output: { needs: [], nextCursor: null } }),
      input: () => ({ q: "SOC 2" }),
      name: "never searches unapproved summaries",
    },
    {
      expect: () => ({ output: { needs: [], nextCursor: null } }),
      input: () => ({ q: "screenshots" }),
      name: "never searches verbatim signal text",
    },
    {
      expect: () => ({ output: { needs: [], nextCursor: null } }),
      input: () => ({ q: "100%_" }),
      name: "treats LIKE wildcards literally",
    },
    {
      check: (output, fx) =>
        assert.deepEqual(ids(output), [fx.n1.need.id, fx.decided.need.id, fx.draft.need.id]),
      input: () => ({ theme: "reporting" }),
      name: "filters by theme name",
    },
    {
      check: (output, fx) => assert.deepEqual(ids(output), [fx.n2.need.id]),
      input: (fx) => ({ theme: fx.compliance.id }),
      name: "filters by theme id",
    },
    {
      check: (output, fx) => {
        assert.deepEqual(ids(output), [fx.draft.need.id]);
        assert.equal((output as Page).needs[0]?.status, "new");
      },
      input: () => ({ status: "new" }),
      name: "filters drafts as status new",
    },
    {
      check: (output, fx) => {
        assert.deepEqual(ids(output), [fx.scored.need.id, fx.n1.need.id]);
        assert.equal((output as Page).nextCursor, encodeCursor(2));
      },
      input: () => ({ limit: 2 }),
      name: "pages with a limit",
    },
    {
      check: (output, fx) => {
        assert.deepEqual(ids(output), [fx.decided.need.id, fx.n2.need.id]);
        assert.equal((output as Page).nextCursor, encodeCursor(4));
      },
      input: () => ({ cursor: encodeCursor(2), limit: 2 }),
      name: "continues from a cursor",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ cursor: "garbage!" }),
      name: "rejects a malformed cursor",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ status: "merged" }),
      name: "rejects an unknown status filter",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ limit: 0 }),
      name: "rejects a limit below 1",
    },
  ],
  fixture: buildPublicNeedsFixture,
  operation: searchNeeds,
});
