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
//   --cached                  replay AI responses from evals/crewday/.cache (keyed by model, prompt
//                             hash, and input); misses call the Gateway and fill the cache. Dev
//                             iterations only: the spend guardrail is not judged (task 05)
//   --sweep                   rerun both arms over the behaviour grid (sweep.ts) and report each
//                             criterion per cell and how robust it is (task 05)
//   --tag <name>              test world only, always live: 3 repeats (seeds n, n+1, n+2), one entry
//                             appended to evals/crewday/history/tagged-runs.jsonl, and the
//                             comparison with the previous tagged run (task 06)
//   --component matching      the harder matching set: Signal's matching pipeline over the world's
//                             signals (default world test; task 07). --limit <n>: first n signals
//                             (smoke), --no-grade: skip the need-statement grader
// oxlint-disable eslint/no-await-in-loop -- runtime overrides are process-wide, so arms run one at a time
import { refuseInCi } from "@/evals/ci-guard";
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
import { gatewayGrader } from "../matching/grader";

import { isCounted } from "./checks";
import type { World, WorldName } from "./format";
import { HELD_OUT } from "./held-out";
import type { HeldOut } from "./held-out";
import { AiResponseCache, cacheEmbedder, cacheSignalAi } from "./cache";
import {
  appendHistory,
  compareEntries,
  HISTORY_FILE,
  historyEntry,
  previousEntry,
  readHistory,
  renderComparison,
  TAGGED_REPEATS,
} from "./history";
import type { HistoryComparison, HistoryEntry } from "./history";
import { renderMatching, runMatchingComponent } from "./matching";
import type { MatchingComponentReport } from "./matching";
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
import { cellResult, renderSweep, summarizeSweep, SWEEP_GRID } from "./sweep";
import type { SweepCell, SweepReport } from "./sweep";
import { loadWorld } from "./world";

export const WORLD_VERSION = "v1";
const worldNames = ["dev", "test", "fixture"] as const;
const armChoices = ["signal", "board", "both"] as const;

const components = ["outcome", "matching"] as const;

export interface CrewdayOptions {
  arm: (typeof armChoices)[number];
  /** Replay AI responses from the local cache (dev iterations; never tagged). */
  cached: boolean;
  component: (typeof components)[number];
  db: SimDatabaseTarget;
  /** `--component matching`: run the need-statement grader. */
  grade: boolean;
  /** `--component matching` smoke: first n signals only. */
  limit: number | null;
  limitWeeks: number | null;
  out: string;
  /** Behaviour overrides on top of the defaults (a sweep cell). */
  policy?: Partial<PolicyParams>;
  pPmOverride: number;
  pmPolicy: PmPolicy;
  seed: number;
  sweep: boolean;
  /** A tagged run's name (test world, live, 3 repeats, appended to history). */
  tag: string | null;
  world: WorldName;
}

const positiveInt = (value: string | undefined, flag: string) => {
  if (value === undefined) return null;
  const n = Number(value);
  if (!(Number.isInteger(n) && n > 0)) throw new Error(`${flag} must be a positive integer`);
  return n;
};

/** Combinations the spec rules out (tagged runs are live, complete, both arms, test world). */
const checkCombinations = (o: CrewdayOptions) => {
  if (o.tag !== null) {
    if (o.world !== "test")
      throw new Error("--tag runs on the held-out test world only (--world test)");
    if (o.cached) throw new Error("--tag runs are always live: drop --cached");
    if (o.sweep) throw new Error("--tag and --sweep do not combine");
    if (o.limitWeeks !== null)
      throw new Error("--tag runs replay the whole year: drop --limit-weeks");
    if (o.arm !== "both") throw new Error("--tag runs both arms");
    if (o.component !== "outcome") throw new Error("--tag applies to the outcome eval only");
    if (!/^[\w.-]+$/u.test(o.tag))
      throw new Error("--tag must be letters, digits, '.', '_' or '-'");
  }
  if (o.sweep && o.component !== "outcome")
    throw new Error("--sweep applies to the outcome eval only");
  if (o.limit !== null && o.component !== "matching")
    throw new Error("--limit applies to --component matching (use --limit-weeks for a smoke run)");
};

const defaultOut = (o: Pick<CrewdayOptions, "component" | "sweep" | "world">) => {
  if (o.component === "matching") return `evals/crewday/results/matching-${o.world}.json`;
  return o.sweep ? "evals/crewday/results/sweep.json" : "evals/crewday/results/latest.json";
};

export const parseCrewdayArgs = (argv: string[]): CrewdayOptions => {
  const { values } = parseArgs({
    allowNegative: true,
    args: argv,
    options: {
      arm: { default: "both", type: "string" },
      cached: { default: false, type: "boolean" },
      component: { default: "outcome", type: "string" },
      "database-url": { type: "string" },
      grade: { default: true, type: "boolean" },
      limit: { type: "string" },
      "limit-weeks": { type: "string" },
      out: { type: "string" },
      "pm-override": { default: String(defaultPolicy.pPmOverride), type: "string" },
      "pm-policy": { default: defaultPolicy.pmPolicy, type: "string" },
      seed: { default: "1", type: "string" },
      sweep: { default: false, type: "boolean" },
      tag: { type: "string" },
      world: { type: "string" },
    },
  });
  const component = values.component as CrewdayOptions["component"];
  if (!components.includes(component))
    throw new Error(`--component must be one of ${components.join("|")}`);
  // The harder matching set is built from the held-out test world (task 07).
  const world = (values.world ?? (component === "matching" ? "test" : "dev")) as WorldName;
  if (!worldNames.includes(world))
    throw new Error(`--world must be one of ${worldNames.join("|")}`);
  const arm = values.arm as CrewdayOptions["arm"];
  if (!armChoices.includes(arm)) throw new Error(`--arm must be one of ${armChoices.join("|")}`);
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  const limitWeeks = positiveInt(values["limit-weeks"], "--limit-weeks");
  const pmPolicy = values["pm-policy"] as PmPolicy;
  if (!pmPolicies.includes(pmPolicy))
    throw new Error(`--pm-policy must be one of ${pmPolicies.join("|")}`);
  const pPmOverride = Number(values["pm-override"]);
  if (!(Number.isFinite(pPmOverride) && pPmOverride >= 0 && pPmOverride <= 1))
    throw new Error("--pm-override must be a probability between 0 and 1");
  const url = values["database-url"];
  const sweep = values.sweep ?? false;
  const options: CrewdayOptions = {
    arm,
    cached: values.cached ?? false,
    component,
    db: url ? { kind: "url", url } : { kind: "pglite" },
    grade: values.grade ?? true,
    limit: positiveInt(values.limit, "--limit"),
    limitWeeks,
    out: values.out ?? defaultOut({ component, sweep, world }),
    pPmOverride,
    pmPolicy,
    seed,
    sweep,
    tag: values.tag ?? null,
    world,
  };
  checkCombinations(options);
  return options;
};

/**
 * Loads a world. The test world needs the held-out capability, passed through from the caller:
 * only this file's `main` has it, so importing `runCrewday` or this function from elsewhere
 * cannot open the test world without naming the token (which the guard test catches).
 */
export const loadCrewdayWorld = (name: WorldName, heldOut?: HeldOut) =>
  name === "test"
    ? loadWorld("test", WORLD_VERSION, heldOut ? { heldOut } : {})
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
  /** The held-out capability; required for `--world test` (acceptance runs from `main` only). */
  heldOut?: HeldOut;
  /** Live spend meter (registered as AI SDK telemetry) and price table; omitted offline. */
  usage?: BucketedUsage;
  prices?: PriceTable;
  /** `--cached`: the response cache the ports were wrapped with (`withCache`), for its stats. */
  cache?: AiResponseCache;
}

/**
 * `--cached`: Signal's ports and the oracle's embedder answered from `cache` when they can be
 * (`./cache`). A cached run does not judge the spend guardrail (it reports new calls only).
 */
export const withCache = (deps: CrewdayDeps, cache: AiResponseCache): CrewdayDeps => ({
  ...deps,
  cache,
  oracleEmbedder: () => cacheEmbedder(deps.oracleEmbedder(), cache),
  signalAi: () => cacheSignalAi(deps.signalAi(), cache),
});

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
    // Under --cached most answers cost nothing now, so the guardrail is not judged (n.a.).
    ...(usage && !input.deps.cache
      ? { spendUsd: () => summarizeCost(usage.calls("runtime"), prices).totalUsd }
      : {}),
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
  const world = truncate(await loadCrewdayWorld(options.world, deps.heldOut), options.limitWeeks);
  const findable = keywordFindableShare(world);
  const arms: ArmName[] = options.arm === "both" ? ["signal", "board"] : [options.arm];
  const policy = resolvePolicy({
    pPmOverride: options.pPmOverride,
    pmPolicy: options.pmPolicy,
    ...options.policy,
  });
  const cacheBefore = deps.cache ? { ...deps.cache.stats } : null;
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
    cache:
      deps.cache && cacheBefore
        ? {
            hits: deps.cache.stats.hits - cacheBefore.hits,
            misses: deps.cache.stats.misses - cacheBefore.misses,
          }
        : null,
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

/**
 * `--sweep` (task 05): reruns the chosen arms once per behaviour cell (`SWEEP_GRID`), each cell's
 * report in `results/sweep/<cell>.json`, and writes the sweep summary to `options.out`.
 */
export const runSweep = async (
  options: CrewdayOptions,
  deps: CrewdayDeps,
  grid: SweepCell[] = SWEEP_GRID,
): Promise<SweepReport> => {
  const log = deps.log ?? console.log;
  const out = path.resolve(options.out);
  const cells: SweepReport["cells"] = [];
  let world: CrewdayReport["world"] | undefined;
  for (const [i, cell] of grid.entries()) {
    log(`[eval:crewday] sweep cell ${i + 1}/${grid.length}: ${cell.id}`);
    const cellOut = path.join(
      path.dirname(out),
      "sweep",
      `${cell.id.replaceAll(/[^\w.=-]/gu, "_")}.json`,
    );
    const report = await runCrewday(
      { ...options, out: cellOut, policy: { ...options.policy, ...cell.overrides } },
      deps,
    );
    ({ world } = report);
    cells.push({ ...cellResult(cell, report), report: path.relative(process.cwd(), cellOut) });
  }
  const sweep: SweepReport = {
    cells,
    defaults: resolvePolicy({
      pPmOverride: options.pPmOverride,
      pmPolicy: options.pmPolicy,
      ...options.policy,
    }),
    ranAt: new Date().toISOString(),
    robustness: summarizeSweep(cells),
    schema: "crewday-sweep@1",
    world: world ?? {
      keywordFindableShare: { source: null, value: null },
      name: options.world,
      signals: 0,
      version: WORLD_VERSION,
    },
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(sweep, null, 2)}\n`);
  log("");
  for (const line of renderSweep(sweep)) log(line);
  log("");
  log(`Sweep report: ${path.relative(process.cwd(), out)}`);
  return sweep;
};

/**
 * `--tag <name>` (task 06): `TAGGED_REPEATS` (3) repeats with seeds n, n+1, n+2 (each report in
 * `results/tag-<name>-seed<n>.json`), one history entry appended, and the comparison with the
 * previous tagged run on the same world version.
 */
export const runTagged = async (
  options: CrewdayOptions & { tag: string },
  deps: CrewdayDeps,
  historyFile = HISTORY_FILE,
): Promise<{ comparison: HistoryComparison | null; entry: HistoryEntry }> => {
  const log = deps.log ?? console.log;
  const reports: CrewdayReport[] = [];
  const dir = path.dirname(path.resolve(options.out));
  for (let i = 0; i < TAGGED_REPEATS; i += 1) {
    const seed = options.seed + i;
    log(
      `[eval:crewday] tagged run ${options.tag}: repeat ${i + 1}/${TAGGED_REPEATS}, seed ${seed}`,
    );
    reports.push(
      await runCrewday(
        { ...options, out: path.join(dir, `tag-${options.tag}-seed${seed}.json`), seed },
        deps,
      ),
    );
  }
  const entry = historyEntry(options.tag, reports);
  const previous = previousEntry(await readHistory(historyFile), entry.world);
  const comparison = previous ? compareEntries(previous, entry) : null;
  await appendHistory(entry, historyFile);
  log("");
  for (const line of renderComparison(comparison, options.tag)) log(line);
  log(`History: ${path.relative(process.cwd(), historyFile)} (+1 entry)`);
  return { comparison, entry };
};

/** `--component matching` (task 07): the harder matching set on the chosen world. */
export const runMatching = async (
  options: CrewdayOptions,
  deps: Omit<Parameters<typeof runMatchingComponent>[1], "limit"> & { heldOut?: HeldOut },
): Promise<MatchingComponentReport> => {
  const log = deps.log ?? console.log;
  const world = await loadCrewdayWorld(options.world, deps.heldOut);
  const report = await runMatchingComponent(world, { ...deps, limit: options.limit });
  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ ...report, ranAt: new Date().toISOString(), world: { name: options.world, version: WORLD_VERSION } }, null, 2)}\n`,
  );
  log("");
  for (const line of renderMatching(report, `${options.world}@${WORLD_VERSION}`)) log(line);
  log(`Report: ${path.relative(process.cwd(), out)}`);
  return report;
};

const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${error.cause ? `: ${describeError(error.cause)}` : ""}`
    : String(error);

const main = async () => {
  refuseInCi("eval:crewday");
  const options = parseCrewdayArgs(process.argv.slice(2));
  if (!gatewayAvailable()) {
    console.log(
      "[eval:crewday] SKIPPED: no AI Gateway access (set AI_GATEWAY_API_KEY in .env.local, or run `vercel env pull .env.local` for a VERCEL_OIDC_TOKEN, which expires after about 12 hours). This eval calls live models; nothing was scored.",
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
  const prices = await loadGatewayPrices();
  const cache = options.cached ? new AiResponseCache() : null;
  if (cache) console.log(`[eval:crewday] --cached: ${cache.size} cached AI responses loaded`);

  if (options.component === "matching") {
    const ai = cache ? cacheSignalAi(createGatewayAi(), cache) : createGatewayAi();
    usage.drain("runtime");
    await runMatching(options, {
      ...(options.grade ? { grader: gatewayGrader() } : {}),
      heldOut: HELD_OUT,
      ports: { embedder: ai.embedder, extractor: ai.extractor, judge: ai.judge },
      prices,
      usage: { take: () => usage.drain("runtime") },
    });
    return;
  }

  const live: CrewdayDeps = {
    heldOut: HELD_OUT,
    mode: "live",
    oracleEmbedder: () => createOracleEmbedder({ live: true }),
    prices,
    signalAi: createGatewayAi,
    usage,
  };
  const deps = cache ? withCache(live, cache) : live;
  if (options.tag !== null) await runTagged({ ...options, tag: options.tag }, deps);
  else if (options.sweep) await runSweep(options, deps);
  else await runCrewday(options, deps);
  if (cache)
    console.log(
      `[eval:crewday] --cached: ${cache.stats.hits} replayed, ${cache.stats.misses} new calls; ${cache.size} entries cached`,
    );
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
