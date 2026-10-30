import assert from "node:assert/strict";

import type { DemandSummary } from "../../../lib/signal/domain/demand";
import { getDemandSummary } from "../../../lib/signal/operations/get-demand-summary";
import { buildPrioritizationFixture } from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";
import { runParityTable } from "./harness";

const summary = (output: unknown) => output as DemandSummary;

runParityTable<PrioritizationFixture>({
  cases: [
    {
      expect: (fx) => ({
        output: {
          ai: "ok",
          needs: [
            {
              accounts: [
                { accountId: fx.acme.id, name: "Acme Corp", plan: "Enterprise" },
                { accountId: fx.globex.id, name: "Globex", plan: "Growth" },
              ],
              businessValueCents: 66_000_000,
              needId: fx.n1.need.id,
              newSupportersInWindow: 5,
              priorityScore: 4.1,
              statement: fx.n1.need.statement,
              status: "open",
              supporters: 6,
              themeId: fx.reporting.id,
              trend: "rising",
            },
            {
              accounts: [{ accountId: fx.acme.id, name: "Acme Corp", plan: "Enterprise" }],
              businessValueCents: 60_000_000,
              needId: fx.n2.need.id,
              newSupportersInWindow: 5,
              priorityScore: 2,
              statement: fx.n2.need.statement,
              status: "open",
              supporters: 5,
              themeId: fx.compliance.id,
              trend: "falling",
            },
            {
              accounts: [],
              businessValueCents: 0,
              needId: fx.n3.need.id,
              newSupportersInWindow: 4,
              priorityScore: null,
              statement: fx.n3.need.statement,
              status: "open",
              supporters: 4,
              themeId: fx.reporting.id,
              trend: "steady",
            },
          ],
          summary: { model: "fake/reasoner", text: "Top demand: dashboard sharing." },
          window: { since: "2026-08-01T09:00:00.000Z", until: "2026-10-30T09:00:00.000Z" },
        },
      }),
      input: () => ({}),
      name: "orders live needs by priority with supporters, accounts, value, and trend",
    },
    {
      check: (output, fx) => {
        assert.deepEqual(
          summary(output).needs.map((need) => need.needId),
          [fx.n1.need.id, fx.n2.need.id],
        );
      },
      input: (fx) => ({ accountId: fx.acme.id }),
      name: "filters to needs an account supports",
    },
    {
      check: (output, fx) => {
        const result = summary(output);
        assert.deepEqual(
          result.needs.map((need) => need.needId),
          [fx.n1.need.id],
        );
        assert.equal(result.needs[0]!.newSupportersInWindow, 2);
        assert.equal(result.window.since, "2026-10-08T00:00:00.000Z");
      },
      input: (fx) => ({ limit: 1, since: "2026-10-08", themeId: fx.reporting.id }),
      name: "filters by theme, counts new supporters since `since`, and applies the limit",
    },
    {
      check: (output, fx) => {
        assert.deepEqual(
          summary(output).needs.map((need) => need.needId),
          [fx.n1.need.id],
        );
      },
      input: () => ({ plan: "Growth" }),
      name: "filters to needs an account on a plan supports",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ plan: "Platinum" }),
      name: "rejects an unknown plan",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ limit: 51 }),
      name: "rejects a limit above 50",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ since: "2027-01-01" }),
      name: "rejects a window that starts in the future",
    },
  ],
  fixture: buildPrioritizationFixture,
  operation: getDemandSummary,
});
