import { getStrategy } from "../../../lib/signal/operations/get-strategy";
import { strategies } from "../../../lib/db/schema";
import { insertTheme } from "../support/builders";
import { runParityTable } from "./harness";

const defaults = { readinessArrCents: 25_000_000, readinessSupporters: 5 };

runParityTable({
  cases: [
    {
      expect: (f: { reporting: { id: string } }) => ({
        output: {
          defaults,
          strategy: {
            capacityPerQuarter: 3,
            createdAt: "2026-10-30T09:00:00.000Z",
            focusThemes: [{ id: f.reporting.id, name: "Reporting" }],
            notes: null,
            readinessArrCents: 25_000_000,
            readinessSupporters: 5,
            revenueFocus: "mid-market retention",
            version: 2,
          },
        },
      }),
      input: () => ({}),
      name: "returns the highest version with its focus themes and the default line",
    },
  ],
  fixture: async (db) => {
    const reporting = await insertTheme(db, { name: "Reporting" });
    await db.insert(strategies).values([
      {
        capacityPerQuarter: 1,
        createdAt: new Date("2026-10-01T09:00:00Z"),
        createdByKind: "human",
        readinessArrCents: 0,
        readinessSupporters: 2,
        revenueFocus: "enterprise",
        version: 1,
      },
      {
        capacityPerQuarter: 3,
        createdAt: new Date("2026-10-30T09:00:00Z"),
        createdByKind: "human",
        focusThemeIds: [reporting.id],
        readinessArrCents: 25_000_000,
        readinessSupporters: 5,
        revenueFocus: "mid-market retention",
        version: 2,
      },
    ]);
    return { reporting };
  },
  operation: getStrategy,
});
