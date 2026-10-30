// `pnpm db:seed`: loads the deterministic demo workspace into the database at DATABASE_URL,
// replacing all Signal data there. Example for the test branch:
//   node --env-file=.env.local --import tsx scripts/db-seed.ts --test
// Embeds need statements when AI Gateway access is available (skip with --no-embed).
import { gatewayAvailable } from "@/lib/ai/models";
import { gatewayEmbedder } from "@/lib/signal/ai/gateway";
import { closeSignalDbs, signalDbFor } from "@/lib/signal/db";
import { seedDemoWorkspace } from "@/lib/signal/seed/demo-workspace";

const args = new Set(process.argv.slice(2));
const databaseUrl = (
  args.has("--test") ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL
)?.trim();
if (!databaseUrl) {
  console.error(
    `[db:seed] ${args.has("--test") ? "DATABASE_URL_TEST" : "DATABASE_URL"} is not set.`,
  );
  process.exit(1);
}

const embed = !args.has("--no-embed") && gatewayAvailable();
if (!embed)
  console.warn("[db:seed] Not embedding need statements (no AI Gateway access or --no-embed).");

console.log(
  `[db:seed] Seeding the demo workspace into ${args.has("--test") ? "DATABASE_URL_TEST" : "DATABASE_URL"} ...`,
);
try {
  const summary = await seedDemoWorkspace(signalDbFor(databaseUrl), {
    embedder: embed ? gatewayEmbedder() : undefined,
  });
  const { needIds, ...counts } = summary;
  console.log("[db:seed] Done:", counts);
  console.log(`[db:seed] N1 ${needIds.n1}  N2 ${needIds.n2}`);
} finally {
  await closeSignalDbs();
}
