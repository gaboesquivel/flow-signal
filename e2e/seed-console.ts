// Seeds the Playwright database for the PM console specs (spec 006 task 05): the demo
// workspace, plus a pending merge and a pending split so every Triage kind is on screen.
// Destructive: refuses anything but a local database. Run by e2e/global-setup.ts.
import { eq, like } from "drizzle-orm";

import { prepareTestDatabase } from "@/lib/db/prepare-database";
import { needs, signals, suggestions } from "@/lib/db/schema";
import { closeSignalDbs, isLocalDatabaseHost, signalDbFor } from "@/lib/signal/db";
import { seedDemoWorkspace } from "@/lib/signal/seed/demo-workspace";

const databaseUrl = process.env.E2E_DATABASE_URL?.trim() ?? "";
if (!databaseUrl || !isLocalDatabaseHost(new URL(databaseUrl).hostname)) {
  console.error("[e2e:seed] E2E_DATABASE_URL must point at a local database (pnpm db:up).");
  process.exit(1);
}

await prepareTestDatabase(databaseUrl);
const db = signalDbFor(databaseUrl);
try {
  const { needIds } = await seedDemoWorkspace(db, {});
  const { n1 } = needIds;
  if (!n1) throw new Error("Seed changed: N1 not found.");
  const [draft] = await db
    .select({ id: needs.id })
    .from(needs)
    .where(like(needs.statement, "International teams need dashboards%"));
  const n1Signals = await db
    .select({ id: signals.id })
    .from(signals)
    .where(eq(signals.needId, n1))
    .orderBy(signals.createdAt);
  if (!draft || n1Signals.length < 3) throw new Error("Seed changed: e2e fixtures not found.");

  const now = Date.now();
  await db.insert(suggestions).values([
    {
      createdAt: new Date(now - 60_000),
      kind: "split",
      model: "e2e",
      needId: n1,
      payload: {
        reason: "Two of these ask for a scheduled PDF, not a shareable snapshot.",
        signalIds: n1Signals.slice(0, 2).map((signal) => signal.id),
        statement: "Finance leads need a monthly PDF of the revenue dashboard for the board pack",
      },
      signalIds: n1Signals.slice(0, 2).map((signal) => signal.id),
    },
    {
      createdAt: new Date(now),
      kind: "merge",
      model: "e2e",
      needId: draft.id,
      payload: {
        intoNeedId: n1,
        reason: "Both want dashboards others can read without help.",
      },
      relatedNeedId: n1,
    },
  ]);
  console.log(`[e2e:seed] Seeded. N1 ${n1}`);
} finally {
  await closeSignalDbs();
}
