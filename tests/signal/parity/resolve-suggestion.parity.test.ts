import assert from "node:assert/strict";

import { resolveSuggestion } from "../../../lib/signal/operations/resolve-suggestion";
import { buildTriageFixture } from "../support/triage-fixture";
import { runParityTable } from "./harness";

interface Resolution {
  result: Record<string, unknown> | null;
  suggestion: { id: string; kind: string; resolvedByKind: string | null; status: string };
}

runParityTable({
  cases: [
    {
      check: (output, f) => {
        const { result, suggestion } = output as Resolution;
        assert.equal(suggestion.id, f.suggestions.merge.id);
        assert.equal(suggestion.status, "accepted");
        assert.equal(suggestion.resolvedByKind, "agent");
        assert.equal(result?.intoNeedId, f.n1.need.id);
      },
      input: (f) => ({ action: "accept", id: f.suggestions.merge.id }),
      name: "accepting a merge performs it",
    },
    {
      check: (output) => {
        const { result, suggestion } = output as Resolution;
        assert.equal(suggestion.status, "edited");
        assert.equal(result?.publicSummary, "Leaders bring current numbers to board meetings.");
      },
      input: (f) => ({
        action: "edit",
        edit: { summary: "Leaders bring current numbers to board meetings." },
        id: f.suggestions.summary.id,
      }),
      name: "editing a public summary approves the edited text",
    },
    {
      check: (output) => assert.equal((output as Resolution).suggestion.status, "rejected"),
      input: (f) => ({ action: "reject", id: f.suggestions.theme.id }),
      name: "rejects a theme suggestion",
    },
    {
      check: (output, f) => {
        const { result } = output as Resolution;
        assert.equal(result?.fromNeedId, f.n1.need.id);
      },
      input: (f) => ({ action: "accept", id: f.suggestions.split.id }),
      name: "accepting a split performs it",
    },
    {
      check: (output) => assert.equal((output as Resolution).result?.status, "open"),
      input: (f) => ({ action: "accept", id: f.suggestions.draftNeed.id }),
      name: "accepting a draft need approves it",
    },
    {
      check: (output, f) => {
        const { result } = output as Resolution;
        assert.equal(result?.needId, f.n2.need.id);
        assert.deepEqual(result?.scores, [
          { criterion: "demand", reason: "One supporter.", score: 1, source: "ai" },
          { criterion: "business_value", reason: "PM: two big deals.", score: 4, source: "pm" },
        ]);
      },
      input: (f) => ({
        action: "edit",
        edit: { reasons: { business_value: "PM: two big deals." }, scores: { business_value: 4 } },
        id: f.suggestions.priority.id,
      }),
      name: "editing a priority suggestion stores PM overrides",
    },
    {
      check: (output) =>
        assert.deepEqual((output as Resolution).result?.markdown, "## N1\n\nShip PDF export."),
      input: (f) => ({ action: "accept", id: f.suggestions.brief.id }),
      name: "accepts a decision brief",
    },
    {
      check: (output) => {
        const { result, suggestion } = output as Resolution & {
          suggestion: { payload: Record<string, unknown> };
        };
        assert.equal(result?.markdown, "## N1\n\nPlan for Q1.");
        assert.equal(suggestion.payload.markdown, "## N1\n\nPlan for Q1.");
        assert.equal(suggestion.payload.originalMarkdown, "## N1\n\nShip PDF export.");
      },
      input: (f) => ({
        action: "edit",
        edit: { markdown: "## N1\n\nPlan for Q1." },
        id: f.suggestions.brief.id,
      }),
      name: "edits a decision brief",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (f) => ({
        action: "edit",
        edit: { scores: { demand: 9 } },
        id: f.suggestions.priority.id,
      }),
      name: "validates a priority edit",
    },
    {
      expect: () => ({ error: "conflict" }),
      input: (f) => ({ action: "accept", id: f.suggestions.rejected.id }),
      name: "returns conflict for a resolved suggestion",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (f) => ({ action: "edit", id: f.suggestions.summary.id }),
      name: "requires edit fields with action edit",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: (f) => ({ action: "edit", edit: { summary: "" }, id: f.suggestions.summary.id }),
      name: "validates edit fields by kind",
    },
    {
      expect: () => ({ error: "not_found" }),
      input: () => ({ action: "accept", id: "00000000-0000-4000-8000-000000000000" }),
      name: "returns not_found for an unknown suggestion",
    },
  ],
  fixture: buildTriageFixture,
  mutates: true,
  operation: resolveSuggestion,
});
