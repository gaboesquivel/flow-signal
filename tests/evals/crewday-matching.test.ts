import { describe, expect, test } from "vitest";

import { isCounted } from "@/evals/crewday/checks";
import { trapKinds } from "@/evals/crewday/format";
import { buildMatchingSet, runMatchingComponent } from "@/evals/crewday/matching";
import { parseCrewdayArgs } from "@/evals/crewday/run";
import { loadWorld } from "@/evals/crewday/world";
import { fakeEmbedder, fakeExtractor, fakeJudge } from "@/lib/signal/ai/fakes";

// Offline (spec 004, task 07): the harder matching set built from a Crewday world, run through
// evals/matching's pipeline with fake ports on the fixture world.

const world = await loadWorld("fixture", "v1");

describe("--component matching", () => {
  test("defaults to the acceptance world and its own report", () => {
    expect(parseCrewdayArgs(["--component", "matching"])).toMatchObject({
      component: "matching",
      out: "evals/crewday/results/matching-test.json",
    });
    expect(parseCrewdayArgs(["--component", "matching", "--world", "dev"]).world).toBe("dev");
    expect(() => parseCrewdayArgs(["--component", "matching", "--sweep"])).toThrow(/--sweep/u);
    expect(() => parseCrewdayArgs(["--limit", "5"])).toThrow(/--limit/u);
  });
});

describe("crewday matching set", () => {
  const { cases, catalog, groups } = buildMatchingSet(world);

  test("has one case per counted signal, against the world's needs", () => {
    expect(cases.map((c) => c.id).toSorted()).toEqual(
      world.signals
        .filter(isCounted)
        .map((s) => s.id)
        .toSorted(),
    );
    expect(catalog.map((n) => n.key).toSorted()).toEqual(world.needs.map((n) => n.key).toSorted());
  });

  test("expects only needs that existed when the signal arrived", () => {
    for (const group of groups)
      for (const c of group.cases)
        for (const key of c.expected) expect(group.existing).toContain(key);
    const signal = new Map(world.signals.map((s) => [s.id, s]));
    for (const c of cases) {
      const labels = signal.get(c.id)?.labels;
      if (labels?.existedAtTime) expect(c.expected.length).toBeGreaterThan(0);
    }
    const fresh = cases.filter((c) => c.expected.length === 0);
    expect(fresh.length).toBeGreaterThan(0);
    for (const c of fresh) expect(c.findable).toBeNull();
    // The catalog only grows.
    for (let i = 1; i < groups.length; i += 1)
      expect(groups[i]?.existing.length).toBeGreaterThan(groups[i - 1]?.existing.length ?? 0);
  });

  test("labels every case with its trap kind and keyword findability", () => {
    const traps = new Set(cases.map((c) => c.trap));
    for (const kind of trapKinds) expect(traps).toContain(kind);
    expect(cases.some((c) => c.findable === true)).toBe(true);
    expect(cases.some((c) => c.findable === false)).toBe(true);
  });
});

describe("matching component run", () => {
  test("reports every metric overall, per trap kind, and by findability", async () => {
    const report = await runMatchingComponent(world, {
      grader: { grade: () => Promise.resolve({ issues: [], score: 4 }), model: "fake-grader" },
      log: () => null,
      ports: { embedder: fakeEmbedder(), extractor: fakeExtractor(), judge: fakeJudge() },
    });
    expect(report.cases).toBe(buildMatchingSet(world).cases.length);
    for (const slice of [
      report.overall,
      ...Object.values(report.byTrap),
      ...Object.values(report.byFindable),
    ]) {
      expect(slice).toHaveProperty("precisionAt3");
      expect(slice).toHaveProperty("falseMatchRate");
      expect(slice).toHaveProperty("newNeedRecall");
      expect(slice).toHaveProperty("multiAskDetection");
    }
    expect(Object.keys(report.byTrap).toSorted()).toEqual(["none", ...trapKinds].toSorted());
    expect(report.overall.newNeedRecall).not.toBeNull();
    expect(report.overall.multiAskDetection).not.toBeNull();
    expect(report.rubric).toBe(4);
    expect(report.byFindable.new_need.cases).toBeGreaterThan(0);
  });

  test("a limited smoke run stops after n signals", async () => {
    const report = await runMatchingComponent(world, {
      limit: 7,
      log: () => null,
      ports: { embedder: fakeEmbedder(), extractor: fakeExtractor(), judge: fakeJudge() },
    });
    expect(report.cases).toBe(7);
    expect(report.rubric).toBeNull();
  });
});
