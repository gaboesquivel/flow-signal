import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { offlineDeps, parseCrewdayArgs, runSweep } from "@/evals/crewday/run";
import { DEFAULT_CELL, summarizeSweep, SWEEP_GRID } from "@/evals/crewday/sweep";
import type { SweepCellResult } from "@/evals/crewday/sweep";

// Offline (spec 004, task 05): the behaviour sweep reports every success criterion per grid cell
// and labels how robust each is, including the ones that hold only at the defaults.

const cell = (id: string, verdicts: Record<string, "PASS" | "FAIL" | "n.a.">): SweepCellResult => ({
  cell: { id, overrides: {} },
  criteria: Object.entries(verdicts).map(([name, verdict]) => ({ detail: "", name, verdict })),
  killSignal: null,
});

describe("sweep robustness", () => {
  test("labels each criterion across the grid", () => {
    const summary = summarizeSweep([
      cell("defaults", { a: "PASS", b: "PASS", c: "FAIL", d: "n.a." }),
      cell("pAttach=0.6", { a: "PASS", b: "FAIL", c: "PASS", d: "n.a." }),
      cell("pWrong=0.2", { a: "PASS", b: "PASS", c: "FAIL", d: "n.a." }),
    ]);
    expect(Object.fromEntries(summary.map((s) => [s.name, s.robustness]))).toEqual({
      a: "holds across the grid",
      b: "holds only at the defaults",
      c: "fails at the defaults",
      d: "not measured",
    });
    expect(summary.find((s) => s.name === "b")?.failingCells).toEqual(["pAttach=0.6"]);
  });

  test("the grid starts at the defaults and moves one parameter per cell", () => {
    expect(SWEEP_GRID[0]).toEqual(DEFAULT_CELL);
    for (const c of SWEEP_GRID.slice(1)) expect(Object.keys(c.overrides)).toHaveLength(1);
    expect(new Set(SWEEP_GRID.map((c) => c.id)).size).toBe(SWEEP_GRID.length);
  });

  test("--sweep parses and writes to its own report", () => {
    expect(parseCrewdayArgs(["--sweep"])).toMatchObject({
      out: "evals/crewday/results/sweep.json",
      sweep: true,
    });
  });
});

describe("a sweep run [pglite]", () => {
  test("reports every criterion for each cell", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crewday-sweep-"));
    const out = path.join(dir, "sweep.json");
    const grid = [DEFAULT_CELL, { id: "pAttach=0.6", overrides: { pAttach: 0.6 } }];
    const sweep = await runSweep(
      parseCrewdayArgs(["--world", "fixture", "--sweep", "--out", out]),
      offlineDeps(),
      grid,
    );
    expect(sweep.cells.map((c) => c.cell.id)).toEqual(["defaults", "pAttach=0.6"]);
    const names = sweep.cells[0]?.criteria.map((c) => c.name) ?? [];
    expect(names.length).toBeGreaterThan(5);
    for (const c of sweep.cells) expect(c.criteria.map((x) => x.name)).toEqual(names);
    expect(sweep.robustness.map((r) => r.name)).toEqual(names);
    const written = JSON.parse(await readFile(out, "utf-8")) as { schema: string };
    expect(written.schema).toBe("crewday-sweep@1");
    await expect(readFile(path.join(dir, "sweep", "pAttach=0.6.json"), "utf-8")).resolves.toContain(
      '"pAttach": 0.6',
    );
  }, 180_000);
});
