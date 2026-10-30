// `pnpm db:test:setup`: creates the DATABASE_URL_TEST database behind the local Neon proxy
// (`pnpm db:up` first) and applies the Drizzle schema with pgvector. The test harness does the
// same on demand; run this to prepare a database by hand (e.g. before `db:seed --test`).
import { prepareTestDatabase } from "@/lib/db/prepare-database";

const databaseUrl = process.env.DATABASE_URL_TEST?.trim();
if (!databaseUrl) {
  console.error("[db:test:setup] DATABASE_URL_TEST is not set (see .env.example).");
  process.exit(1);
}
const { created } = await prepareTestDatabase(databaseUrl);
console.log(`[db:test:setup] ${created ? "Schema applied" : "Schema already current"}.`);
