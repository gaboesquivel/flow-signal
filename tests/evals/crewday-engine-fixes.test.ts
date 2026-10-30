import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, test } from "vitest";

import type { Need } from "@/evals/crewday/format";
import { labelSlots } from "@/evals/crewday/generate/plan";
import type { Slot } from "@/evals/crewday/generate/plan";
import { offlineDeps, parseCrewdayArgs, runCrewday } from "@/evals/crewday/run";
import { createSimClock } from "@/evals/crewday/sim/clock";
import { createBackground } from "@/evals/crewday/sim/engine";
import { createAiMeter } from "@/evals/crewday/sim/meter";
import type { SimState } from "@/evals/crewday/sim/state";
import { BucketedUsage } from "@/evals/crewday/spend";

// Offline review fixes for spec 004's runner, engine, spend meter, and generator. No models.

const call = (modelId: string) => ({ inputTokens: 1, modelId, outputTokens: 1 });
const tick = () => sleep(0);
/** A gate a task waits on until the test opens it. */
const createGate = () => {
  const state = { open: false };
  return {
    open: () => {
      state.open = true;
    },
    wait: async () => {
      while (!state.open) await tick();
    },
  };
};
const need = (key: string) => ({ inBacklog: false, key }) as unknown as Need;
const slot = (n: number, needKeys: string[]) =>
  ({ at: `2026-01-0${n}T09:00:00.000Z`, intent: "plain", needKeys, slot: n }) as unknown as Slot;

const backgroundState = () => {
  const clock = createSimClock(new Date("2026-01-05T09:00:00Z"));
  const meter = createAiMeter();
  const state = { clock, meter, pending: [] } as unknown as SimState;
  return { clock, meter, state };
};

describe("background generation", () => {
  test("keeps the world time of the submission that scheduled it", async () => {
    const { clock, state } = backgroundState();
    const background = createBackground(state, 8);
    const stamps: Date[] = [];
    const gate = createGate();
    state.pending.push(async () => {
      stamps.push(clock.now());
      await gate.wait();
      stamps.push(clock.now());
    });
    // The submission's own write.
    clock.now();
    await background.start();
    // The engine moves on to the next submission while generation is still running.
    clock.set(new Date("2026-01-05T15:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-01-05T15:00:00.001Z");
    gate.open();
    await background.settle();
    expect(stamps.map((at) => at.toISOString())).toEqual([
      "2026-01-05T09:00:00.002Z",
      "2026-01-05T09:00:00.003Z",
    ]);
    // ...and never shifted the replay's own millisecond counter.
    expect(clock.now().toISOString()).toBe("2026-01-05T15:00:00.002Z");
  });

  test("settle also runs work a background job queued (automatic briefs)", async () => {
    const { meter, state } = backgroundState();
    const background = createBackground(state, 8);
    const ran: string[] = [];
    state.pending.push(async () => {
      ran.push("generation");
      await tick();
      // readiness schedules a brief from inside generation
      state.pending.push(async () => {
        await tick();
        meter.record("reasoner");
        ran.push("brief");
      });
    });
    await background.start();
    await background.settle();
    expect(ran).toEqual(["generation", "brief"]);
    expect(state.pending).toHaveLength(0);
    // Attributed to generation even though the PM phase is set before the next week.
    meter.setPhase("pm");
    expect(meter.count({ phase: "generation" })).toBe(1);
    expect(meter.outsideOperations("pm")).toBe(0);
  });

  test("a failed job fails the run at the next settle, not as an unhandled rejection", async () => {
    const { state } = backgroundState();
    const background = createBackground(state, 8);
    state.pending.push(() => Promise.reject(new Error("boom")));
    await background.start();
    await expect(background.settle()).rejects.toThrow("boom");
  });

  test("model calls overlapping the replay keep their own phase", async () => {
    const { meter, state } = backgroundState();
    const background = createBackground(state, 8);
    state.pending.push(async () => {
      await tick();
      meter.record("reasoner");
    });
    await background.start();
    meter.setPhase("pm");
    meter.record("embedder");
    await background.settle();
    expect(meter.count({ phase: "generation" })).toBe(1);
    expect(meter.outsideOperations("pm")).toBe(1);
  });
});

describe("spend buckets", () => {
  test("a runtime call made during an oracle lookup stays in runtime", async () => {
    const usage = new BucketedUsage();
    const gate = createGate();
    const oracle = usage.within("oracle", async () => {
      await gate.wait();
      usage.record(call("oracle/embedding"));
    });
    // Background generation, concurrently.
    usage.record(call("signal/reasoning"));
    gate.open();
    await oracle;
    expect(usage.calls("runtime").map((c) => c.modelId)).toEqual(["signal/reasoning"]);
    expect(usage.calls("oracle").map((c) => c.modelId)).toEqual(["oracle/embedding"]);
  });
});

describe("acceptance-world capability", () => {
  test("runCrewday cannot open the test world without the capability", async () => {
    const options = parseCrewdayArgs(["--world", "test", "--out", "/dev/null"]);
    await expect(runCrewday(options, offlineDeps())).rejects.toThrow(/held out/u);
  });
});

describe("generator labels", () => {
  test("a second ask does not make its need exist (as checkOrderLabels)", () => {
    const labels = labelSlots([slot(1, ["a", "b"]), slot(2, ["b"])], [need("a"), need("b")]);
    expect(labels.get(2)).toMatchObject({ existedAtTime: false, firstOccurrence: false });
    const after = labelSlots([slot(1, ["b"]), slot(2, ["b"])], [need("b")]);
    expect(after.get(2)).toMatchObject({ existedAtTime: true });
  });
});
