import { describe, expect, test } from "vitest";

import { isCounted } from "@/evals/crewday/checks";
import type { World } from "@/evals/crewday/format";
import { signalKinds } from "@/evals/crewday/format";
import { KEYWORD_FINDABLE_CEILING, keywordFindability } from "@/evals/crewday/generate/leakage";
import { HELD_OUT } from "@/evals/crewday/held-out";
import { loadWorld } from "@/evals/crewday/world";

// Offline: the frozen generated worlds (spec 004, task 02) load through the task-01 loader, pass
// every consistency check, have the planned size and planted cases, keep keyword leakage under
// the ceiling (recomputed here, not trusted from the manifest), and share nothing. This test may
// read the held-out test world because it only checks integrity; it tunes nothing.

const TARGET = 600;

const shared = (a: string[], b: string[]) => a.filter((value) => b.includes(value));

const worlds: [string, World][] = [
  ["dev", await loadWorld("dev", "v1")],
  ["test", await loadWorld("test", "v1", { heldOut: HELD_OUT })],
];

describe.each(worlds)("crewday %s/v1", (_name, world) => {
  test("has the planned size", () => {
    expect(world.signals.length).toBeGreaterThanOrEqual(TARGET * 0.8);
    expect(world.signals.length).toBeLessThanOrEqual(TARGET * 1.2);
    expect(world.personas.length).toBeGreaterThanOrEqual(150);
    expect(world.accounts.length).toBeGreaterThanOrEqual(30);
    expect(world.needs.length).toBeGreaterThanOrEqual(100);
  });

  test("covers every label kind and planted case", () => {
    const kinds = new Set(world.signals.map((s) => s.labels.kind));
    expect([...kinds].toSorted()).toEqual([...signalKinds].toSorted());
    const planted = new Set(world.signals.map((s) => s.planted).filter(Boolean));
    expect([...planted].toSorted()).toEqual(["invalid", "pii", "retry"]);
    expect(world.signals.some((s) => s.actorKind === "agent")).toBe(true);
    const counted = world.signals.filter(isCounted);
    const multi = counted.filter((s) => s.labels.kind === "multi_ask").length / counted.length;
    expect(multi).toBeGreaterThan(0.02);
    const useCase = counted.filter((s) => s.useCase !== null).length / counted.length;
    expect(useCase).toBeGreaterThan(0.55);
  });

  test("keeps keyword leakage at or under the ceiling, as recorded", () => {
    const { share } = keywordFindability(world);
    expect(share).toBeLessThanOrEqual(KEYWORD_FINDABLE_CEILING);
    expect(world.manifest.keywordFindableShare).toBeCloseTo(share, 3);
  });

  test("records its generator and review", () => {
    expect(world.manifest.generator.models.writer).toBeTruthy();
    expect(world.manifest.generator.promptsHash).toBeTruthy();
    expect(Object.keys(world.manifest.generator.seeds).length).toBeGreaterThan(0);
    expect(world.manifest.review?.method).toBeTruthy();
  });
});

test("the dev and test worlds share no needs, accounts, or personas", () => {
  const [dev, testWorld] = worlds.map(([, world]) => world) as [World, World];
  expect(
    shared(
      dev.needs.map((n) => n.key),
      testWorld.needs.map((n) => n.key),
    ),
  ).toEqual([]);
  expect(
    shared(
      dev.accounts.map((a) => a.key),
      testWorld.accounts.map((a) => a.key),
    ),
  ).toEqual([]);
  expect(
    shared(
      dev.personas.map((p) => p.key),
      testWorld.personas.map((p) => p.key),
    ),
  ).toEqual([]);
  expect(
    shared(
      dev.personas.map((p) => p.email),
      testWorld.personas.map((p) => p.email),
    ),
  ).toEqual([]);
});
