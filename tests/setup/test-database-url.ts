import { statSync } from "node:fs";
import path from "node:path";

/** The shared default test database name in `.env.example`. */
export const SHARED_TEST_DATABASE = "signal_test";

/** True when `root` is a linked git worktree (its `.git` is a file, not a directory). */
export const isLinkedWorktree = (root: string) => {
  try {
    return statSync(path.join(root, ".git")).isFile();
  } catch {
    return false;
  }
};

/**
 * Gives each linked worktree its own test database: a URL naming the shared default
 * `signal_test` becomes `signal_test_<worktree dir>` (lowercase letters, digits, and _, at most 63
 * characters), so parallel worktrees never rebuild each other's schema. Any other name is kept.
 */
export const perWorktreeTestUrl = (databaseUrl: string, root: string, linked: boolean) => {
  if (!linked) return databaseUrl;
  const url = new URL(databaseUrl);
  if (decodeURIComponent(url.pathname.slice(1)) !== SHARED_TEST_DATABASE) return databaseUrl;
  const suffix = path
    .basename(root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  if (!suffix) return databaseUrl;
  url.pathname = `/${`${SHARED_TEST_DATABASE}_${suffix}`.slice(0, 63)}`;
  return url.toString();
};
