import { describe, expect, test } from "vitest";

import { fakeEmbedder, fakeExtractor, fakeJudge } from "@/lib/signal/ai/fakes";
import { callCostUsd, pricesFromModelList, summarizeCost, UsageMeter } from "@/evals/matching/cost";
import { catalog, submissions } from "@/evals/matching/dataset";
import type { CaseKind, LabeledSubmission } from "@/evals/matching/dataset";
import {
  meetsTargets,
  multiAskDetection,
  multiAskScores,
  percentile,
  pickBestThreshold,
  scoreAt,
  shownMatches,
  stepPercentile,
  sweep,
  thresholdRange,
} from "@/evals/matching/metrics";
import type { CaseRun, ThresholdScore } from "@/evals/matching/metrics";
import { runPipeline } from "@/evals/matching/pipeline";

// Offline: metric calculations, sweep logic, dataset integrity, and the runner wiring with fake
// ports. The live run is `pnpm eval:matching`.

const run = (
  caseId: string,
  expected: string[],
  judgements: [needId: string, probability: number][],
  extra: Partial<CaseRun> = {},
): CaseRun => ({
  additionalAsks: [],
  candidates: judgements.map(([needId], index) => ({ needId, similarity: 1 - index / 10 })),
  caseId,
  expected,
  judgements: judgements.map(([needId, probability]) => ({ needId, probability, reason: "r" })),
  kind: expected.length ? "paraphrase" : "new",
  latencyMs: 100,
  ...extra,
});

describe("matching eval metrics", () => {
  test("shows matches at or above the threshold, highest first, at most 3, one per need", () => {
    const sample = run(
      "a",
      ["x"],
      [
        ["x", 0.6],
        ["y", 0.9],
        ["z", 0.59],
        ["w", 0.7],
        ["v", 0.65],
        ["y", 0.95],
      ],
    );
    expect(shownMatches(sample, 0.6).map((match) => match.needId)).toEqual(["y", "w", "v"]);
    expect(shownMatches(sample, 0.96)).toEqual([]);
  });

  test("only candidates retrieved can be shown, and a failed case shows nothing", () => {
    const stray = run("a", ["x"], [["x", 0.9]], {
      judgements: [
        { needId: "x", probability: 0.9, reason: "r" },
        { needId: "not-retrieved", probability: 0.99, reason: "r" },
      ],
    });
    expect(shownMatches(stray, 0.5).map((match) => match.needId)).toEqual(["x"]);
    expect(shownMatches({ ...stray, error: "ai_unavailable" }, 0.5)).toEqual([]);
  });

  test("precision@3, false-match rate, new-need recall, and match recall", () => {
    const runs = [
      run(
        "hit",
        ["a"],
        [
          ["a", 0.9],
          ["b", 0.2],
        ],
      ),
      run(
        "hit-and-wrong",
        ["a"],
        [
          ["a", 0.8],
          ["b", 0.7],
        ],
      ),
      run("miss", ["a"], [["b", 0.3]]),
      run("new-clean", [], [["a", 0.4]]),
      run("new-false", [], [["a", 0.75]]),
    ];
    const score = scoreAt(runs, 0.6);
    // Shown: hit [a], hit-and-wrong [a, b], new-false [a] → 4 shown, 2 correct.
    expect(score.shown).toBe(4);
    expect(score.correctShown).toBe(2);
    expect(score.precisionAt3).toBe(0.5);
    // Wrong match shown in hit-and-wrong and new-false: 2 of 5.
    expect(score.falseMatchRate).toBe(0.4);
    expect(score.newNeedRecall).toBe(0.5);
    expect(score.matchRecallAt3).toBe(2 / 3);
  });

  test("any listed need counts as a correct match (multi-ask)", () => {
    const score = scoreAt(
      [
        run(
          "m",
          ["a", "b"],
          [
            ["b", 0.9],
            ["a", 0.8],
          ],
        ),
      ],
      0.5,
    );
    expect(score.precisionAt3).toBe(1);
    expect(score.falseMatchRate).toBe(0);
  });

  test("undefined ratios are null and fail the targets", () => {
    const score = scoreAt([run("new", [], [["a", 0.2]])], 0.6);
    expect(score.precisionAt3).toBeNull();
    expect(score.matchRecallAt3).toBeNull();
    expect(score.newNeedRecall).toBe(1);
    expect(meetsTargets(score)).toBe(false);
  });

  test("multi-ask detection counts drafts with an additional ask", () => {
    const runs = [
      run("m1", ["a"], [], { additionalAsks: ["second"], kind: "multi_ask" }),
      run("m2", ["a"], [], { kind: "multi_ask" }),
      run("p", ["a"], [], { additionalAsks: ["ignored"] }),
    ];
    expect(multiAskDetection(runs)).toBe(0.5);
  });

  test("p95 uses the nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile([5, 1, 3], 95)).toBe(5);
    expect(percentile([], 95)).toBeUndefined();
  });
});

const thresholdScore = (threshold: number, fields: Partial<ThresholdScore>): ThresholdScore => ({
  correctShown: 0,
  falseMatchRate: 0,
  matchRecallAt3: 0.8,
  newNeedRecall: 1,
  precisionAt3: 1,
  shown: 1,
  threshold,
  ...fields,
});

describe("threshold sweep", () => {
  test("ranges are inclusive and free of float drift", () => {
    expect(thresholdRange(0.3, 0.5, 0.05)).toEqual([0.3, 0.35, 0.4, 0.45, 0.5]);
    expect(() => thresholdRange(0.5, 0.3, 0.05)).toThrow();
  });

  test("picks the passing threshold with the best match recall", () => {
    const best = pickBestThreshold([
      thresholdScore(0.4, { falseMatchRate: 0.2, matchRecallAt3: 0.99, precisionAt3: 0.7 }),
      thresholdScore(0.5, { matchRecallAt3: 0.9 }),
      thresholdScore(0.6, { matchRecallAt3: 0.85 }),
      thresholdScore(0.7, { falseMatchRate: 0.01, matchRecallAt3: 0.9 }),
    ]);
    expect(best?.meetsTargets).toBe(true);
    // 0.5 and 0.7 tie on recall; 0.5 has the lower false-match rate.
    expect(best?.score.threshold).toBe(0.5);
  });

  test("breaks a full tie toward the higher threshold", () => {
    expect(
      pickBestThreshold([thresholdScore(0.5, {}), thresholdScore(0.6, {})])?.score.threshold,
    ).toBe(0.6);
  });

  test("with no passing threshold, reports the closest one as not meeting targets", () => {
    const best = pickBestThreshold([
      thresholdScore(0.5, { falseMatchRate: 0.3, precisionAt3: 0.6 }),
      thresholdScore(0.6, { falseMatchRate: 0.08, precisionAt3: 0.86 }),
      thresholdScore(0.7, { newNeedRecall: 0.5, precisionAt3: 0.95 }),
    ]);
    expect(best?.meetsTargets).toBe(false);
    expect(best?.score.threshold).toBe(0.6);
  });

  test("sweeps recorded runs at every threshold", () => {
    const runs = [
      run(
        "a",
        ["a"],
        [
          ["a", 0.7],
          ["b", 0.5],
        ],
      ),
      run("n", [], [["a", 0.55]]),
    ];
    const scores = sweep(runs, [0.5, 0.6, 0.8]);
    expect(scores.map((s) => [s.threshold, s.precisionAt3, s.falseMatchRate])).toEqual([
      [0.5, 1 / 3, 1],
      [0.6, 1, 0],
      [0.8, null, 0],
    ]);
    expect(pickBestThreshold(scores)?.score.threshold).toBe(0.6);
  });
});

describe("cost per signal", () => {
  const prices = pricesFromModelList({
    models: [
      { id: "anthropic/fast", pricing: { input: "0.000001", output: "0.000005" } },
      { id: "no-price", pricing: null },
    ],
  });

  test("prefers the Gateway's reported cost, else prices tokens, else counts the call unpriced", () => {
    expect(prices).toEqual({ "anthropic/fast": { input: 0.000001, output: 0.000005 } });
    expect(
      callCostUsd(
        { inputTokens: 1000, modelId: "anthropic/fast", outputTokens: 100, reportedCostUsd: 0.5 },
        prices,
      ),
    ).toBe(0.5);
    expect(
      callCostUsd({ inputTokens: 1000, modelId: "anthropic/fast", outputTokens: 100 }, prices),
    ).toBeCloseTo(0.0015);
    const summary = summarizeCost(
      [
        { inputTokens: 1000, modelId: "anthropic/fast", outputTokens: 100 },
        { inputTokens: 10, modelId: "unknown", outputTokens: 0 },
      ],
      prices,
    );
    expect(summary.calls).toBe(2);
    expect(summary.unpricedCalls).toBe(1);
    expect(summary.totalUsd).toBeCloseTo(0.0015);
  });

  test("the meter records language and embedding calls per phase", () => {
    const meter = new UsageMeter();
    const telemetry = meter.telemetry() as unknown as {
      onEmbedEnd: (event: unknown) => void;
      onLanguageModelCallEnd: (event: unknown) => void;
    };
    telemetry.onLanguageModelCallEnd({
      modelId: "anthropic/fast",
      providerMetadata: { gateway: { cost: "0.0002" } },
      usage: { inputTokens: 300, outputTokens: 40 },
    });
    telemetry.onEmbedEnd({ modelId: "openai/embed", usage: { tokens: 12 } });
    expect(meter.take()).toEqual([
      { inputTokens: 300, modelId: "anthropic/fast", outputTokens: 40, reportedCostUsd: 0.0002 },
      { inputTokens: 12, modelId: "openai/embed", outputTokens: 0 },
    ]);
    expect(meter.take()).toEqual([]);
  });

  test("the meter records decision-model calls with the Gateway's cost (spec 008)", () => {
    const meter = new UsageMeter();
    const telemetry = meter.telemetry() as unknown as {
      experimental_onDecisionModelCallEnd: (event: unknown) => void;
    };
    telemetry.experimental_onDecisionModelCallEnd({
      modelId: "typesafe-ai/jev",
      providerMetadata: { gateway: { cost: "0.000017" } },
      usage: { inputTokens: 407, outputTokens: 46 },
    });
    expect(meter.take()).toEqual([
      { inputTokens: 407, modelId: "typesafe-ai/jev", outputTokens: 46, reportedCostUsd: 0.000017 },
    ]);
  });
});

describe("spec 008 diagnostics", () => {
  test("multi-ask scores give recall on multi-ask cases and false positives on the rest", () => {
    const runs = [
      run("m1", ["n1"], [], { kind: "multi_ask", multiAskProbability: 0.9 }),
      run("m2", ["n1"], [], { kind: "multi_ask", multiAskProbability: 0.2 }),
      run("s1", [], [], { multiAskProbability: 0.7 }),
      run("s2", [], [], { multiAskProbability: 0.1 }),
      run("s3", [], []),
    ];
    expect(
      multiAskScores(runs, (r) =>
        r.multiAskProbability === undefined ? undefined : r.multiAskProbability >= 0.5,
      ),
    ).toEqual({ falsePositiveRate: 0.5, recall: 0.5 });
    expect(multiAskScores(runs, (r) => r.additionalAsks.length > 0)).toEqual({
      falsePositiveRate: 0,
      recall: 0,
    });
  });

  test("step percentiles read only runs that recorded the step", () => {
    const runs = [
      run("a", [], [], { steps: { judgeMs: 100 } }),
      run("b", [], [], { steps: { judgeMs: 300 } }),
      run("c", [], [], { steps: {} }),
    ];
    expect(stepPercentile(runs, "judgeMs", 50)).toBe(percentile([100, 300], 50));
    expect(stepPercentile(runs, "embedMs", 95)).toBeUndefined();
  });
});

describe("matching eval set", () => {
  test("has at least 120 labeled submissions covering every kind", () => {
    expect(submissions.length).toBeGreaterThanOrEqual(120);
    for (const kind of ["paraphrase", "same_solution", "multi_ask", "new"] satisfies CaseKind[])
      expect(
        submissions.filter((submission) => submission.kind === kind).length,
      ).toBeGreaterThanOrEqual(15);
  });

  test("ids are unique and labels point at catalog needs", () => {
    const keys = new Set(catalog.map((need) => need.key));
    expect(keys.size).toBe(catalog.length);
    expect(new Set(submissions.map((submission) => submission.id)).size).toBe(submissions.length);
    for (const submission of submissions) {
      for (const key of submission.expected) expect(keys, submission.id).toContain(key);
      if (submission.kind === "new") expect(submission.expected, submission.id).toEqual([]);
      if (submission.kind === "paraphrase")
        expect(submission.expected.length, submission.id).toBe(1);
    }
  });

  test("every catalog need is the answer to at least one submission", () => {
    const answered = new Set(submissions.flatMap((submission) => submission.expected));
    expect(catalog.filter((need) => !answered.has(need.key)).map((need) => need.key)).toEqual([]);
  });
});

describe("matching eval runner (fake ports)", () => {
  const sample: LabeledSubmission[] = [
    {
      body: "Executives need to share dashboard snapshots outside the product for board meetings.",
      expected: ["n1"],
      id: "x1",
      kind: "paraphrase",
      title: "Board",
    },
    { body: "The coffee machine is broken.", expected: [], id: "x2", kind: "new", title: "Coffee" },
  ];

  test("records retrieval, every judgement, the draft, and latency per submission", async () => {
    const runs = await runPipeline({
      catalog,
      ports: { embedder: fakeEmbedder(), extractor: fakeExtractor(), judge: fakeJudge() },
      submissions: sample,
    });
    expect(runs.map((r) => r.caseId)).toEqual(["x1", "x2"]);
    const [board] = runs;
    expect(board?.error).toBeUndefined();
    expect(board?.candidates).toHaveLength(8);
    expect(board?.judgements).toHaveLength(8);
    expect(board?.candidates[0]?.needId).toBe("n1");
    expect(board?.draftStatement).toContain("Board");
    expect(board?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(board?.steps?.judgeMs).toBeGreaterThanOrEqual(0);
    expect(board?.steps?.embedMs).toBeGreaterThanOrEqual(0);
    expect(shownMatches(board as CaseRun, 0.6)[0]?.needId).toBe("n1");
  });

  test("judgeWithDraft passes the drafted need to the judge; a multi-ask probe is recorded", async () => {
    const drafts: (string | undefined)[] = [];
    const judge = fakeJudge();
    const runs = await runPipeline({
      catalog,
      options: { judgeWithDraft: true },
      ports: {
        embedder: fakeEmbedder(),
        extractor: fakeExtractor(),
        judge: {
          judge: (input) => {
            drafts.push(input.draft?.statement);
            return judge.judge(input);
          },
          model: "spy",
        },
        multiAsk: { detect: () => Promise.resolve(0.25) },
      },
      submissions: sample.slice(0, 1),
    });
    expect(drafts[0]).toContain("Board");
    expect(runs[0]?.multiAskProbability).toBe(0.25);
  });

  test("a failing port marks the submission as errored instead of aborting the run", async () => {
    const runs = await runPipeline({
      catalog,
      ports: {
        embedder: fakeEmbedder(),
        extractor: { extract: () => Promise.reject(new Error("ai_unavailable")) },
        judge: fakeJudge(),
      },
      submissions: sample,
    });
    expect(runs.map((r) => r.error)).toEqual(["ai_unavailable", "ai_unavailable"]);
    expect(scoreAt(runs, 0.6).newNeedRecall).toBe(1);
  });
});
