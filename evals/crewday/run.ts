// `pnpm eval:crewday`: Signal vs. the vote board on a Crewday world (spec 004, task 04). Replays
// the world's year through both arms in simulated time, scores them against hidden ground truth,
// and prints the report: keyword-findable share, headline business outcomes, PRODUCT.md metrics,
// diagnostics, guardrails (each with a 95% interval and its success-criterion verdict), what is
// not measured, and the planted-PII result. Live models; skips (exit 0) without AI Gateway access.
// Never in CI.
//
// Options:
//   --world dev|test|fixture  world to replay (default dev). `test` is held out: acceptance runs only.
//   --arm signal|board|both   arms to run (default both; arms run one after the other)
//   --seed <n>                policy and bootstrap seed (default 1)
//   --out <path>              JSON report (default evals/crewday/results/latest.json, gitignored)
//   --limit-weeks <n>         smoke runs only: stop the replay after n weeks (never a result)
//   --database-url <url>      local Docker test database instead of in-process PGlite
//   --pm-policy oracle|follows_signal
//                             PM decision policy (default oracle, spec 004). follows_signal
//                             (spec 007, Signal arm only) publishes Signal's recommendations
//   --pm-override <p>         follows_signal: chance of publishing the strategy-implied status
//                             instead of the recommendation (default 0.2)
// oxlint-disable eslint/no-await-in-loop -- runtime overrides are process-wide, so arms run one at a time
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { registerTelemetry } from "ai";

import {
  gatewayAvailable,
  signalEmbeddingModelId,
  signalFastModelId,
  signalReasoningModelId,
} from "@/lib/ai/models";
import { createGatewayAi } from "@/lib/signal/ai/gateway";
import type { Embedder, SignalAi } from "@/lib/signal/ai/ports";

import { summarizeCost } from "../matching/cost";
import type { PriceTable } from "../matching/cost";

import { isCounted } from "./checks";
import type { World, WorldName } from "./format";
import { HELD_OUT } from "./held-out";
import { buildTable, renderReport } from "./report";
import type { ArmName, ArmRunInfo, CrewdayReport } from "./report";
import { compareArms, NOT_MEASURED, scoreRun } from "./score";
import type { ArmScore } from "./score";
import {
  createOfflineSignalAi,
  createOracleEmbedder,
  defaultPolicy,
  keywordRank,
  pmPolicies,
  resolvePolicy,
  runArm,
} from "./sim";
import type { PmPolicy, PolicyParams, SimDatabaseTarget } from "./sim";
import { BucketedUsage, loadGatewayPrices } from "./spend";
import { loadWorld } from "./world";

export const WORLD_VERSION = "v1";
const worldNames = ["dev", "test", "fixture"] as const;
const armChoices = ["signal", "board", "both"] as const;

export interface CrewdayOptions {
  arm: (typeof armChoices)[number];
  db: SimDatabaseTarget;
  limitWeeks: number | null;
  out: string;
  pPmOverride: number;
  pmPolicy: PmPolicy;
  seed: number;
  world: WorldName;
}

export const parseCrewdayArgs = (argv: string[]): CrewdayOptions => {
  const { values } = parseArgs({
    args: argv,
    options: {
      arm: { default: "both", type: "string" },
      "database-url": { type: "string" },
      "limit-weeks": { type: "string" },
      out: { default: "evals/crewday/results/latest.json", type: "string" },
      "pm-override": { default: String(defaultPolicy.pPmOverride), type: "string" },
      "pm-policy": { default: defaultPolicy.pmPolicy, type: "string" },
      seed: { default: "1", type: "string" },
      world: { default: "dev", type: "string" },
    },
  });
  const world = values.world as WorldName;
  if (!worldNames.includes(world))
    throw new Error(`--world must be one of ${worldNames.join("|")}`);
  const arm = values.arm as CrewdayOptions["arm"];
  if (!armChoices.includes(arm)) throw new Error(`--arm must be one of ${armChoices.join("|")}`);
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  const limit = values["limit-weeks"];
  const limitWeeks = limit === undefined ? null : Number(limit);
  if (limitWeeks !== null && !(Number.isInteger(limitWeeks) && limitWeeks > 0))
    throw new Error("--limit-weeks must be a positive integer");
  const pmPolicy = values["pm-policy"] as PmPolicy;
  if (!pmPolicies.includes(pmPolicy))
    throw new Error(`--pm-policy must be one of ${pmPolicies.join("|")}`);
  const pPmOverride = Number(values["pm-override"]);
  if (!(Number.isFinite(pPmOverride) && pPmOverride >= 0 && pPmOverride <= 1))
    throw new Error("--pm-override must be a probability between 0 and 1");
  const url = values["database-url"];
  return {
    arm,
    db: url ? { kind: "url", url } : { kind: "pglite" },
    limitWeeks,
    out: values.out ?? "evals/crewday/results/latest.json",
    pPmOverride,
    pmPolicy,
    seed,
    world,
  };
};

/** Loads a world. The test world needs the held-out capability; only this entry point has it. */
export const loadCrewdayWorld = (name: WorldName) =>
  name === "test"
    ? loadWorld("test", WORLD_VERSION, { heldOut: HELD_OUT })
    : loadWorld(name, WORLD_VERSION);

/**
 * The world's keyword-findable share: from its manifest (the generator's leakage check), else a
 * runner estimate with the board's ranking: counted signals whose need already existed and whose
 * true need ranks first among the world's needs for the signal's title and body.
 */
export const keywordFindableShare = (world: World) => {
  if (world.manifest.keywordFindableShare !== null)
    return { source: "manifest" as const, value: world.manifest.keywordFindableShare };
  const documents = world.needs.map((need) => ({
    createdAt: 0,
    id: need.key,
    supporters: 0,
    text: [need.statement, ...need.solutions].join(" ").toLowerCase(),
  }));
  const eligible = world.signals.filter((s) => isCounted(s) && s.labels.existedAtTime);
  if (eligible.length === 0) return { source: null, value: null };
  const found = eligible.filter((signal) => {
    const [top] = keywordRank(`${signal.title} ${signal.body}`, documents);
    return top !== undefined && signal.labels.needKeys.includes(top.document.id);
  }).length;
  return { source: "runner estimate" as const, value: found / eligible.length };
};

/** Drops signals after the smoke limit so the scorer sees the same truncated world. */
const truncate = (world: World, limitWeeks: number | null): World => {
  if (limitWeeks === null) return world;
  const start = Date.parse(world.manifest.startsAt ?? world.signals[0]?.at ?? "");
  const end = start + limitWeeks * 7 * 86_400_000;
  return { ...world, signals: world.signals.filter((signal) => Date.parse(signal.at) < end) };
};

const gitSha = () => {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" }).trim().length > 0;
    return { dirty, sha };
  } catch {
    return { dirty: false, sha: null };
  }
};

export interface CrewdayDeps {
  /** Signal arm AI ports (live: `createGatewayAi()`). */
  signalAi: () => SignalAi;
  /** The PM oracle's embedder, independent of Signal's (live: `createOracleEmbedder`; eval overhead). */
  oracleEmbedder: () => Embedder;
  log?: (line: string) => void;
  mode: "live" | "offline";
  /** Live spend meter (registered as AI SDK telemetry) and price table; omitted offline. */
  usage?: BucketedUsage;
  prices?: PriceTable;
}

interface ArmInput {
  arm: ArmName;
  deps: CrewdayDeps;
  log: (line: string) => void;
  options: CrewdayOptions;
  policy: PolicyParams;
  prices: PriceTable;
  world: World;
}

/** The Signal arm's ports, with the oracle's embeddings metered as eval overhead. */
const signalPorts = ({ deps }: ArmInput) => {
  const oracle = deps.oracleEmbedder();
  const { usage } = deps;
  return {
    ai: deps.signalAi(),
    oracleEmbedder: usage
      ? {
          embed: (texts: string[]) => usage.within("oracle", () => oracle.embed(texts)),
          model: oracle.model,
        }
      : oracle,
  };
};

/** Replays and scores one arm; its runtime spend is everything metered while it ran. */
const runOneArm = async (input: ArmInput) => {
  const { arm, log, options, prices, world } = input;
  const { usage } = input.deps;
  usage?.drain("runtime");
  const started = performance.now();
  const run = await runArm({
    arm,
    db: options.db,
    ...(arm === "signal" ? signalPorts(input) : {}),
    ...(options.limitWeeks ? { limitWeeks: options.limitWeeks } : {}),
    onProgress: (message) => log(`  ${message}`),
    policy: input.policy,
    seed: options.seed,
    ...(usage ? { spendUsd: () => summarizeCost(usage.calls("runtime"), prices).totalUsd } : {}),
    world,
  });
  const score = scoreRun(world, run);
  const info: ArmRunInfo = {
    aiCalls: score.aiCalls,
    spend: usage ? summarizeCost(usage.drain("runtime"), prices) : null,
    surfaceMix: run.surfaceMix,
    wallTimeMs: performance.now() - started,
    weeks: run.weeks,
  };
  return { info, score };
};

const piiResult = (
  arms: ArmName[],
  scores: Partial<Record<ArmName, ArmScore>>,
): CrewdayReport["pii"] => {
  const leaks = arms.flatMap((arm) =>
    (scores[arm]?.diagnostics.piiScan.leaks ?? []).map((leak) => ({ arm, ...leak })),
  );
  const first = scores[arms[0] ?? "signal"];
  return {
    leaks,
    ok: first ? leaks.length === 0 : null,
    planted: first?.diagnostics.piiScan.planted ?? [],
    summariesChecked: Object.fromEntries(
      arms.map((arm) => [arm, scores[arm]?.diagnostics.piiScan.summariesChecked ?? 0]),
    ),
  };
};

const spendResult = (
  usage: BucketedUsage | undefined,
  runs: Partial<Record<ArmName, ArmRunInfo>>,
  prices: PriceTable,
): CrewdayReport["spend"] => {
  if (!usage) return { oracleUsd: null, totalUsd: null, unpricedCalls: 0 };
  const oracle = summarizeCost(usage.drain("oracle"), prices);
  const all = [...Object.values(runs).flatMap((run) => (run.spend ? [run.spend] : [])), oracle];
  return {
    oracleUsd: oracle.totalUsd,
    totalUsd: all.reduce((sum, s) => sum + s.totalUsd, 0),
    unpricedCalls: all.reduce((sum, s) => sum + s.unpricedCalls, 0),
  };
};

/** Runs the chosen arms on the chosen world and returns the report (also written to `out`). */
export const runCrewday = async (
  options: CrewdayOptions,
  deps: CrewdayDeps,
): Promise<CrewdayReport> => {
  const log = deps.log ?? console.log;
  const started = performance.now();
  const world = truncate(await loadCrewdayWorld(options.world), options.limitWeeks);
  const findable = keywordFindableShare(world);
  const arms: ArmName[] = options.arm === "both" ? ["signal", "board"] : [options.arm];
  const policy = resolvePolicy({ pPmOverride: options.pPmOverride, pmPolicy: options.pmPolicy });
  const prices = deps.prices ?? {};
  log(
    `[eval:crewday] world ${options.world}@${WORLD_VERSION}: ${world.backlog.length} backlog needs, ${world.signals.length} signals; arms ${arms.join(", ")}; PM ${policy.pmPolicy}; seed ${options.seed}${options.limitWeeks ? `; SMOKE ${options.limitWeeks} weeks` : ""}`,
  );
  if (options.world === "test")
    log("[eval:crewday] held-out test world: an acceptance run. Never tune on this result.");

  const scores: Partial<Record<ArmName, ArmScore>> = {};
  const runs: Partial<Record<ArmName, ArmRunInfo>> = {};
  for (const arm of arms) {
    const armRun = await runOneArm({ arm, deps, log, options, policy, prices, world });
    scores[arm] = armRun.score;
    runs[arm] = armRun.info;
  }

  const comparison =
    scores.signal && scores.board ? compareArms(scores.signal, scores.board) : null;
  const report: CrewdayReport = {
    arms,
    comparison: comparison
      ? {
          assumptions: comparison.assumptions,
          criteria: comparison.criteria,
          killSignal: comparison.killSignal,
          lift: comparison.lift,
        }
      : null,
    gitSha: gitSha(),
    limitWeeks: options.limitWeeks,
    mode: deps.mode,
    models: {
      embedding: signalEmbeddingModelId(),
      fast: signalFastModelId(),
      oracleEmbedding: deps.oracleEmbedder().model,
      reasoning: signalReasoningModelId(),
    },
    notMeasured: [...NOT_MEASURED],
    pii: piiResult(arms, scores),
    policy,
    ranAt: new Date().toISOString(),
    runs,
    schema: "crewday-report@1",
    scores,
    seed: options.seed,
    spend: spendResult(deps.usage, runs, prices),
    table: buildTable({ comparison, keywordFindableShare: findable.value, scores }),
    wallTimeMs: performance.now() - started,
    world: {
      keywordFindableShare: findable,
      name: options.world,
      signals: world.signals.length,
      version: WORLD_VERSION,
    },
  };

  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  log("");
  for (const line of renderReport(report)) log(line);
  log("");
  log(`Report: ${path.relative(process.cwd(), out)}`);
  return report;
};

const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${error.cause ? `: ${describeError(error.cause)}` : ""}`
    : String(error);

const main = async () => {
  const options = parseCrewdayArgs(process.argv.slice(2));
  if (!gatewayAvailable()) {
    console.log(
      "[eval:crewday] SKIPPED: no AI Gateway access (set AI_GATEWAY_API_KEY in .env.local, or run on Vercel). This eval calls live models; nothing was scored.",
    );
    return;
  }
  const usage = new BucketedUsage();
  registerTelemetry(usage.telemetry());
  // Preflight: one extraction, so an unreachable Gateway skips cleanly instead of failing mid-run.
  try {
    await createGatewayAi().extractor.extract({
      body: "Shift managers need to swap shifts from their phone.",
      title: "Shift swaps",
    });
  } catch (error) {
    console.log(
      `[eval:crewday] SKIPPED: the AI Gateway is unavailable (${describeError(error)}). Nothing was scored.`,
    );
    return;
  }
  usage.drain("runtime");
  await runCrewday(options, {
    mode: "live",
    oracleEmbedder: () => createOracleEmbedder({ live: true }),
    prices: await loadGatewayPrices(),
    signalAi: createGatewayAi,
    usage,
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();

/** Offline ports for the vitest smoke (fake AI; not a result). */
export const offlineDeps = (log?: (line: string) => void): CrewdayDeps => ({
  log: log ?? (() => null),
  mode: "offline",
  oracleEmbedder: () => createOfflineSignalAi().embedder,
  signalAi: createOfflineSignalAi,
});
