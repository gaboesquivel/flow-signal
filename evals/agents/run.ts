// `pnpm eval:agents`: agent behaviour evals with live models (on demand and whenever agent
// instructions, agent tools, or operation descriptions change; part of `pnpm eval`, never
// `pnpm test` or CI). Sends each scenario's request to the real Eve Assistant or Operator agent
// (instructions + tools from agents/*/agent, model from its agent.ts) over a freshly seeded
// test database, then checks the tool calls, their key arguments, and the database state.
// Skips (exit 0) without AI Gateway access; exits 1 when any scenario fails.
//
// Gateway access: AI_GATEWAY_API_KEY, or Vercel OIDC (`VERCEL=1` with VERCEL_OIDC_TOKEN).
// Database: DATABASE_URL_TEST (a local Docker database; anything else is refused), else an
// in-process PGlite. DATABASE_URL is never used.
//
// Options:
//   --only <ids>   comma-separated scenario ids or prefixes (e.g. assistant/, operator/triage-queue)
//   --out <path>   JSON report (default evals/agents/results/latest.json, gitignored)
//   --fake         offline smoke of the harness with a scripted model and fake AI ports
//                  (proves the wiring; not an agent result)
//   --list         print the scenarios and exit
// oxlint-disable eslint/no-await-in-loop -- scenarios share one database and run one at a time
import { refuseInCi } from "@/evals/ci-guard";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createGateway, gateway, generateText, registerTelemetry } from "ai";
import { drizzle } from "drizzle-orm/pglite";

import { gatewayAvailable, gatewayModel } from "@/lib/ai/models";
import { prepareTestDatabase, schemaStatements } from "@/lib/db/prepare-database";
import * as schema from "@/lib/db/schema";
import { createFakeAi, fakeReasoner } from "@/lib/signal/ai/fakes";
import { createGatewayAi } from "@/lib/signal/ai/gateway";
import type { Embedder } from "@/lib/signal/ai/ports";
import { closeSignalDbs, isLocalDatabaseHost, signalDbFor } from "@/lib/signal/db";
import type { SignalDb } from "@/lib/signal/db";
import { configureSuggestionScheduler } from "@/lib/signal/domain/suggestion-generation";
import { configureSignalRuntime } from "@/lib/signal/runtime";

import { pricesFromModelList, summarizeCost, UsageMeter } from "../matching/cost";
import type { CostSummary, PriceTable } from "../matching/cost";
import { percentile } from "../matching/metrics";
import type { CheckResult } from "./checks";
import { scriptedModel } from "./fake-model";
import { seedFixture } from "./fixture";
import { loadAgent, runConversation } from "./harness";
import type { AgentName, LoadedAgent, Transcript } from "./harness";
import { scenarios, selectScenarios } from "./scenarios";

refuseInCi("eval:agents");

const log = (line = "") => console.log(line);
const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${error.cause ? `: ${describeError(error.cause)}` : ""}`
    : String(error);

const { values: args } = parseArgs({
  options: {
    fake: { default: false, type: "boolean" },
    list: { default: false, type: "boolean" },
    only: { type: "string" },
    out: { default: "evals/agents/results/latest.json", type: "string" },
  },
});

const selected = selectScenarios(scenarios, args.only);
if (args.list || selected.length === 0) {
  for (const scenario of scenarios) log(`${scenario.id.padEnd(42)} ${scenario.summary}`);
  if (selected.length === 0) {
    log(`[eval:agents] No scenario matches --only ${args.only}.`);
    process.exit(2);
  }
  process.exit(0);
}

// Nothing here may reach the dev or production database.
delete process.env.DATABASE_URL;

if (!args.fake && !gatewayAvailable()) {
  log(
    "[eval:agents] SKIPPED: no AI Gateway access (set AI_GATEWAY_API_KEY, or run with VERCEL=1 and VERCEL_OIDC_TOKEN). These evals call live models; nothing was checked.",
  );
  process.exit(0);
}

// ---- Database ----
const openDatabase = async (): Promise<{
  close: () => Promise<void>;
  db: SignalDb;
  label: string;
}> => {
  const url = process.env.DATABASE_URL_TEST?.trim();
  if (url) {
    const { hostname, pathname } = new URL(url);
    if (!isLocalDatabaseHost(hostname)) {
      log(
        `[eval:agents] Refusing DATABASE_URL_TEST on ${hostname}: the evals reseed the database, so it must be a local test database.`,
      );
      process.exit(2);
    }
    await prepareTestDatabase(url);
    return { close: closeSignalDbs, db: signalDbFor(url), label: `postgres ${pathname.slice(1)}` };
  }
  const client = new PGlite({ extensions: { vector } });
  for (const statement of await schemaStatements()) await client.exec(statement);
  return {
    close: () => client.close(),
    db: drizzle({ client, schema }) as unknown as SignalDb,
    label: "pglite",
  };
};

/** Need embeddings are identical across reseeds, so embed each text once per run. */
const cachingEmbedder = (inner: Embedder): Embedder => {
  const cache = new Map<string, number[]>();
  return {
    async embed(texts) {
      const missing = [...new Set(texts.filter((item) => !cache.has(item)))];
      if (missing.length > 0) {
        const vectors = await inner.embed(missing);
        for (const [index, item] of missing.entries()) cache.set(item, vectors[index] ?? []);
      }
      return texts.map((item) => cache.get(item) ?? []);
    },
    model: inner.model,
  };
};

const fakeAi = () =>
  createFakeAi({
    reasoner: fakeReasoner({
      decision_brief: () => ({
        options: [
          {
            rationale: "Broad, rising demand.",
            status: "planned",
            tradeoffs: "Delays other work.",
          },
          { rationale: "Unclear fit.", status: "declined", tradeoffs: "Churn risk." },
        ],
        recommendation: { note: "Targeting Q1", status: "planned" },
        summary: "Executives ask to share dashboards with their boards.",
      }),
      demand_summary: () => ({ text: "Dashboard sharing leads demand." }),
    }),
  });

const baseAi = args.fake ? fakeAi() : createGatewayAi();
const ai = { ...baseAi, embedder: cachingEmbedder(baseAi.embedder) };

const database = await openDatabase();
configureSignalRuntime({ ai, db: database.db });
// Suggestion generation after a submit would run live models in the background and race the
// next reseed; these evals check the agent's own calls, so it is switched off.
configureSuggestionScheduler(() => {
  // Not run: see above.
});

const meter = new UsageMeter();
registerTelemetry(meter.telemetry());

const agents = new Map<AgentName, LoadedAgent>();
for (const name of new Set(selected.map((scenario) => scenario.agent)))
  agents.set(name, await loadAgent(name));

// Preflight: one tiny call per agent model, so an unreachable Gateway skips cleanly.
if (!args.fake) {
  try {
    for (const modelId of new Set([...agents.values()].map((agent) => agent.modelId)))
      await generateText({ maxOutputTokens: 5, model: gatewayModel(modelId), prompt: "Say ok." });
  } catch (error) {
    log(`[eval:agents] SKIPPED: the agent model is unavailable (${describeError(error)}).`);
    await database.close();
    process.exit(0);
  }
}
meter.take();

const loadPrices = async (): Promise<PriceTable> => {
  try {
    const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
    const provider = apiKey ? createGateway({ apiKey }) : gateway;
    return pricesFromModelList(await provider.getAvailableModels());
  } catch {
    return {};
  }
};
const prices = args.fake ? {} : await loadPrices();

if (args.fake)
  log(
    "[eval:agents] FAKE: scripted model and fake AI ports. This proves the harness wiring, not agent behaviour.",
  );
log(
  `[eval:agents] ${selected.length} scenarios on ${database.label}; models: ${[...agents.values()]
    .map((agent) => `${agent.name} ${args.fake ? "scripted" : agent.modelId}`)
    .join(", ")}`,
);

// ---- Run ----
interface ScenarioResult {
  agent: AgentName;
  checks: CheckResult[];
  cost: CostSummary;
  error?: string;
  id: string;
  ms: number;
  passed: boolean;
  transcript?: Transcript;
}

const short = (value: unknown, max = 160) => {
  const json = JSON.stringify(value) ?? "undefined";
  return json.length > max ? `${json.slice(0, max)}…` : json;
};

const results: ScenarioResult[] = [];
for (const scenario of selected) {
  const agent = agents.get(scenario.agent);
  if (!agent) throw new Error(`Agent ${scenario.agent} was not loaded`);
  const started = performance.now();
  let transcript: Transcript | undefined;
  let checks: CheckResult[] = [];
  let error: string | undefined;
  try {
    const fixture = await seedFixture(database.db, ai.embedder);
    // Seeding embeddings are not the scenario's spend.
    meter.take();
    transcript = await runConversation({
      agent,
      followUps: scenario.followUps,
      model: args.fake ? scriptedModel(scenario.script(fixture)) : gatewayModel(agent.modelId),
      prompt: scenario.prompt,
      sessionId: `eval-${scenario.id}`,
      until: scenario.until,
    });
    checks = await scenario.check(transcript, fixture);
  } catch (error_) {
    error = describeError(error_);
  }
  const ms = Math.round(performance.now() - started);
  const cost = summarizeCost(meter.take(), prices);
  const passed = !error && checks.length > 0 && checks.every((item) => item.pass);
  results.push({
    agent: scenario.agent,
    checks,
    cost,
    error,
    id: scenario.id,
    ms,
    passed,
    transcript,
  });

  log();
  log(
    `${passed ? "PASS" : "FAIL"}  ${scenario.id}  (${(ms / 1000).toFixed(1)} s, $${cost.totalUsd.toFixed(4)})`,
  );
  log(`      ${scenario.summary}`);
  for (const [index, turn] of (transcript?.turns ?? []).entries()) {
    log(`      turn ${index + 1} (${(turn.ms / 1000).toFixed(1)} s, ${turn.steps} steps)`);
    for (const call of transcript?.toolCalls.filter((item) => item.turn === index) ?? [])
      log(
        `        → ${call.name} ${short(call.input)}${call.errorCode ? `  ✗ ${call.errorCode}` : ""}${call.available ? ` (${call.ms} ms)` : " (not available)"}`,
      );
    log(`        ↳ ${short(turn.text.replaceAll(/\s+/gu, " "), 200)}`);
  }
  for (const item of checks)
    log(
      `      ${item.pass ? "✓" : "✗"} ${item.label}${!item.pass && item.detail ? `: ${item.detail}` : ""}`,
    );
  if (error) log(`      ✗ error: ${error}`);
}

await database.close();

// ---- Summary ----
const passedCount = results.filter((result) => result.passed).length;
const spend = results.reduce((sum, result) => sum + result.cost.totalUsd, 0);
const unpriced = results.reduce((sum, result) => sum + result.cost.unpricedCalls, 0);
const calls = results.reduce((sum, result) => sum + result.cost.calls, 0);
const durations = results.map((result) => result.ms);
log();
log(`Scenarios: ${passedCount}/${results.length} passed`);
for (const name of agents.keys()) {
  const mine = results.filter((result) => result.agent === name);
  log(`  ${name.padEnd(9)} ${mine.filter((result) => result.passed).length}/${mine.length}`);
}
log(
  `Latency per scenario: p50 ${((percentile(durations, 50) ?? 0) / 1000).toFixed(1)} s, p95 ${((percentile(durations, 95) ?? 0) / 1000).toFixed(1)} s`,
);
log(
  args.fake
    ? `Model spend: none (scripted model, ${calls} calls)`
    : `Model spend: $${spend.toFixed(4)} over ${calls} model calls (agent turns plus the operations' own AI)${unpriced ? `; ${unpriced} calls unpriced, so this is a lower bound` : ""}`,
);

const out = path.resolve(args.out ?? "evals/agents/results/latest.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(
  out,
  `${JSON.stringify(
    {
      fake: args.fake,
      models: Object.fromEntries([...agents.values()].map((agent) => [agent.name, agent.modelId])),
      passed: passedCount,
      ranAt: new Date().toISOString(),
      results,
      spendUsd: spend,
      total: results.length,
    },
    null,
    2,
  )}\n`,
);
log(`Report: ${path.relative(process.cwd(), out)}`);

if (passedCount < results.length) {
  log(`[eval:agents] FAILED: ${results.length - passedCount} scenario(s) failed.`);
  process.exit(1);
}
