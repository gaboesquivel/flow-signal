import assert from "node:assert/strict";

import { listSuggestions } from "../../../lib/signal/operations/list-suggestions";
import { buildTriageFixture } from "../support/triage-fixture";
import { runParityTable } from "./harness";

interface Page {
  nextCursor: string | null;
  suggestions: {
    id: string;
    kind: string;
    need: { id: string; statement: string; status: string } | null;
    reason: string | null;
    relatedNeed: { id: string } | null;
    status: string;
  }[];
}

runParityTable({
  cases: [
    {
      check: (output, f) => {
        const page = output as Page;
        assert.deepEqual(
          page.suggestions.map((s) => s.id),
          [
            f.suggestions.split.id,
            f.suggestions.summary.id,
            f.suggestions.theme.id,
            f.suggestions.merge.id,
            f.suggestions.draftNeed.id,
            f.suggestions.brief.id,
            f.suggestions.priority.id,
          ],
        );
        assert.equal(page.nextCursor, null);
        const merge = page.suggestions.find((s) => s.kind === "merge")!;
        assert.equal(merge.reason, "Same board-meeting outcome.");
        assert.equal(merge.need?.id, f.draft.need.id);
        assert.equal(merge.need?.status, "draft");
        assert.equal(merge.relatedNeed?.id, f.n1.need.id);
      },
      input: () => ({}),
      name: "lists the pending triage queue newest first, with reasons and needs",
    },
    {
      check: (output, f) => {
        const page = output as Page;
        assert.deepEqual(
          page.suggestions.map((s) => s.id),
          [f.suggestions.rejected.id],
        );
        assert.equal(page.suggestions[0]!.status, "rejected");
      },
      input: () => ({ kind: "merge", status: "rejected" }),
      name: "filters by kind and status",
    },
    {
      check: (output, f) => {
        const ids = (output as Page).suggestions.map((s) => s.id);
        assert.deepEqual(ids, [
          f.suggestions.split.id,
          f.suggestions.summary.id,
          f.suggestions.merge.id,
          f.suggestions.brief.id,
        ]);
      },
      input: (f) => ({ needId: f.n1.need.id }),
      name: "filters by need, as subject or merge target",
    },
    {
      check: (output) => {
        const page = output as Page;
        assert.equal(page.suggestions.length, 2);
        assert.ok(page.nextCursor);
      },
      input: () => ({ limit: 2 }),
      name: "pages with a cursor",
    },
    {
      check: (output, f) => {
        assert.deepEqual(
          (output as Page).suggestions.map((s) => s.id),
          [f.suggestions.theme.id, f.suggestions.merge.id],
        );
      },
      input: () => ({ cursor: Buffer.from('{"o":2}').toString("base64url"), limit: 2 }),
      name: "reads the next page",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ cursor: "nope" }),
      name: "rejects an invalid cursor",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ kind: "vibes" }),
      name: "rejects an unknown kind",
    },
  ],
  fixture: buildTriageFixture,
  operation: listSuggestions,
});
