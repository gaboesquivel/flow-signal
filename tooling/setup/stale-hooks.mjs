import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// Git hooks this template once installed through simple-git-hooks.
const hookNames = ["pre-commit", "pre-push"];
const marker = "SKIP_SIMPLE_GIT_HOOKS";

/**
 * Removes hooks left by the retired simple-git-hooks setup, so an old clone does not call a
 * missing script. A hook without the simple-git-hooks marker belongs to the user and stays.
 */
export function removeStaleHooks(hooksDir) {
  const removed = [];
  for (const name of hookNames) {
    const file = path.join(hooksDir, name);
    if (!existsSync(file) || !readFileSync(file, "utf-8").includes(marker)) continue;
    rmSync(file);
    removed.push(name);
  }
  return removed;
}
