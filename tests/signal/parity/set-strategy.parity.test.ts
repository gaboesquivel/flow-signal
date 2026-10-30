import assert from "node:assert/strict";

import { setStrategy } from "../../../lib/signal/operations/set-strategy";
import { buildReadinessFixture } from "../support/readiness-fixture";
import { runParityTable } from "./harness";

const line = { readinessArrCents: 25_000_000, readinessSupporters: 5 };
const input = { capacityPerQuarter: 3, revenueFocus: "mid-market retention", ...line };

runParityTable({
  cases: [
    {
      check: (output, f) => {
        const { newlyReady, strategy } = output as {
          newlyReady: number;
          strategy: { focusThemes: unknown; version: number };
        };
        // `big` ($300k ARR) crosses the $250k line; `small` does not; `decided` is decided.
        assert.equal(newlyReady, 1);
        assert.equal(strategy.version, 1);
        assert.deepEqual(strategy.focusThemes, [{ id: f.reporting.id, name: "Reporting" }]);
      },
      input: (f) => ({ ...input, focusThemeIds: [f.reporting.id] }),
      name: "stores version 1 and marks needs over the line ready",
    },
    {
      check: (output) => assert.equal((output as { newlyReady: number }).newlyReady, 2),
      input: () => ({ ...input, focusThemeIds: [], readinessSupporters: 2 }),
      name: "a lower supporter line makes both live needs ready",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ ...input, focusThemeIds: ["6f1c2a8e-3a4b-4c5d-8e9f-0a1b2c3d4e5f"] }),
      name: "rejects an unknown theme id",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ ...input, capacityPerQuarter: -1, focusThemeIds: [] }),
      name: "rejects negative capacity",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({
        ...input,
        focusThemeIds: [],
        readinessArrCents: 0,
        readinessSupporters: 0,
      }),
      name: "rejects an empty readiness line",
    },
  ],
  fixture: buildReadinessFixture,
  mutates: true,
  operation: setStrategy,
});
