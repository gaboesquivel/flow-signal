import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { AiResponseCache, cacheSignalAi } from "@/evals/crewday/cache";
import type { CrewdayReport } from "@/evals/crewday/report";
import { offlineDeps, parseCrewdayArgs, runCrewday, withCache } from "@/evals/crewday/run";
import { createOfflineSignalAi } from "@/evals/crewday/sim";
import type { SignalAi } from "@/lib/signal/ai/ports";

// Offline (spec 004, task 05): `--cached` replays AI responses keyed by model, prompt hash, and
// input, so a second dev run with unchanged code makes no model calls and gives the same report.

/** Offline ports that count every call reaching them (a "model call" under the cache). */
const counting = (ai: SignalAi) => {
  const calls = { n: 0 };
  const hit =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A) => {
      calls.n += 1;
      return fn(...args);
    };
  const wrapped: SignalAi = {
    embedder: { embed: hit(ai.embedder.embed), model: ai.embedder.model },
    extractor: { extract: hit(ai.extractor.extract) },
    judge: { judge: hit(ai.judge.judge), model: ai.judge.model },
    reasoner: { generate: hit(ai.reasoner.generate) },
    retriever: ai.retriever,
  };
  return { calls, wrapped };
};

describe("--cached flag", () => {
  test("parses, and tagged runs refuse it", () => {
    expect(parseCrewdayArgs(["--cached"]).cached).toBe(true);
    expect(parseCrewdayArgs([]).cached).toBe(false);
    expect(() => parseCrewdayArgs(["--world", "test", "--tag", "x", "--cached"])).toThrow(
      /always live/u,
    );
  });
});

describe("AI response cache", () => {
  test("replays judge verdicts onto this run's need ids by candidate position", async () => {
    const cache = new AiResponseCache(null);
    const base = createOfflineSignalAi();
    const { calls, wrapped } = counting(base);
    const ai = cacheSignalAi(wrapped, cache);
    const submission = { body: "Swap shifts from my phone", title: "Shift swaps" };
    const statements = ["Workers need to swap shifts", "Admins need payroll exports"];
    const first = await ai.judge.judge({
      candidates: statements.map((statement, i) => ({ needId: `run1-${i}`, statement })),
      submission,
    });
    const second = await ai.judge.judge({
      candidates: statements.map((statement, i) => ({ needId: `run2-${i}`, statement })),
      submission,
    });
    expect(calls.n).toBe(1);
    expect(cache.stats).toEqual({ hits: 1, misses: 1 });
    expect(second).toEqual(first.map((j) => ({ ...j, needId: j.needId.replace("run1", "run2") })));
  });

  test("keys on the input: a different submission is a miss", async () => {
    const cache = new AiResponseCache(null);
    const ai = cacheSignalAi(createOfflineSignalAi(), cache);
    await ai.extractor.extract({ body: "a", title: "one" });
    await ai.extractor.extract({ body: "a", title: "one" });
    await ai.extractor.extract({ body: "a", title: "two" });
    expect(cache.stats).toEqual({ hits: 1, misses: 2 });
  });

  test("persists to a JSON-lines file that a new cache loads", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "crewday-cache-")), "ai.jsonl");
    const first = new AiResponseCache(file);
    await cacheSignalAi(createOfflineSignalAi(), first).embedder.embed(["hello"]);
    expect((await readFile(file, "utf-8")).trim().split("\n")).toHaveLength(1);
    const second = new AiResponseCache(file);
    expect(second.size).toBe(1);
    const { calls, wrapped } = counting(createOfflineSignalAi());
    await cacheSignalAi(wrapped, second).embedder.embed(["hello"]);
    expect(calls.n).toBe(0);
  });
});

const untimed = (table: CrewdayReport["table"]) =>
  table.filter((row) => !row.key.startsWith("preview_latency"));

describe("a second --cached dev run [pglite]", () => {
  test("makes no model calls and gives an identical report", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crewday-cached-"));
    const cache = new AiResponseCache(null);
    // Every port the run creates, counted: calls that reach them are model calls.
    const made: { n: number }[] = [];
    const track = () => {
      const { calls, wrapped } = counting(createOfflineSignalAi());
      made.push(calls);
      return wrapped;
    };
    const modelCalls = () => made.reduce((sum, calls) => sum + calls.n, 0);
    const deps = withCache(
      { ...offlineDeps(), oracleEmbedder: () => track().embedder, signalAi: track },
      cache,
    );
    const options = (out: string) =>
      parseCrewdayArgs(["--world", "fixture", "--cached", "--out", path.join(dir, out)]);

    const first = await runCrewday(options("first.json"), deps);
    const firstCalls = modelCalls();
    expect(firstCalls).toBeGreaterThan(0);
    expect(first.cache?.misses).toBeGreaterThan(0);

    const second = await runCrewday(options("second.json"), deps);
    expect(modelCalls()).toBe(firstCalls);
    expect(second.cache).toEqual({ hits: expect.any(Number), misses: 0 });
    // Identical except wall-clock timing (preview latency is measured, not replayed).
    expect(untimed(second.table)).toEqual(untimed(first.table));
    // The spend guardrail is not judged on a cached run.
    const spend = second.table.find((row) => row.key === "model_spend_per_signal");
    expect(spend?.criterion?.verdict).toBe("n.a.");
  }, 180_000);
});
