// `pnpm eval:matching`: the matching eval with live models (on demand; part of `pnpm eval`, never
// `pnpm test` or CI). Runs extract → embed → retrieve → judge over the labeled set with the
// production AI ports, grades each drafted need statement, sweeps the judge threshold, and prints
// the metrics against PRODUCT.md's targets. Skips (exit 0) without AI Gateway access.
//
// Options:
//   --threshold <t>        threshold to gate on (default: MATCH_THRESHOLD in lib/signal/domain/matching.ts)
//   --sweep <from:to:step> thresholds to sweep (default 0.3:0.95:0.05)
//   --limit <n>            first n submissions only (a quick smoke run; never tune on it)
//   --concurrency <n>      submissions in flight (default 4)
//   --no-grade             skip the need-statement grader
//   --no-gate              exit 0 even when the gated threshold misses the targets
//   --out <path>           JSON report (default evals/matching/results/latest.json, gitignored)
//   --fake                 offline smoke of the runner with the test fakes (not a result; no grading)
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { createGateway, gateway, registerTelemetry } from "ai";

import { gatewayAvailable, signalEmbeddingModelId, signalFastModelId } from "@/lib/ai/models";
import { fakeEmbedder, fakeExtractor, fakeJudge } from "@/lib/signal/ai/fakes";
import { gatewayEmbedder, gatewayExtractor, gatewayJudge } from "@/lib/signal/ai/gateway";
import { MATCH_THRESHOLD } from "@/lib/signal/domain/matching";

import { summarizeCost, pricesFromModelList, UsageMeter } from "./cost";
import type { PriceTable } from "./cost";
import { catalog, submissions } from "./dataset";
import { gatewayGrader, meanScore } from "./grader";
import type { Grade } from "./grader";
import {
  MAX_COST_PER_SIGNAL_USD,
  MAX_P95_LATENCY_MS,
  meetsTargets,
  MIN_RUBRIC_SCORE,
  multiAskDetection,
  percentile,
  pickBestThreshold,
  PRODUCT_TARGETS,
  scoreAt,
  scoreByKind,
  sweep,
  thresholdRange,
} from "./metrics";
import type { ThresholdScore } from "./metrics";
import { indexCatalog, mapLimit, runPipeline } from "./pipeline";

const log = (line = "") => console.log(line);
const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${error.cause ? `: ${describeError(error.cause)}` : ""}`
    : String(error);

const { values: args } = parseArgs({
  allowNegative: true,
  options: {
    concurrency: { default: "4", type: "string" },
    fake: { default: false, type: "boolean" },
    gate: { default: true, type: "boolean" },
    grade: { default: true, type: "boolean" },
    limit: { type: "string" },
    out: { default: "evals/matching/results/latest.json", type: "string" },
    sweep: { default: "0.3:0.95:0.05", type: "string" },
    threshold: { type: "string" },
  },
});

if (!args.fake && !gatewayAvailable()) {
  log(
    "[eval:matching] SKIPPED: no AI Gateway access (set AI_GATEWAY_API_KEY in .env.local, or run on Vercel). This eval calls live models; nothing was scored.",
  );
  process.exit(0);
}

const gateThreshold = args.threshold === undefined ? MATCH_THRESHOLD : Number(args.threshold);
const [from, to, step] = (args.sweep ?? "").split(":").map(Number);
const thresholds = thresholdRange(from ?? 0.3, to ?? 0.95, step ?? 0.05);
const concurrency = Math.max(1, Number(args.concurrency) || 4);
const cases = args.limit ? submissions.slice(0, Number(args.limit)) : submissions;

const meter = new UsageMeter();
registerTelemetry(meter.telemetry());

const ports = args.fake
  ? { embedder: fakeEmbedder(), extractor: fakeExtractor(), judge: fakeJudge() }
  : { embedder: gatewayEmbedder(), extractor: gatewayExtractor(), judge: gatewayJudge() };
if (args.fake)
  log(
    "[eval:matching] FAKE PORTS: offline smoke of the runner. These numbers are not a matching result.",
  );

// Preflight: one extraction, so a missing implementation or an unreachable Gateway skips cleanly.
try {
  const [first] = cases;
  if (first) await ports.extractor.extract({ body: first.body, title: first.title });
} catch (error) {
  log(
    `[eval:matching] SKIPPED: the extractor is unavailable (${describeError(error)}). Nothing was scored.`,
  );
  process.exit(0);
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

log(
  `[eval:matching] ${cases.length} submissions, ${catalog.length} catalog needs; extract/judge ${signalFastModelId()}, embeddings ${signalEmbeddingModelId()}`,
);
const index = await indexCatalog(catalog, ports.embedder);
meter.take();
const started = performance.now();
let done = 0;
const runs = await runPipeline({
  catalog,
  concurrency,
  index,
  onCase: () => {
    done += 1;
    if (done % 20 === 0 || done === cases.length) log(`  ${done}/${cases.length}`);
  },
  ports,
  submissions: cases,
});
const pipelineCost = summarizeCost(meter.take(), prices);

let grades: (Grade | undefined)[] = [];
let grader: string | undefined;
if (args.grade && !args.fake) {
  const statementGrader = gatewayGrader();
  grader = statementGrader.model;
  log(`[eval:matching] grading drafted need statements with ${grader}`);
  grades = await mapLimit(runs, concurrency, async (run) => {
    const submission = cases.find((item) => item.id === run.caseId);
    if (!submission || run.draftStatement === undefined) return;
    try {
      return await statementGrader.grade({ ...submission, statement: run.draftStatement });
    } catch {
      // An ungraded draft is left out of the rubric mean.
    }
  });
}
const graderCost = summarizeCost(meter.take(), prices);

// ---- Report ----
const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "  n/a" : `${(value * 100).toFixed(1).padStart(5)}%`;
const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
const row = (score: ThresholdScore) =>
  `  ${score.threshold.toFixed(2)}  ${pct(score.precisionAt3)}  ${pct(score.falseMatchRate)}  ${pct(score.newNeedRecall)}  ${pct(score.matchRecallAt3)}  ${String(score.shown).padStart(5)}  ${meetsTargets(score) ? "meets" : ""}`;

const errors = runs.filter((run) => run.error);
const latencies = runs.filter((run) => !run.error).map((run) => run.latencyMs);
const p95 = percentile(latencies, 95);
const costPerSignal = cases.length === 0 ? 0 : pipelineCost.totalUsd / cases.length;
const rubric = meanScore(grades);
const gated = scoreAt(runs, gateThreshold);
const scores = sweep(runs, thresholds);
const best = pickBestThreshold(scores);

log();
log(
  `Elapsed ${((performance.now() - started) / 1000).toFixed(1)} s; ${errors.length} submissions failed (counted as no match shown).`,
);
for (const run of errors.slice(0, 5)) log(`  ${run.caseId}: ${run.error}`);
log();
log("Threshold sweep (matches shown = probability ≥ t, top 3):");
log("  t     prec@3  false   new-rec match-rec  shown");
for (const score of scores) log(row(score));
log();
log(
  `At the gated threshold ${gateThreshold} (${args.threshold === undefined ? "MATCH_THRESHOLD" : "--threshold"}):`,
);
log(
  `  precision@3        ${pct(gated.precisionAt3)}  target ≥ ${pct(PRODUCT_TARGETS.minPrecisionAt3)}  ${mark((gated.precisionAt3 ?? 0) >= PRODUCT_TARGETS.minPrecisionAt3)}`,
);
log(
  `  false-match rate   ${pct(gated.falseMatchRate)}  target ≤ ${pct(PRODUCT_TARGETS.maxFalseMatchRate)}  ${mark(gated.falseMatchRate <= PRODUCT_TARGETS.maxFalseMatchRate)}`,
);
log(
  `  new-need recall    ${pct(gated.newNeedRecall)}  target ≥ ${pct(PRODUCT_TARGETS.minNewNeedRecall)}  ${mark((gated.newNeedRecall ?? 0) >= PRODUCT_TARGETS.minNewNeedRecall)}`,
);
log(`  match recall@3     ${pct(gated.matchRecallAt3)}  (diagnostic)`);
log(`  multi-ask detected ${pct(multiAskDetection(runs))}  (diagnostic)`);
log(
  `  need-statement rubric ${rubric === null ? "n/a (not graded)" : `${rubric.toFixed(2)}/5`}  target ≥ ${MIN_RUBRIC_SCORE}  ${rubric === null ? "" : mark(rubric >= MIN_RUBRIC_SCORE)}`,
);
log(
  `  p95 latency        ${p95 === undefined ? "n/a" : `${Math.round(p95)} ms`}  guardrail ≤ ${MAX_P95_LATENCY_MS} ms  ${p95 === undefined ? "" : mark(p95 <= MAX_P95_LATENCY_MS)}`,
);
log(
  `  cost per signal    $${costPerSignal.toFixed(5)}  guardrail ≤ $${MAX_COST_PER_SIGNAL_USD}  ${mark(costPerSignal <= MAX_COST_PER_SIGNAL_USD)}${pipelineCost.unpricedCalls ? `  (${pipelineCost.unpricedCalls} of ${pipelineCost.calls} calls unpriced, so this is a lower bound)` : ""}`,
);
if (grader)
  log(
    `  grader spend       $${graderCost.totalUsd.toFixed(4)} (${grader}, not part of cost per signal)`,
  );
log();
log("By kind at the gated threshold:");
for (const [kind, score] of Object.entries(scoreByKind(runs, gateThreshold)))
  log(
    `  ${kind.padEnd(14)} prec@3 ${pct(score.precisionAt3)}  false ${pct(score.falseMatchRate)}  new-rec ${pct(score.newNeedRecall)}  match-rec ${pct(score.matchRecallAt3)}`,
  );
log();
if (best)
  log(
    best.meetsTargets
      ? `Best threshold: ${best.score.threshold} meets PRODUCT.md targets (precision@3 ${pct(best.score.precisionAt3)}, false-match ${pct(best.score.falseMatchRate)}, new-need recall ${pct(best.score.newNeedRecall)}, match recall@3 ${pct(best.score.matchRecallAt3)}).`
      : `KILL-CRITERION RESULT: no threshold in the sweep meets PRODUCT.md targets. Closest: ${best.score.threshold} (precision@3 ${pct(best.score.precisionAt3)}, false-match ${pct(best.score.falseMatchRate)}, new-need recall ${pct(best.score.newNeedRecall)}).`,
  );
if (args.limit) log("Note: --limit run; do not tune the threshold on a subset.");

const out = path.resolve(args.out ?? "evals/matching/results/latest.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(
  out,
  `${JSON.stringify(
    {
      best,
      cost: { grader: graderCost, perSignalUsd: costPerSignal, pipeline: pipelineCost },
      gateThreshold,
      gated,
      latency: { p50: percentile(latencies, 50), p95 },
      models: { embedding: signalEmbeddingModelId(), fast: signalFastModelId(), grader },
      ranAt: new Date().toISOString(),
      rubric,
      runs: runs.map((run, position) => ({ ...run, grade: grades[position] })),
      sweep: scores,
    },
    null,
    2,
  )}\n`,
);
log(`Report: ${path.relative(process.cwd(), out)}`);

const gatePassed = meetsTargets(gated);
if (args.gate && !gatePassed) {
  log(`[eval:matching] FAILED: threshold ${gateThreshold} misses PRODUCT.md's matching targets.`);
  process.exit(1);
}
