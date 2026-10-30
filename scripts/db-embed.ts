// `pnpm db:embed`: embeds every live need that has no embedding (seeded without Gateway access,
// or created while the embedder was down), so `preview_signal` can retrieve it. Idempotent:
// embedded needs are skipped, so it is safe to rerun. Needs AI Gateway access.
//   pnpm db:embed          # DATABASE_URL
//   pnpm db:embed --test   # DATABASE_URL_TEST
import { gatewayAvailable } from "@/lib/ai/models";
import { gatewayEmbedder } from "@/lib/signal/ai/gateway";
import { closeSignalDbs, signalDbFor } from "@/lib/signal/db";
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
  const count = await embedMissingNeeds(signalDbFor(databaseUrl), embedder);
  console.log(`[db:embed] Done: ${count} need(s) embedded.`);
} finally {
  await closeSignalDbs();
}
