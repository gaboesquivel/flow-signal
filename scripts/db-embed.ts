// `pnpm db:embed`: embeds every live need that has no embedding (seeded without Gateway access,
// or created while the embedder was down), so `preview_signal` can retrieve it, then runs the
// duplicate sweep (spec 009) so drafts that just got a vector get their merge check. Idempotent:
// embedded needs are skipped and checked drafts are not due, so it is safe to rerun. Needs AI
// Gateway access.
//   pnpm db:embed          # DATABASE_URL
//   pnpm db:embed --test   # DATABASE_URL_TEST
import { gatewayAvailable } from "@/lib/ai/models";
import { createGatewayAi, gatewayEmbedder } from "@/lib/signal/ai/gateway";
import { systemClock } from "@/lib/signal/context";
import { closeSignalDbs, signalDbFor } from "@/lib/signal/db";
import { sweepDuplicates } from "@/lib/signal/domain/duplicate-backstop";
import { embedMissingNeeds } from "@/lib/signal/domain/embeddings";

const test = process.argv.slice(2).includes("--test");
const variable = test ? "DATABASE_URL_TEST" : "DATABASE_URL";
const databaseUrl = process.env[variable]?.trim();
if (!databaseUrl) {
  console.error(`[db:embed] ${variable} is not set.`);
  process.exit(1);
}
if (!gatewayAvailable()) {
  console.error("[db:embed] No AI Gateway access (set AI_GATEWAY_API_KEY); nothing embedded.");
  process.exit(1);
}

try {
  const embedder = gatewayEmbedder();
  console.log(
    `[db:embed] Embedding needs without an embedding in ${variable} (${embedder.model}) ...`,
  );
  const db = signalDbFor(databaseUrl);
  const count = await embedMissingNeeds(db, embedder);
  console.log(`[db:embed] Done: ${count} need(s) embedded.`);
  const swept = await sweepDuplicates(
    { ai: createGatewayAi(), clock: systemClock, db },
    { checks: 20 },
  );
  const proposed = swept.checked.reduce((total, check) => total + check.proposed.length, 0);
  console.log(
    `[db:embed] Duplicate sweep: ${swept.checked.length} draft(s) checked, ${proposed} merge(s) proposed, ${swept.unavailable} unavailable.`,
  );
} finally {
  await closeSignalDbs();
}
