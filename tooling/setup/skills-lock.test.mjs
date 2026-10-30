import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const lock = JSON.parse(readFileSync(path.join(root, "skills-lock.json"), "utf-8")).skills;

// Flow owns these workflow jobs; a second skill for the same job makes agents pick arbitrarily.
const flowOwned = ["debug", "domain-modeling", "explore", "prototype", "start"];
const overlapping = ["diagnosing-bugs", "research", "tdd"];

test("skills lock carries Flow and no overlapping workflow skills", () => {
  for (const name of flowOwned) assert.equal(lock[name]?.source, "gaboesquivel/flow-skills", name);
  for (const name of overlapping) assert.equal(lock[name], undefined, name);
});

// Checks Git, not the disk: an ignore rule (for example `build`) can drop a skill that still exists locally.
const tracked = new Set(
  execFileSync("git", ["ls-files", ".agents/skills", ".claude"], { cwd: root, encoding: "utf-8" })
    .split("\n")
    .filter(Boolean),
);

test("every locked skill is committed", () => {
  for (const name of Object.keys(lock))
    assert.ok(tracked.has(`.agents/skills/${name}/SKILL.md`), `${name} is not tracked`);
  assert.ok(tracked.has(".claude/skills"), ".claude/skills link is not tracked");
});
