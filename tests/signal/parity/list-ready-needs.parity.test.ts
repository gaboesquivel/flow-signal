import { listReadyNeeds } from "../../../lib/signal/operations/list-ready-needs";
import { buildReadinessFixture, markReady } from "../support/readiness-fixture";
import { runParityTable } from "./harness";

const fixture = async (db: Parameters<typeof buildReadinessFixture>[0]) => {
  const f = await buildReadinessFixture(db);
  const brief = await markReady(db, f.big.need.id, new Date("2026-10-20T09:00:00Z"), {});
  await markReady(db, f.small.need.id, new Date("2026-10-25T09:00:00Z"));
  // Decided needs are never listed, even with ready_at set.
  await markReady(db, f.decided.need.id, new Date("2026-10-10T09:00:00Z"));
  return { ...f, brief: brief! };
};

runParityTable({
  cases: [
    {
      expect: (f) => ({
        output: {
          needs: [
            {
              arrCents: 30_000_000,
              brief: {
                recommendation: { note: "Targeting Q1", status: "planned" },
                status: "pending",
                suggestionId: f.brief.id,
              },
              needId: f.big.need.id,
              readyAt: "2026-10-20T09:00:00.000Z",
              statement: f.big.need.statement,
              supporters: 1,
            },
            {
              arrCents: 1_000_000,
              brief: null,
              needId: f.small.need.id,
              readyAt: "2026-10-25T09:00:00.000Z",
              statement: f.small.need.statement,
              supporters: 2,
            },
          ],
          nextCursor: null,
        },
      }),
      input: () => ({}),
      name: "lists undecided ready needs oldest first, with the latest brief or null",
    },
    {
      check: (output) => {
        const page = output as { needs: unknown[]; nextCursor: string | null };
        if (page.needs.length !== 1 || page.nextCursor === null)
          throw new Error("expected one need and a cursor");
      },
      input: () => ({ limit: 1 }),
      name: "pages with a cursor",
    },
    {
      expect: () => ({ error: "validation_failed" }),
      input: () => ({ cursor: "not-a-cursor" }),
      name: "rejects a bad cursor",
    },
  ],
  fixture,
  operation: listReadyNeeds,
});
