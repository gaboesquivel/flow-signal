import assert from "node:assert/strict";

import type { OperatorNeed } from "../../../lib/signal/domain/operator-needs";
import { listOperatorNeeds } from "../../../lib/signal/operations/list-operator-needs";
import { buildPrioritizationFixture } from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";
import { runParityTable } from "./harness";

const ids = (output: unknown) => (output as { needs: OperatorNeed[] }).needs.map((need) => need.id);

runParityTable<PrioritizationFixture>({
  cases: [
    {
      check: (output, fx) => {
        assert.deepEqual(ids(output), [
          fx.n1.need.id,
          fx.n2.need.id,
          fx.n3.need.id,
          fx.declined.need.id,
          fx.outage.need.id,
        ]);
        const [n1] = (output as { needs: OperatorNeed[] }).needs;
        assert.deepEqual(n1, {
          accounts: 2,
          arrCents: 54_000_000,
          criterionScores: { business_value: 5, demand: 4, effort: 2, strategic_fit: 4 },
          id: fx.n1.need.id,
          openDealCents: 12_000_000,
          pendingSuggestions: 0,
          people: 6,
          score: 4.1,
          statement: fx.n1.need.statement,
          status: "open",
          theme: { id: fx.reporting.id, name: "Reporting" },
        });
      },
      input: () => ({}),
      name: "lists live needs by priority, unscored last, then people",
    },
    {
      check: (output, fx) =>
        assert.deepEqual(ids(output).slice(0, 3), [fx.n1.need.id, fx.n2.need.id, fx.n3.need.id]),
      input: () => ({ sort: "people" }),
      name: "sorts by people",
    },
    {
      check: (output, fx) => assert.deepEqual(ids(output), [fx.n1.need.id, fx.n3.need.id]),
      input: (fx) => ({ themeId: fx.reporting.id }),
      name: "filters by theme",
    },
    {
      check: (output, fx) => assert.deepEqual(ids(output), [fx.n2.need.id]),
      input: () => ({ query: "audits", sort: "accounts", status: "open" }),
      name: "filters by status and words",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ sort: "score" }),
      name: "rejects an unknown sort",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ status: "merged" }),
      name: "rejects merged as a status filter",
    },
  ],
  fixture: buildPrioritizationFixture,
  operation: listOperatorNeeds,
});
