import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeStaleHooks } from "./stale-hooks.mjs";

const simpleGitHook = `#!/bin/sh
if [ "$SKIP_SIMPLE_GIT_HOOKS" = "1" ]; then
    exit 0
fi
pnpm run hooks:pre-commit
`;

test("removes simple-git-hooks hooks and keeps the user's own", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stale-hooks-"));
  writeFileSync(path.join(dir, "pre-commit"), simpleGitHook);
  writeFileSync(path.join(dir, "pre-push"), "#!/bin/sh\nnpm test\n");
  writeFileSync(path.join(dir, "pre-commit.sample"), simpleGitHook);

  assert.deepEqual(removeStaleHooks(dir), ["pre-commit"]);
  assert.equal(existsSync(path.join(dir, "pre-commit")), false);
  assert.equal(existsSync(path.join(dir, "pre-push")), true);
  assert.equal(existsSync(path.join(dir, "pre-commit.sample")), true);
});

test("does nothing when no hooks are installed", () => {
  assert.deepEqual(removeStaleHooks(mkdtempSync(path.join(tmpdir(), "stale-hooks-"))), []);
});
